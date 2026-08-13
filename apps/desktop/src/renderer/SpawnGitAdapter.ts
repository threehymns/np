import type { VCSAdapter, SwitchResult, VCSStatus, FileOrigin, GitChange, GitCommit } from '@np/core';

export class SpawnGitAdapter implements VCSAdapter {
	constructor(private rootOrigin: FileOrigin) {}

	private async runGit(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
		return await window.electronAPI.gitRun(this.rootOrigin.path, args);
	}

	async getCurrentBranch(): Promise<string | null> {
		const res = await this.runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
		if (res.code !== 0) return null;
		const branch = res.stdout.trim();
		return branch === 'HEAD' ? null : branch;
	}

	async getBranches(): Promise<string[]> {
		const res = await this.runGit(['branch', '--format=%(refname:short)']);
		if (res.code !== 0) return [];
		return res.stdout.split('\n').map(line => line.trim()).filter(Boolean);
	}

	async getStatus(): Promise<VCSStatus> {
		const res = await this.runGit(['status', '--porcelain']);
		if (res.code !== 0) {
			return { isDirty: false, uncommittedFiles: [] };
		}
		const lines = res.stdout.split('\n').filter(Boolean);
		const uncommittedFiles = lines.map(line => {
			let file = line.substring(3).trim();
			if (file.startsWith('"') && file.endsWith('"')) {
				file = file.substring(1, file.length - 1);
			}
			return file;
		});
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
		await this.runGit(['add', '--', filepath]);
	}

	async unstageFile(filepath: string): Promise<void> {
		await this.runGit(['reset', 'HEAD', '--', filepath]);
	}

	async discardChanges(filepath: string): Promise<void> {
		const res = await this.runGit(['checkout', 'HEAD', '--', filepath]);
		if (res.code !== 0) {
			await this.runGit(['reset', 'HEAD', '--', filepath]);
			await this.runGit(['clean', '-fd', '--', filepath]);
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
		await this.runGit(['checkout', '-b', branchName]);
	}

	async getCommits(): Promise<GitCommit[]> {
		const res = await this.runGit(['log', '-n', '50', '--pretty=format:%h|%an <%ae>|%ad|%s', '--date=short']);
		if (res.code !== 0) return [];
		return res.stdout.split('\n').filter(Boolean).map(line => {
			const [hash, author, date, ...rest] = line.split('|');
			const message = rest.join('|');
			return { hash, author, date, message, files: [] };
		});
	}

	private parseDiffStats(diffText: string): { additions: number; deletions: number } {
		let additions = 0;
		let deletions = 0;
		const lines = diffText.split('\n');
		for (const line of lines) {
			if (line.startsWith('+') && !line.startsWith('+++')) {
				additions++;
			} else if (line.startsWith('-') && !line.startsWith('---')) {
				deletions++;
			}
		}
		return { additions, deletions };
	}

	async getChanges(): Promise<GitChange[]> {
		const statusRes = await this.runGit(['status', '--porcelain=v1']);
		if (statusRes.code !== 0) return [];
		const changes: GitChange[] = [];
		const lines = statusRes.stdout.split('\n').filter(Boolean);
		for (const line of lines) {
			const x = line[0];
			const y = line[1];
			const rawPath = line.substring(3).trim();
			const arrowIdx = rawPath.indexOf(' -> ');
			const targetPath = arrowIdx === -1 ? rawPath : rawPath.slice(arrowIdx + 4);
			const filepath = targetPath.trim().replace(/^"(.*)"$/, '$1');

			if (x !== ' ' && x !== '?') {
				const status = x === 'A' ? 'A' : (x === 'D' ? 'D' : 'M');
				const diffRes = await this.runGit(['diff', '--cached', '--', filepath]);
				const { additions, deletions } = this.parseDiffStats(diffRes.stdout);
				
				// Fetch original content (from HEAD)
				const originalRes = await this.runGit(['show', `HEAD:${filepath}`]);
				const originalContent = originalRes.code === 0 ? originalRes.stdout : '';
				
				// Fetch modified content (from staged index)
				const modifiedRes = await this.runGit(['show', `:${filepath}`]);
				const modifiedContent = modifiedRes.code === 0 ? modifiedRes.stdout : '';

				changes.push({
					filepath,
					status,
					additions,
					deletions,
					diff: diffRes.stdout,
					staged: true,
					originalContent,
					modifiedContent,
					stagedContent: modifiedContent
				});
			}
			if (y !== ' ') {
				const status = y === '?' ? 'U' : (y === 'D' ? 'D' : 'M');
				const diffRes = await this.runGit(['diff', '--', filepath]);
				
				// Fetch original content (from staged index if staged, else from HEAD)
				let originalContent = '';
				if (y !== '?') {
					const originalRes = await this.runGit(['show', `:${filepath}`]);
					originalContent = originalRes.code === 0 ? originalRes.stdout : '';
					if (!originalContent) {
						const headRes = await this.runGit(['show', `HEAD:${filepath}`]);
						originalContent = headRes.code === 0 ? headRes.stdout : '';
					}
				}

				// Fetch modified content (from filesystem)
				let modifiedContent = '';
				try {
					const buffer = await window.electronAPI.readFile(this.rootOrigin.path + '/' + filepath);
					modifiedContent = typeof buffer === 'string' ? buffer : new TextDecoder().decode(buffer);
				} catch (e) {}

				let additions = 0;
				let deletions = 0;
				let diffText = diffRes.stdout;

				if (y === '?') {
					const lines = modifiedContent.split('\n');
					if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
					additions = lines.length;
					deletions = 0;
					diffText = `@@ -0,0 +1,${additions} @@\n` + lines.map(l => '+' + l).join('\n');
				} else {
					const stats = this.parseDiffStats(diffText);
					additions = stats.additions;
					deletions = stats.deletions;
				}

				changes.push({
					filepath,
					status,
					additions,
					deletions,
					diff: diffText,
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
		const tmpPath = this.rootOrigin.path + '/.git/tmp_hunk_stage';
		try {
			await window.electronAPI.writeFile(tmpPath, content);
			const hashRes = await this.runGit(['hash-object', '-w', '.git/tmp_hunk_stage']);
			const hash = hashRes.stdout.trim();
			if (hashRes.code === 0 && hash && hash.length === 40) {
				await this.runGit(['update-index', '--cacheinfo', '100644', hash, filepath]);
			} else {
				throw new Error('Failed to obtain blob hash');
			}
		} catch (e) {
			const fullPath = this.rootOrigin.path + '/' + filepath;
			let originalWorktree: string | null = null;
			try {
				const buf = await window.electronAPI.readFile(fullPath);
				originalWorktree = typeof buf === 'string' ? buf : new TextDecoder().decode(buf);
			} catch (err) {}

			await this.updateFileContent(filepath, content);
			await this.stageFile(filepath);

			if (originalWorktree !== null && originalWorktree !== content) {
				await this.updateFileContent(filepath, originalWorktree);
			}
		} finally {
			try {
				await window.electronAPI.deleteEntry(tmpPath);
			} catch (err) {}
		}
	}
}

