import type { VCSAdapter, SwitchResult, VCSStatus, FileOrigin, GitChange, GitCommit } from '@np/core';

export class SpawnGitAdapter implements VCSAdapter {
	constructor(private rootOrigin: FileOrigin) {}

	private async runGit(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
		return await window.electronAPI.gitRun(this.rootOrigin.path, args);
	}

	private async readGitObject(objectSpec: string): Promise<string> {
		const res = await this.runGit(['show', objectSpec]);
		return res.code === 0 ? res.stdout : '';
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

	async discardChanges(filepath: string): Promise<void> {
		const res = await this.runGit(['checkout', 'HEAD', '--', filepath]);
		if (res.code !== 0) {
			await this.runGit(['reset', 'HEAD', '--', filepath]);
			const cleanRes = await this.runGit(['clean', '-fd', '--', filepath]);
			if (cleanRes.code !== 0) {
				throw new Error(cleanRes.stderr || res.stderr || `Failed to discard changes for ${filepath}`);
			}
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

		for (const { x, y, filepath, origPath } of entries) {
			if (x !== ' ' && x !== '?') {
				const status = x === 'A' ? 'A' : (x === 'D' ? 'D' : 'M');
				const stat = stagedStats.get(filepath) ?? SpawnGitAdapter.EMPTY_STAT;

				// Fetch original content (from HEAD)
				let originalContent = '';
				if (status !== 'A') {
					originalContent = await this.readGitObject(`HEAD:${origPath || filepath}`);
				}

				// Fetch modified content (from staged index)
				let modifiedContent = '';
				if (status !== 'D') {
					modifiedContent = await this.readGitObject(`:${filepath}`);
				}

				changes.push({
					filepath,
					status,
					additions: stat.additions,
					deletions: stat.deletions,
					diff: '',
					staged: true,
					originalContent,
					modifiedContent,
					stagedContent: modifiedContent
				});
			}

			if (y !== ' ') {
				const status = y === '?' ? 'U' : (y === 'D' ? 'D' : 'M');

				// Fetch original content (from staged index if staged, else from HEAD)
				let originalContent = '';
				if (y !== '?') {
					originalContent = await this.readGitObject(`:${filepath}`);
					if (!originalContent) {
						originalContent = await this.readGitObject(`HEAD:${origPath || filepath}`);
					}
				}

				// Fetch modified content (from filesystem)
				let modifiedContent = '';
				if (status !== 'D') {
					try {
						const buffer = await window.electronAPI.readFile(this.rootOrigin.path + '/' + filepath);
						modifiedContent = typeof buffer === 'string' ? buffer : new TextDecoder().decode(buffer);
					} catch (e) {}
				}

				let additions = 0;
				let deletions = 0;

				if (y === '?') {
					const lines = modifiedContent ? modifiedContent.split('\n') : [];
					if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
					additions = lines.length;
					deletions = 0;
				} else {
					const stat = unstagedStats.get(filepath) ?? SpawnGitAdapter.EMPTY_STAT;
					additions = stat.additions;
					deletions = stat.deletions;
				}

				changes.push({
					filepath,
					status,
					additions,
					deletions,
					diff: '',
					staged: false,
					originalContent,
					modifiedContent,
					stagedContent: originalContent
				});
			}
		}

		return changes;
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

