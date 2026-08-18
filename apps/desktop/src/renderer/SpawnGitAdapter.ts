import type { VCSAdapter, SwitchResult, VCSStatus, FileOrigin, GitChange, GitCommit, FileDiffDetail } from '@np/core';
import { resolveDiffDetail, countLines } from '@np/core/project/vcs';

export interface GitRunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** A function that runs git in a working directory, returning code + captured output. */
export type GitRunner = (workingDir: string, args: string[]) => Promise<GitRunResult>;

/** File operations the adapter needs beyond git itself: worktree reads and temp-file writes. */
export interface GitFileAccess {
	readFile(path: string): Promise<Uint8Array | string>;
	writeFile(path: string, content: string): Promise<void>;
	deleteEntry(path: string): Promise<void>;
}

const ipcGitRunner: GitRunner = (workingDir, args) => window.electronAPI.gitRun(workingDir, args);

const ipcFileAccess: GitFileAccess = {
	readFile: (path) => window.electronAPI.readFile(path),
	writeFile: (path, content) => window.electronAPI.writeFile(path, content),
	deleteEntry: (path) => window.electronAPI.deleteEntry(path)
};

export class SpawnGitAdapter implements VCSAdapter {
	constructor(
		private rootOrigin: FileOrigin,
		private readonly gitRunner: GitRunner = ipcGitRunner,
		private readonly fileAccess: GitFileAccess = ipcFileAccess
	) {}

	private async runGit(args: string[]): Promise<GitRunResult> {
		return await this.gitRunner(this.rootOrigin.path, args);
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
		'did not match any file(s)',
		'neither on disk nor in the index'
	];

	private isPathNotFoundError(stderr: string): boolean {
		return SpawnGitAdapter.PATH_NOT_FOUND_MARKERS.some(marker => stderr.includes(marker));
	}

