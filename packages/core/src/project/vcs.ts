export type SwitchResult =
	| { status: 'switched' }
	| { status: 'noop' }
	| { status: 'blocked'; reason: 'conflict' | 'worktree'; files: string[] }
	| { status: 'error'; message: string };

export interface VCSStatus {
	isDirty: boolean;
	uncommittedFiles: string[];
}

export interface GitChange {
	filepath: string;
	status: 'M' | 'A' | 'D'; // Modified, Added, Deleted
	additions: number;
	deletions: number;
	diff: string;
	staged: boolean;
	originalContent?: string;
	modifiedContent?: string;
}

export interface GitCommit {
	hash: string;
	author: string;
	message: string;
	date: string;
	files: string[];
}

export interface GroupedChange {
	filepath: string;
	status: 'M' | 'A' | 'D';
	additions: number;
	deletions: number;
	hasStaged: boolean;
	hasUnstaged: boolean;
	changes: GitChange[];
}

export interface VCSAdapter {
	getCurrentBranch(): Promise<string | null>;
	getBranches(): Promise<string[]>;
	getStatus(): Promise<VCSStatus>;
	switchBranch(branchName: string, options?: { dryRun?: boolean }): Promise<SwitchResult>;
	getChanges?(): Promise<GitChange[]>;
	getCommits?(): Promise<GitCommit[]>;
	stageFile?(filepath: string): Promise<void>;
	unstageFile?(filepath: string): Promise<void>;
	discardChanges?(filepath: string): Promise<void>;
	commit?(message: string, options?: { author?: { name: string; email: string }; amend?: boolean }): Promise<void>;
	createBranch?(branchName: string): Promise<void>;
}


