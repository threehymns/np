import type { VCSAdapter } from './vcs';
import { IsomorphicGitAdapter } from './isomorphic-git';

export interface RepositorySafetyReport {
	canSwitch: boolean;
	unsavedFiles: string[];
	uncommittedFiles: string[];
}

export class Repository {
	currentBranch = $state<string | null>(null);
	branches = $state<string[]>([]);
	isDirty = $state(false);
	uncommittedFiles = $state<string[]>([]);
	isBusy = $state(false);

	private adapter: VCSAdapter;

	constructor(rootHandle: FileSystemDirectoryHandle) {
		// For now, we always use the IsomorphicGitAdapter.
		// In an Electron app, this could be injected or switched.
		this.adapter = new IsomorphicGitAdapter(rootHandle);
	}

	async refresh(): Promise<boolean> {
		this.isBusy = true;
		try {
			// We use Promise.allSettled to avoid one failing call blocking the other
			const [branchRes, branchesRes] = await Promise.allSettled([
				this.adapter.getCurrentBranch(),
				this.adapter.getBranches()
			]);

			let success = false;
			if (branchRes.status === 'fulfilled' && branchRes.value !== null) {
				this.currentBranch = branchRes.value;
				success = true;
			} else {
				this.currentBranch = null;
			}

			if (branchesRes.status === 'fulfilled') {
				this.branches = branchesRes.value;
				if (branchesRes.value.length > 0) success = true;
			} else {
				this.branches = [];
			}
			
			// Defer status check as it is very expensive
			this.isDirty = false;
			this.uncommittedFiles = [];
			return success;
		} catch (e) {
			console.error('Failed to refresh repository metadata', e);
			this.currentBranch = null;
			this.branches = [];
			return false;
		} finally {
			this.isBusy = false;
		}
	}

	async getSafetyReport(activeModifiedFiles: string[], targetBranch: string): Promise<RepositorySafetyReport> {
		if (activeModifiedFiles.length > 0) {
			const status = await this.adapter.getStatus();
			return {
				canSwitch: false,
				unsavedFiles: activeModifiedFiles,
				uncommittedFiles: status.uncommittedFiles
			};
		}

		this.isBusy = true;
		try {
			const canCheckout = await this.adapter.canCheckoutBranch(targetBranch);
			
			if (canCheckout) {
				return {
					canSwitch: true,
					unsavedFiles: [],
					uncommittedFiles: []
				};
			}

			// If we can't checkout, find out why by getting the full status
			const status = await this.adapter.getStatus();
			return {
				canSwitch: false,
				unsavedFiles: [],
				uncommittedFiles: status.uncommittedFiles
			};
		} finally {
			this.isBusy = false;
		}
	}

	async switchBranch(branchName: string): Promise<boolean> {
		this.isBusy = true;
		try {
			const success = await this.adapter.switchBranch(branchName);
			await this.refresh();
			return success;
		} finally {
			this.isBusy = false;
		}
	}
}

if (typeof window !== 'undefined') {
	(window as any).Repository = Repository;
}