	private async readGitObject(objectSpec: string): Promise<string | null> {
		const res = await this.runGit(['show', objectSpec]);
		if (res.code === 0) return res.stdout;
		if (this.isPathNotFoundError(res.stderr)) return null;
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
			if (x === 'R' || y === 'R') {
				origPath = entries[++i];
			} else if (x === 'C' || y === 'C') {
				// Porcelain v1 -z emits the source path as a subsequent NUL token for copies.
				// Consume it to keep token alignment without recording a rename source.
				i++;
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
		const origPath = await this.resolveOrigPath(filepath);
		const paths = origPath && origPath !== filepath ? [origPath, filepath] : [filepath];
		const res = await this.runGit(['reset', 'HEAD', '--', ...paths]);
		if (res.code !== 0) {
			throw new Error(res.stderr || `Failed to unstage file: ${filepath}`);
		}
	}

	private async getRenameEntry(filepath: string): Promise<{ origPath?: string; hasWorktreeEdits: boolean; isCopy: boolean } | null> {
		try {
			const statusRes = await this.runGit(['status', '--porcelain=v1', '-z', '-uall']);
			if (statusRes.code === 0 && statusRes.stdout) {
				const entries = this.parseStatusEntries(statusRes.stdout);
				const match = entries.find(e => e.filepath === filepath && (e.origPath || e.x === 'C' || e.y === 'C'));
				if (match) {
					// Copy entries never record origPath (parseStatusEntries consumes the
					// copy-source token without recording it): copies are not renames, so
					// no source path is returned, only the isCopy flag.
					return {
						origPath: match.origPath,
						hasWorktreeEdits: match.y === 'M',
						isCopy: match.x === 'C' || match.y === 'C'
					};
				}
			}
		} catch (e) {}
		return null;
	}

	private async resolveOrigPath(filepath: string): Promise<string | undefined> {
		const entry = await this.getRenameEntry(filepath);
		return entry?.origPath;
	}

	private async cleanIfPresent(filepath: string): Promise<void> {
		const cleanRes = await this.runGit(['clean', '-fd', '--', filepath]);
		if (cleanRes.code !== 0) {
			throw new Error(cleanRes.stderr || `Failed to discard changes for ${filepath}`);
		}
	}

	async discardChanges(filepath: string, options?: { staged?: boolean }): Promise<void> {
		if (options?.staged === false) {
			// Unstaged scope: reset only the worktree copy to the index version. If the
			// destination path is not in the index (e.g. an unstaged worktree rename),
			// restore the original source path from the index and clean the destination.
			const res = await this.runGit(['restore', '--worktree', '--', filepath]);
			if (res.code !== 0) {
				if (!this.isPathNotFoundError(res.stderr)) {
					throw new Error(res.stderr || `Failed to discard changes for ${filepath}`);
				}
				const origPath = await this.resolveOrigPath(filepath);
				if (origPath && origPath !== filepath) {
					const restoreOrigRes = await this.runGit(['restore', '--worktree', '--', origPath]);
					if (restoreOrigRes.code !== 0) {
						throw new Error(restoreOrigRes.stderr || `Failed to discard changes for ${filepath}`);
					}
				}
				await this.cleanIfPresent(filepath);
			}
			return;
		}

		const renameEntry = await this.getRenameEntry(filepath);
		if (renameEntry?.isCopy) {
			// Staged copy: unstage the destination only — the source file is never
			// touched. `checkout HEAD -- dest` fails because the destination is absent
			// from HEAD, so a plain reset removes the copy from the index. A copy whose
			// destination also holds unstaged edits (CM) keeps its worktree copy after
			// the reset: it is left in place instead of being cleaned away with the
			// user's edits in it.
			const resetRes = await this.runGit(['reset', 'HEAD', '--', filepath]);
			if (resetRes.code !== 0) {
				throw new Error(resetRes.stderr || `Failed to discard changes for ${filepath}`);
			}
			if (!renameEntry.hasWorktreeEdits) {
				await this.cleanIfPresent(filepath);
			}
			return;
		}

		const origPath = renameEntry?.origPath;
		if (origPath && origPath !== filepath) {
			// Staged rename reported by git itself: revert the whole rename. `checkout HEAD -- newPath`
			// fails because the new path is absent from HEAD, so restore the original path from
			// HEAD in index and worktree and remove the new path, instead of dropping the
			// original tracked file.
			const preserveDestination = renameEntry.hasWorktreeEdits;
			const resetRes = await this.runGit(['reset', 'HEAD', '--', origPath, filepath]);
			if (resetRes.code !== 0) {
				throw new Error(resetRes.stderr || `Failed to discard changes for ${filepath}`);
			}
			const checkoutRes = await this.runGit(['checkout', 'HEAD', '--', origPath]);
			if (checkoutRes.code !== 0) {
				throw new Error(checkoutRes.stderr || `Failed to discard changes for ${filepath}`);
			}
			// An RM rename (staged rename plus unstaged edits at the destination) keeps its
			// worktree copy: after the reset it is untracked, so it is left in place instead
			// of being cleaned away with the user's edits in it.
			if (!preserveDestination) {
				await this.cleanIfPresent(filepath);
			}
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
		const res = await this.runGit(['-c', 'core.quotepath=false', 'log', '-n', '50', '--date=short', '--pretty=format:%x00%h|%an <%ae>|%ad|%s', '--name-only', '--no-renames']);
		if (res.code !== 0) {
			if (res.stderr.includes('does not have any commits yet') || res.stderr.includes('fatal: bad default revision')) {
				return [];
			}
			throw new Error(res.stderr || 'Failed to retrieve git commit log');
		}
		// Each block starts with a NUL-prefixed metadata line (hash|author|date|subject)
		// followed by the changed file names, one per line; blocks are separated by
		// the newline ending the previous block and the next block's NUL prefix
		// (file-less commits like merges and empty commits emit no name section).
		return res.stdout.split('\n\0').filter(Boolean).map(block => {
			const lines = block.split('\n');
			const [hash, author, date, ...rest] = lines[0].replace(/^\0/, '').split('|');
			const message = rest.join('|');
			return { hash, author, date, message, files: lines.slice(1).filter(Boolean) };
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

		for (const { x, y, filepath } of entries) {

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
						const buffer = await this.fileAccess.readFile(this.rootOrigin.path + '/' + filepath);
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
		const [headObj, indexObj] = await Promise.all([
			this.readGitObject(`HEAD:${origPath}`),
			this.readGitObject(`:${filepath}`)
		]);

		const headContent = headObj ?? '';
		let indexContent = indexObj;

		if (indexContent === null && origPath !== filepath) {
			const origIndexObj = await this.readGitObject(`:${origPath}`);
			indexContent = origIndexObj ?? headContent;
		}

		return {
			headContent,
			indexContent: indexContent ?? ''
		};
	}

	async getFileDiff(filepath: string, options?: { staged?: boolean }): Promise<FileDiffDetail> {
		const origPath = (await this.resolveOrigPath(filepath)) || filepath;

		let worktreeContent = '';
		if (options?.staged !== true) {
			try {
				// EAFP: attempt reading worktree content; a deleted/missing file is a genuine empty case
				const buffer = await this.fileAccess.readFile(this.rootOrigin.path + '/' + filepath);
				worktreeContent = typeof buffer === 'string' ? buffer : new TextDecoder().decode(buffer);
			} catch (e) {
				if (!(e instanceof Error) || !e.message.includes('ENOENT')) {
					throw e;
				}
			}
		}

		const { headContent, indexContent } = await this.readHeadAndIndex(filepath, origPath);

		return resolveDiffDetail(headContent, indexContent, worktreeContent, options);
	}

	async updateFileContent(filepath: string, content: string): Promise<void> {
		const fullPath = this.rootOrigin.path + '/' + filepath;
		await this.fileAccess.writeFile(fullPath, content);
	}


	/** Index mode of a path (`git ls-files -s`), or null when the path has no index entry. */
	private async indexModeOf(filepath: string): Promise<string | null> {
		const res = await this.runGit(['ls-files', '-s', '--', filepath]);
		if (res.code !== 0 || !res.stdout.trim()) return null;
		const parts = res.stdout.trim().split(/\s+/);
		return parts[0] && /^[0-7]+$/.test(parts[0]) ? parts[0] : null;
	}

	private static readonly DEFAULT_INDEX_MODE = '100644';

	/** Line count of text in unified-diff terms: a trailing newline is not a line. */
	private static textLineCount(text: string): number {
		if (text === '') return 0;
		const newlines = text.match(/\n/g)?.length ?? 0;
		return newlines + (text.endsWith('\n') ? 0 : 1);
	}

	private static hunkRange(count: number): string {
		if (count === 0) return '0,0';
		return count === 1 ? '1' : `1,${count}`;
	}

	private static hunkBody(text: string, prefix: '+' | '-'): string {
		if (text === '') return '';
		const body = text.endsWith('\n') ? text.slice(0, -1) : text;
		// Content of exactly "\n" is one line in unified-diff terms but its body is
		// empty, so emit a lone prefixed line — the same shape git's own diff uses —
		// instead of a hunk whose claimed line count an empty body cannot fulfill
		// (git apply rejects that as corrupt).
		const lines = body === '' ? [prefix] : body.split('\n').map(line => `${prefix}${line}`);
		// A file without a trailing newline needs the no-newline marker, or git
		// apply would silently add one and the index would not hold exact content.
		if (!text.endsWith('\n')) {
			lines.push('\\ No newline at end of file');
		}
		return lines.join('\n');
	}

	/**
	 * Fresh patch rendering for `updateIndexContent`. The patch is applied literally
	 * against the current index for the target filepath only, so it never modifies
	 * or deletes unrelated index paths.
	 */
	private async renderIndexPatch(filepath: string, content: string): Promise<string> {
		const mode = (await this.indexModeOf(filepath)) ?? SpawnGitAdapter.DEFAULT_INDEX_MODE;
		const oldContent = await this.readGitObject(`:${filepath}`);
		const header = `diff --git a/${filepath} b/${filepath}`;
		if (oldContent !== null) {
			// A literal no-op: the index already holds exactly this content, so the
			// write is skipped entirely. An empty→empty replace would render a
			// `+0,0` hunk that `git apply --cached` rejects as corrupt, and no
			// other shape can reach identical content.
			if (oldContent === content) return '';
			// Replace the full index content; the index mode is preserved without headers.
			return [
				header,
				`--- a/${filepath}`,
				`+++ b/${filepath}`,
				`@@ -${SpawnGitAdapter.hunkRange(SpawnGitAdapter.textLineCount(oldContent))} +${SpawnGitAdapter.hunkRange(SpawnGitAdapter.textLineCount(content))} @@`,
				SpawnGitAdapter.hunkBody(oldContent, '-'),
				SpawnGitAdapter.hunkBody(content, '+')
			].join('\n');
		}

		// The destination has no index entry: stage it as a new file. Empty content is
		// emitted without a hunk, which is what `git diff` produces for empty files.
		const parts = [header, `new file mode ${mode}`, '--- /dev/null', `+++ b/${filepath}`];
		const newCount = SpawnGitAdapter.textLineCount(content);
		if (newCount > 0) {
			parts.push(`@@ -0,0 +${SpawnGitAdapter.hunkRange(newCount)} @@`, SpawnGitAdapter.hunkBody(content, '+'));
		}
		return parts.join('\n');
	}

	async updateIndexContent(filepath: string, content: string): Promise<void> {
		const gitDirRes = await this.runGit(['rev-parse', '--git-dir']);
		const gitDir = gitDirRes.code === 0 && gitDirRes.stdout.trim() ? gitDirRes.stdout.trim() : '.git';
		const resolvedGitDir = gitDir.startsWith('/') ? gitDir : `${this.rootOrigin.path}/${gitDir}`;
		const tmpFilename = `tmp_hunk_stage_${crypto.randomUUID()}`;
		const tmpPath = `${resolvedGitDir}/${tmpFilename}`;
		const relTmpPath = `${gitDir}/${tmpFilename}`;
		try {
			// An empty patch means the index already holds exactly the requested
			// content; nothing to apply, and writing the patch file would be pointless.
			const patch = await this.renderIndexPatch(filepath, content);
			if (patch === '') return;
			// git apply rejects a patch file that does not end with a newline, so the
			// rendered patch always gets a trailing newline.
			await this.fileAccess.writeFile(tmpPath, `${patch}\n`);
			const applyRes = await this.runGit(['apply', '--cached', relTmpPath]);
			if (applyRes.code !== 0) {
				throw new Error(applyRes.stderr || 'Failed to update index');
			}
		} finally {
			try {
				await this.fileAccess.deleteEntry(tmpPath);
			} catch (err) {}
		}
	}
}
