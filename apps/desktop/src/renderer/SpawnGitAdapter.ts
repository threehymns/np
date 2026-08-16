import type { VCSAdapter, SwitchResult, VCSStatus, FileOrigin, GitChange, GitCommit, FileDiffDetail } from '@np/core';
import { resolveDiffDetail, countLines } from '@np/core/project/vcs';

export class SpawnGitAdapter implements VCSAdapter {
	// Rename sources reported by git itself (porcelain R entries). Authoritative: the
	// only source that may drive rename reverts during discard.
	private renamedOrigPaths = new Map<string, string>();
	// Content-matched worktree "renames" (heuristic diff baselines only). Never
	// consulted by discardChanges: identical content is not evidence of a rename.
	private heuristicRenameSources = new Map<string, string>();

	constructor(private rootOrigin: FileOrigin) {}

	private async runGit(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
		return await window.electronAPI.gitRun(this.rootOrigin.path, args);
	}

	async detect(rootPath: string): Promise<boolean> {
		const res = await this.runGit(['-C', rootPath, 'rev-parse', '--is-inside-work-tree']);
		return res.code === 0 && res.stdout.trim() === 'true';
	}

	private static readonly PATH_NOT_FOUND_MARKERS = [
		'not in index',
		'does not exist in',
		'does not have an entry in index',
		'exists on disk, but not in',
		'did not match any file(s)'
	];

	private isPathNotFoundError(stderr: string): boolean {
		return SpawnGitAdapter.PATH_NOT_FOUND_MARKERS.some(marker => stderr.includes(marker));
	}

	private async readGitObject(objectSpec: string): Promise<string> {
		const res = await this.runGit(['show', objectSpec]);
		if (res.code === 0) return res.stdout;
		if (this.isPathNotFoundError(res.stderr)) return '';
		throw new Error(res.stderr || `Failed to read git object ${objectSpec}`);
	}

	async getCurrentBranch(): Promise<string | null> {
		const res = await this.runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
		if (res.code !== 0) {
			const symRes = await this.runGit(['symbolic-ref', '--short', 'HEAD']);
			if (symRes.code === 0) {
				return symRes.stdout.trim() || null;
			}
			throw new Error(res.stderr || symRes.stderr || 'Failed to determine current branch');
		}
		const branch = res.stdout.trim();
		return branch === 'HEAD' ? null : branch;
	}

	async getBranches(): Promise<string[]> {
		const res = await this.runGit(['branch', '--format=%(refname:short)']);
		if (res.code !== 0) {
			throw new Error(res.stderr || 'Failed to get branch list');
		}
		return res.stdout.split('\n').map(line => line.trim()).filter(Boolean);
	}

