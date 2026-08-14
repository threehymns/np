import type { FileOrigin } from '../storage';
import { fileDiffFromChange } from './vcs';
import type { VCSAdapter, SwitchResult, GitChange, GitCommit, FileDiffDetail } from './vcs';

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
	changes = $state<GitChange[]>([]);
	commits = $state<GitCommit[]>([]);
	activeDiffFile = $state<GitChange | null>(null);
	selectedPaths = $state<string[]>([]);

	public adapter: VCSAdapter;
	private refreshGeneration = 0;

	constructor(rootOrigin: FileOrigin, vcsFactory: (rootOrigin: FileOrigin) => VCSAdapter) {
		this.adapter = vcsFactory(rootOrigin);
	}

	async getFileDiff(filepath: string, options?: { staged?: boolean }): Promise<FileDiffDetail | null> {
		if (this.adapter.getFileDiff) {
			return await this.adapter.getFileDiff(filepath, options);
		}
		const change = this.changes.find(c => c.filepath === filepath && (options?.staged === undefined || c.staged === options.staged));
		if (!change) {
			return null;
		}
		return fileDiffFromChange(change);
	}


	async refresh(): Promise<boolean> {
		const generation = ++this.refreshGeneration;
		this.isBusy = true;
		try {
			// We use Promise.allSettled to avoid one failing call blocking the other
			const [branchRes, branchesRes, changesRes, commitsRes] = await Promise.allSettled([
				this.adapter.getCurrentBranch(),
				this.adapter.getBranches(),
				this.adapter.getChanges ? this.adapter.getChanges() : Promise.resolve(null),
				this.adapter.getCommits ? this.adapter.getCommits() : Promise.resolve([])
			]);

			if (generation !== this.refreshGeneration) return false;

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

			if (changesRes.status === 'fulfilled' && changesRes.value !== null) {
				this.changes = changesRes.value;
				this.uncommittedFiles = [...new Set(this.changes.map(c => c.filepath))];
				this.isDirty = this.changes.length > 0;
			} else if (changesRes.status === 'fulfilled') {
				const status = await this.adapter.getStatus();
				if (generation !== this.refreshGeneration) return false;
				this.changes = [];
				this.uncommittedFiles = status.uncommittedFiles;
				this.isDirty = status.isDirty;
			} else {
				this.changes = [];
				this.uncommittedFiles = [];
				this.isDirty = false;
			}

			if (commitsRes.status === 'fulfilled') {
				this.commits = commitsRes.value;
			} else {
				this.commits = [];
			}

			// Ensure activeDiffFile points to a valid entry or reset it
			if (this.activeDiffFile) {
				let stillExists = this.changes.find(c => c.filepath === this.activeDiffFile!.filepath && c.staged === this.activeDiffFile!.staged);
				if (!stillExists) {
					stillExists = this.changes.find(c => c.filepath === this.activeDiffFile!.filepath);
				}
				if (!stillExists) {
					this.activeDiffFile = this.changes[0] || null;
				} else {
					this.activeDiffFile = stillExists;
				}
			} else if (this.changes.length > 0) {
				this.activeDiffFile = this.changes[0];
			}

			return success;
		} catch (e) {
			if (generation !== this.refreshGeneration) return false;
			console.error('Failed to refresh repository metadata', e);
			this.currentBranch = null;
			this.branches = [];
			this.changes = [];
			this.commits = [];
			this.uncommittedFiles = [];
			this.isDirty = false;
			this.activeDiffFile = null;
			return false;
		} finally {
			if (generation === this.refreshGeneration) {
				this.isBusy = false;
			}
		}
	}

	async getSafetyReport(activeModifiedFiles: string[], targetBranch: string): Promise<RepositorySafetyReport> {
		this.isBusy = true;
		try {
			if (activeModifiedFiles.length > 0) {
				const status = await this.adapter.getStatus();
				return {
					canSwitch: false,
					unsavedFiles: activeModifiedFiles,
					uncommittedFiles: status.uncommittedFiles
				};
			}

			const res = await this.adapter.switchBranch(targetBranch, { dryRun: true });
			
			if (res.status === 'switched' || res.status === 'noop') {
				return {
					canSwitch: true,
					unsavedFiles: [],
					uncommittedFiles: []
				};
			}

			const uncommittedFiles = res.status === 'blocked' ? res.files : [];
			return {
				canSwitch: false,
				unsavedFiles: [],
				uncommittedFiles
			};
		} finally {
			this.isBusy = false;
		}
	}

	async switchBranch(branchName: string): Promise<SwitchResult> {
		this.isBusy = true;
		try {
			const result = await this.adapter.switchBranch(branchName);
			await this.refresh();
			return result;
		} finally {
			this.isBusy = false;
		}
	}

}



