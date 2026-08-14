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
	/** True when this change aggregates a staged and an unstaged change for the same filepath. */
	combined?: boolean;
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

/**
 * Synthesize a diff from content already attached to a `GitChange`.
 * Returns null when the change carries no content (i.e. content must be
 * resolved on demand via the adapter).
 */
export function fileDiffFromChange(change: GitChange): FileDiffDetail | null {
	if (change.originalContent === undefined && change.modifiedContent === undefined) {
		return null;
	}
	return {
		originalContent: change.originalContent ?? '',
		modifiedContent: change.modifiedContent ?? '',
		stagedContent: change.stagedContent
	};
}

/**
 * Resolve original, modified, and staged contents into a `FileDiffDetail`
 * based on the requested diff options (staged, unstaged, or combined HEAD-vs-worktree).
 */
export function resolveDiffDetail(
	headContent: string,
	stagedContent: string,
	workdirContent: string,
	options?: { staged?: boolean }
): FileDiffDetail {
	if (options?.staged === true) {
		return {
			originalContent: headContent,
			modifiedContent: stagedContent,
			stagedContent
		};
	}

	if (options?.staged === false) {
		return {
			originalContent: stagedContent,
			modifiedContent: workdirContent,
			stagedContent
		};
	}

	return {
		originalContent: headContent,
		modifiedContent: workdirContent,
		stagedContent
	};
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