	private parseStatusEntries(stdout: string): Array<{ x: string; y: string; filepath: string; origPath?: string }> {
		const result: Array<{ x: string; y: string; filepath: string; origPath?: string }> = [];
		const entries = stdout.split('\0');
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			if (!entry || entry.length < 3) continue;
			const x = entry[0];
			const y = entry[1];
			const filepath = entry.substring(3);
			let origPath: string | undefined;
			if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
				origPath = entries[++i];
			}
			if (filepath.endsWith('/')) continue;
			result.push({ x, y, filepath, origPath });
		}
		return result;
	}

	async getStatus(): Promise<VCSStatus> {
		const res = await this.runGit(['status', '--porcelain=v1', '-z', '-uall']);
		if (res.code !== 0) {
			throw new Error(res.stderr || 'Failed to get repository status');
		}
		const entries = this.parseStatusEntries(res.stdout);
		const uncommittedFiles = entries.map(e => e.filepath);
		return {
			isDirty: uncommittedFiles.length > 0,
			uncommittedFiles
		};
	}

	async switchBranch(branchName: string, options?: { dryRun?: boolean }): Promise<SwitchResult> {
		const currentBranch = await this.getCurrentBranch();
		if (currentBranch === branchName) {
			return { status: 'noop' };
		}

		const refRes = await this.runGit(['rev-parse', '--verify', branchName]);
		if (refRes.code !== 0) {
			return { status: 'error', message: `Target branch ${branchName} does not exist` };
		}

		const status = await this.getStatus();
		if (status.uncommittedFiles.length > 0) {
			const conflictingFiles: string[] = [];
			for (const filepath of status.uncommittedFiles) {
				const headHashRes = await this.runGit(['rev-parse', `HEAD:${filepath}`]);
				const headOid = headHashRes.code === 0 ? headHashRes.stdout.trim() : null;

				const targetHashRes = await this.runGit(['rev-parse', `${branchName}:${filepath}`]);
				const targetOid = targetHashRes.code === 0 ? targetHashRes.stdout.trim() : null;

				if (headOid !== targetOid) {
					conflictingFiles.push(filepath);
				}
			}

			if (conflictingFiles.length > 0) {
				return { status: 'blocked', reason: 'conflict', files: conflictingFiles };
			}
		}

		if (options?.dryRun) {
			return { status: 'switched' };
		}

		const checkoutRes = await this.runGit(['checkout', branchName]);
		if (checkoutRes.code !== 0) {
			return { status: 'error', message: checkoutRes.stderr || `Failed to checkout branch ${branchName}` };
		}

		return { status: 'switched' };
	}

	async stageFile(filepath: string): Promise<void> {
		const res = await this.runGit(['add', '--', filepath]);
		if (res.code !== 0) {
			throw new Error(res.stderr || `Failed to stage file: ${filepath}`);
		}
	}

	async unstageFile(filepath: string): Promise<void> {
		const res = await this.runGit(['reset', 'HEAD', '--', filepath]);
		if (res.code !== 0) {
			throw new Error(res.stderr || `Failed to unstage file: ${filepath}`);
		}
	}

	private async resolveOrigPath(filepath: string): Promise<string | undefined> {
		const cached = this.renamedOrigPaths.get(filepath);
		if (cached) return cached;
		try {
			const statusRes = await this.runGit(['status', '--porcelain=v1', '-z', '--', filepath]);
			if (statusRes.code === 0 && statusRes.stdout) {
				const entries = this.parseStatusEntries(statusRes.stdout);
				const match = entries.find(e => e.filepath === filepath && e.origPath);
				if (match?.origPath) {
					this.renamedOrigPaths.set(filepath, match.origPath);
					return match.origPath;
				}
			}
		} catch (e) {}
		return undefined;
	}

	private async cleanIfPresent(filepath: string): Promise<void> {
		const cleanRes = await this.runGit(['clean', '-fd', '--', filepath]);
		if (cleanRes.code !== 0) {
			throw new Error(cleanRes.stderr || `Failed to discard changes for ${filepath}`);
		}
	}

	async discardChanges(filepath: string, options?: { staged?: boolean }): Promise<void> {
		if (options?.staged === false) {
			// Unstaged scope: reset only the worktree copy to the index version. This must
			// never unstage or restore a rename source, because the same path may also own a
			// staged rename whose revert belongs to the staged scope only.
			const res = await this.runGit(['restore', '--worktree', '--', filepath]);
			if (res.code !== 0) {
				if (!this.isPathNotFoundError(res.stderr)) {
					throw new Error(res.stderr || `Failed to discard changes for ${filepath}`);
				}
				await this.cleanIfPresent(filepath);
			}
			return;
		}

		const origPath = await this.resolveOrigPath(filepath);
		if (origPath && origPath !== filepath) {
			// Staged rename reported by git itself: revert the whole rename. `checkout HEAD -- newPath`
			// fails because the new path is absent from HEAD, so restore the original path from
			// HEAD in index and worktree and remove the new path, instead of dropping the
			// original tracked file. Content-matched worktree "renames" never reach this branch:
			// identical content is not evidence of a rename, so discarding an untracked file must
			// not restore an unrelated deleted path.
			const resetRes = await this.runGit(['reset', 'HEAD', '--', origPath, filepath]);
			if (resetRes.code !== 0) {
				throw new Error(resetRes.stderr || `Failed to discard changes for ${filepath}`);
			}
			const checkoutRes = await this.runGit(['checkout', 'HEAD', '--', origPath]);
			if (checkoutRes.code !== 0) {
				throw new Error(checkoutRes.stderr || `Failed to discard changes for ${filepath}`);
			}
			await this.cleanIfPresent(filepath);
			return;
		}

		const res = await this.runGit(['checkout', 'HEAD', '--', filepath]);
		if (res.code !== 0) {
			const resetRes = await this.runGit(['reset', 'HEAD', '--', filepath]);
			if (resetRes.code !== 0) {
				// A trailing "did not match" means the path has no index entry (untracked), so
				// proceed to clean instead of failing the discard.
				if (!this.isPathNotFoundError(resetRes.stderr)) {
					throw new Error(resetRes.stderr || `Failed to discard changes for ${filepath}`);
				}
			}
			await this.cleanIfPresent(filepath);
		}
	}

	async stageAll(): Promise<void> {
		const res = await this.runGit(['add', '-A']);
		if (res.code !== 0) {
			throw new Error(res.stderr || 'Failed to stage all changes');
		}
	}

	async unstageAll(): Promise<void> {
		const res = await this.runGit(['restore', '--staged', '.']);
		if (res.code !== 0) {
			throw new Error(res.stderr || 'Failed to unstage all changes');
		}
	}

	async discardAll(): Promise<void> {
		const restoreRes = await this.runGit(['restore', '--staged', '--worktree', '.']);
		if (restoreRes.code !== 0) {
			throw new Error(restoreRes.stderr || 'Failed to discard all changes');
		}
		const cleanRes = await this.runGit(['clean', '-fd', '.']);
		if (cleanRes.code !== 0) {
			throw new Error(cleanRes.stderr || 'Failed to discard all changes');
		}
	}

	async getUserConfig(): Promise<{ name: string; email: string } | null> {
		const nameRes = await this.runGit(['config', 'user.name']);
		const emailRes = await this.runGit(['config', 'user.email']);
		const name = nameRes.code === 0 ? nameRes.stdout.trim() : '';
		const email = emailRes.code === 0 ? emailRes.stdout.trim() : '';
		if (name && email) return { name, email };
		return null;
	}

	async commit(message: string, options?: { author?: { name: string; email: string }; amend?: boolean }): Promise<void> {
		const args = ['commit'];
		if (options?.amend) {
			args.push('--amend');
		}
		args.push('-m', message);
		if (options?.author) {
			args.push(`--author=${options.author.name} <${options.author.email}>`);
		}
		const res = await this.runGit(args);
		if (res.code !== 0) {
			throw new Error(res.stderr || `Git commit failed with code ${res.code}`);
		}
	}

	async createBranch(branchName: string): Promise<void> {
		const res = await this.runGit(['checkout', '-b', branchName]);
		if (res.code !== 0) {
			throw new Error(res.stderr || `Failed to create branch ${branchName}`);
		}
	}

	async getCommits(): Promise<GitCommit[]> {
		const res = await this.runGit(['log', '-n', '50', '--pretty=format:%h|%an <%ae>|%ad|%s', '--date=short']);
		if (res.code !== 0) {
			if (res.stderr.includes('does not have any commits yet') || res.stderr.includes('fatal: bad default revision')) {
				return [];
			}
			throw new Error(res.stderr || 'Failed to retrieve git commit log');
		}
		return res.stdout.split('\n').filter(Boolean).map(line => {
			const [hash, author, date, ...rest] = line.split('|');
			const message = rest.join('|');
			return { hash, author, date, message, files: [] };
		});
	}

	private parseNumstat(output: string): Map<string, { additions: number; deletions: number }> {
		const stats = new Map<string, { additions: number; deletions: number }>();
		if (!output) return stats;
		const lines = output.split('\n').filter(Boolean);
		for (const line of lines) {
			const parts = line.split('\t');
			if (parts.length >= 3) {
				const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0;
				const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0;
				const rawPath = parts.slice(2).join('\t').trim();
				let targetPath = rawPath;
				if (targetPath.includes(' => ')) {
					if (targetPath.includes('{') && targetPath.includes('}')) {
						targetPath = targetPath.replace(/\{.*? => (.*?)\}/, '$1');
					} else {
						const arrowIdx = targetPath.indexOf(' => ');
						targetPath = targetPath.substring(arrowIdx + 4);
					}
				}
				stats.set(targetPath, { additions, deletions });
				stats.set(rawPath, { additions, deletions });
			}
		}
		return stats;
	}

	private static readonly EMPTY_STAT = { additions: 0, deletions: 0 };

	async getChanges(): Promise<GitChange[]> {
		const [statusRes, stagedNumstatRes, unstagedNumstatRes] = await Promise.all([
			this.runGit(['status', '--porcelain=v1', '-z', '-uall']),
			this.runGit(['diff', '--cached', '--numstat']),
			this.runGit(['diff', '--numstat'])
		]);

		if (statusRes.code !== 0) {
			throw new Error(statusRes.stderr || 'Failed to get git status for changes');
		}

		const stagedStats = this.parseNumstat(stagedNumstatRes.stdout);
		const unstagedStats = this.parseNumstat(unstagedNumstatRes.stdout);

		const changes: GitChange[] = [];
		const entries = this.parseStatusEntries(statusRes.stdout);
		this.renamedOrigPaths.clear();
		this.heuristicRenameSources.clear();

		for (const { x, y, filepath, origPath } of entries) {
			if (origPath) {
				this.renamedOrigPaths.set(filepath, origPath);
			}

			if (x !== ' ' && x !== '?') {
				const status = x === 'A' ? 'A' : (x === 'D' ? 'D' : 'M');
				const stat = stagedStats.get(filepath) ?? SpawnGitAdapter.EMPTY_STAT;

				changes.push({
					filepath,
					status,
					additions: stat.additions,
					deletions: stat.deletions,
					diff: '',
					staged: true
				});
			}

			if (y !== ' ') {
				const status = y === '?' ? 'U' : (y === 'D' ? 'D' : 'M');

				if (y === '?') {
					// git diff --numstat never includes untracked files, so count lines directly.
					let additions = 0;
					try {
						const buffer = await window.electronAPI.readFile(this.rootOrigin.path + '/' + filepath);
						const content = typeof buffer === 'string' ? buffer : new TextDecoder().decode(buffer);
						additions = countLines(content);
					} catch (e) {}
					changes.push({
						filepath,
						status,
						additions,
						deletions: 0,
						diff: '',
						staged: false
					});
				} else {
					const stat = unstagedStats.get(filepath) ?? SpawnGitAdapter.EMPTY_STAT;

					changes.push({
						filepath,
						status,
						additions: stat.additions,
						deletions: stat.deletions,
						diff: '',
						staged: false
					});
				}
			}
		}

		return changes;
	}

	private async readHeadAndIndex(filepath: string, origPath: string): Promise<{ headContent: string; indexContent: string }> {
		const [headContent, indexContent] = await Promise.all([
			this.readGitObject(`HEAD:${origPath}`),
			this.readGitObject(`:${filepath}`)
		]);
		return {
			headContent,
			indexContent
		};
	}

	// Approximates git's default rename detection threshold (-M50%): content
	// similarity below this is not strong enough to even qualify as a candidate
	// source for the untracked file.
	private static readonly RENAME_CANDIDATE_SIMILARITY_THRESHOLD = 0.5;
	// The top candidate must clear this stronger bar to be accepted as the
	// baseline. Uniqueness alone is not confidence: a lone deleted file that
	// merely shares ~half its lines with the untracked file (e.g. both derived
	// from a template) would otherwise become the baseline, and the resulting
	// diff and hunk coordinates would reference an unrelated file.
	private static readonly RENAME_ACCEPT_SIMILARITY_THRESHOLD = 0.8;

	private static lineSimilarity(a: string, b: string): number {
		if (a === b) return 1;
		const lineCounts = (text: string): Map<string, number> => {
			const counts = new Map<string, number>();
			for (const line of text.split('\n')) {
				counts.set(line, (counts.get(line) ?? 0) + 1);
			}
			return counts;
		};
		const aCounts = lineCounts(a);
		const bCounts = lineCounts(b);
		let shared = 0;
		for (const [line, count] of aCounts) {
			shared += Math.min(count, bCounts.get(line) ?? 0);
		}
		let total = 0;
		for (const count of aCounts.values()) total += count;
		for (const count of bCounts.values()) total += count;
		return (2 * shared) / total;
	}

	private async findWorktreeRenameSource(filepath: string, worktreeContent: string): Promise<string | null> {
		// A rename that exists only in the worktree (e.g. `mv old.txt new.txt` without
		// staging) is reported by porcelain as ` D old.txt` + `?? new.txt` — no `R` entry.
		// Detect it by scoring the untracked file's worktree content against the index
		// content of every file deleted in the worktree. Exact content equality alone is
		// not evidence of a rename, so the best match is accepted only when it is unique
		// AND clears the confidence threshold: a candidate tied at the top score (e.g.
		// unrelated deleted files with identical content) is ambiguous, and a unique
		// candidate that only clears the loose -M50% filter (e.g. an unrelated file
		// sharing half its lines) is too weak. Both cases leave the file genuinely
		// untracked instead of committing to an arbitrary source. A single strongly
		// similar or identical match is kept: it is observationally indistinguishable
		// from a move with light edits, and git's own rename detection reports the
		// same pair as a rename.
		const res = await this.runGit(['ls-files', '--deleted']);
		if (res.code !== 0 || !res.stdout.trim()) return null;
		const deletedPaths = res.stdout.split('\n').map(s => s.trim()).filter(Boolean).filter(p => p !== filepath);
		const candidates = await Promise.all(
			deletedPaths.map(async p => ({ path: p, content: await this.readGitObject(`:${p}`) }))
		);
		const scored = candidates
			.map(c => ({ path: c.path, similarity: SpawnGitAdapter.lineSimilarity(c.content, worktreeContent) }))
			.filter(c => c.similarity >= SpawnGitAdapter.RENAME_CANDIDATE_SIMILARITY_THRESHOLD)
			.sort((a, b) => b.similarity - a.similarity);
		if (scored.length === 0) return null;
		const top = scored[0];
		if (top.similarity < SpawnGitAdapter.RENAME_ACCEPT_SIMILARITY_THRESHOLD) return null;
		if (scored.length === 1) return top.path;
		return top.similarity > scored[1].similarity ? top.path : null;
	}

	async getFileDiff(filepath: string, options?: { staged?: boolean }): Promise<FileDiffDetail> {
		// renamedOrigPaths is populated during getChanges() from porcelain rename entries.
		// If getFileDiff is called directly without a prior getChanges() call, check status on-demand.
		const porcelainOrigPath = await this.resolveOrigPath(filepath);
		let origPath = porcelainOrigPath ?? this.heuristicRenameSources.get(filepath);

		let worktreeContent = '';
		if (options?.staged !== true) {
			try {
				// EAFP: attempt reading worktree content; a deleted/missing file is a genuine empty case
				const buffer = await window.electronAPI.readFile(this.rootOrigin.path + '/' + filepath);
				worktreeContent = typeof buffer === 'string' ? buffer : new TextDecoder().decode(buffer);
			} catch (e) {
				if (!(e instanceof Error) || !e.message.includes('ENOENT')) {
					throw e;
				}
			}
		}

		// Unstaged rename in the worktree: no porcelain R entry exists, so fall back to
		// content matching so the old path becomes the diff baseline instead of an empty one.
		// Matches stay in the heuristic map and never influence discard.
		if (!origPath && options?.staged !== true && worktreeContent) {
			origPath = await this.findWorktreeRenameSource(filepath, worktreeContent) ?? undefined;
			if (origPath) {
				this.heuristicRenameSources.set(filepath, origPath);
			}
		}
		origPath = origPath || filepath;
		const { headContent, indexContent } = await this.readHeadAndIndex(filepath, origPath);

		// Resolve the unstaged baseline from the rename source's index entry. When the
		// file was renamed in the worktree, the new path has no index entry of its own, so
		// the old path's index content is the correct "original" to diff against. Nothing
		// is staged at the new path, so stagedContent stays empty.
		if (origPath !== filepath && options?.staged === false && indexContent === '' && headContent !== '') {
			const sourceIndexContent = await this.readGitObject(`:${origPath}`);
			return {
				originalContent: sourceIndexContent,
				modifiedContent: worktreeContent,
				stagedContent: ''
			};
		}

		return resolveDiffDetail(headContent, indexContent, worktreeContent, options);
	}

	async updateFileContent(filepath: string, content: string): Promise<void> {
		const fullPath = this.rootOrigin.path + '/' + filepath;
		await window.electronAPI.writeFile(fullPath, content);
	}

	async updateIndexContent(filepath: string, content: string): Promise<void> {
		const gitDirRes = await this.runGit(['rev-parse', '--git-dir']);
		const gitDir = gitDirRes.code === 0 && gitDirRes.stdout.trim() ? gitDirRes.stdout.trim() : '.git';
		const resolvedGitDir = gitDir.startsWith('/') ? gitDir : `${this.rootOrigin.path}/${gitDir}`;
		const tmpFilename = `tmp_hunk_stage_${crypto.randomUUID()}`;
		const tmpPath = `${resolvedGitDir}/${tmpFilename}`;
		const relTmpPath = `${gitDir}/${tmpFilename}`;
		try {
			let mode = '100644';
			const lsRes = await this.runGit(['ls-files', '-s', '--', filepath]);
			if (lsRes.code === 0 && lsRes.stdout.trim()) {
				const parts = lsRes.stdout.trim().split(/\s+/);
				if (parts[0] && /^[0-7]+$/.test(parts[0])) {
					mode = parts[0];
				}
			}

			await window.electronAPI.writeFile(tmpPath, content);
			const hashRes = await this.runGit(['hash-object', '-w', relTmpPath]);
			const hash = hashRes.stdout.trim();
			if (hashRes.code === 0 && hash && hash.length === 40) {
				const updateRes = await this.runGit(['update-index', '--cacheinfo', mode, hash, filepath]);
				if (updateRes.code !== 0) {
					throw new Error(updateRes.stderr || 'Failed to update index');
				}
			} else {
				throw new Error(hashRes.stderr || 'Failed to obtain blob hash');
			}
		} finally {
			try {
				await window.electronAPI.deleteEntry(tmpPath);
			} catch (err) {}
		}
	}
}

