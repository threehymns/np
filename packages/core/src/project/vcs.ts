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
	status: 'M' | 'A' | 'D' | 'U'; // Modified, Added, Deleted, Untracked
	additions: number;
	deletions: number;
	diff: string;
	staged: boolean;
	originalContent?: string;
	modifiedContent?: string;
	stagedContent?: string;
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
	status: 'M' | 'A' | 'D' | 'U';
	additions: number;
	deletions: number;
	hasStaged: boolean;
	hasUnstaged: boolean;
	changes: GitChange[];
}

export interface FileDiffDetail {
	originalContent: string;
	modifiedContent: string;
	stagedContent?: string;
}

export interface VCSAdapter {
	getCurrentBranch(): Promise<string | null>;
	getBranches(): Promise<string[]>;
	getStatus(): Promise<VCSStatus>;
	switchBranch(branchName: string, options?: { dryRun?: boolean }): Promise<SwitchResult>;
	getChanges?(): Promise<GitChange[]>;
	getCommits?(): Promise<GitCommit[]>;
	getFileDiff?(filepath: string, options?: { staged?: boolean }): Promise<FileDiffDetail>;
	stageFile?(filepath: string): Promise<void>;
	unstageFile?(filepath: string): Promise<void>;
	discardChanges?(filepath: string): Promise<void>;
	commit?(message: string, options?: { author?: { name: string; email: string }; amend?: boolean }): Promise<void>;
	createBranch?(branchName: string): Promise<void>;
	getUserConfig?(): Promise<{ name: string; email: string } | null>;
	updateIndexContent?(filepath: string, content: string): Promise<void>;
	updateFileContent?(filepath: string, content: string): Promise<void>;
}



