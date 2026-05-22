import type { VCSAdapter, SwitchResult, VCSStatus, FileOrigin } from '@np/core';

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
}
