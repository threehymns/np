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

export interface HunkRange {
	fromA: number;
	toA: number;
	fromB: number;
	toB: number;
}

export function parseDiffStats(diffText: string): { additions: number; deletions: number } {
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

export function mapGitStatus(x: string, y: string): { stagedStatus?: 'M' | 'A' | 'D'; unstagedStatus?: 'M' | 'D' | 'U' } {
	let stagedStatus: 'M' | 'A' | 'D' | undefined;
	let unstagedStatus: 'M' | 'D' | 'U' | undefined;

	if (x !== ' ' && x !== '?') {
		stagedStatus = x === 'A' ? 'A' : (x === 'D' ? 'D' : 'M');
	}
	if (y !== ' ') {
		unstagedStatus = y === '?' ? 'U' : (y === 'D' ? 'D' : 'M');
	}
	return { stagedStatus, unstagedStatus };
}

function findContentRange(baseText: string, targetText: string, fromPos: number, toPos: number): [number, number] {
	if (targetText === baseText) {
		return [fromPos, toPos];
	}
	const snippet = baseText.slice(fromPos, toPos);
	if (snippet.length > 0) {
		const directIdx = targetText.indexOf(snippet, Math.max(0, fromPos - 100));
		if (directIdx !== -1) {
			return [directIdx, directIdx + snippet.length];
		}
		const fallbackIdx = targetText.indexOf(snippet);
		if (fallbackIdx !== -1) {
			return [fallbackIdx, fallbackIdx + snippet.length];
		}
	}
	const clampedFrom = Math.min(fromPos, targetText.length);
	const clampedTo = Math.min(Math.max(clampedFrom, toPos), targetText.length);
	return [clampedFrom, clampedTo];
}

export function computeHunkModification(
	origContent: string,
	modContent: string,
	stagedContent: string,
	hunk: HunkRange,
	action: 'stage' | 'unstage'
): string {
	if (action === 'stage') {
		const [stagedFrom, stagedTo] = findContentRange(origContent, stagedContent, hunk.fromA, hunk.toA);
		return stagedContent.slice(0, stagedFrom) + modContent.slice(hunk.fromB, hunk.toB) + stagedContent.slice(stagedTo);
	} else {
		const [stagedFrom, stagedTo] = findContentRange(modContent, stagedContent, hunk.fromB, hunk.toB);
		return stagedContent.slice(0, stagedFrom) + origContent.slice(hunk.fromA, hunk.toA) + stagedContent.slice(stagedTo);
	}
}

export function computeHunkDiscard(
	origContent: string,
	modContent: string,
	stagedContent: string,
	hunk: HunkRange
): { newIndexContent?: string; newWorktreeContent?: string } {
	const isUnstaged = modContent !== stagedContent;
	if (isUnstaged) {
		const [stagedFrom, stagedTo] = findContentRange(origContent, stagedContent, hunk.fromA, hunk.toA);
		const stagedSlice = stagedContent.slice(stagedFrom, stagedTo);
		const newWorktreeContent = modContent.slice(0, hunk.fromB) + stagedSlice + modContent.slice(hunk.toB);
		return { newWorktreeContent };
	} else {
		const [stagedFrom, stagedTo] = findContentRange(modContent, stagedContent, hunk.fromB, hunk.toB);
		const origSlice = origContent.slice(hunk.fromA, hunk.toA);
		const newIndexContent = stagedContent.slice(0, stagedFrom) + origSlice + stagedContent.slice(stagedTo);
		const newWorktreeContent = modContent.slice(0, hunk.fromB) + origSlice + modContent.slice(hunk.toB);
		return { newIndexContent, newWorktreeContent };
	}
}

export interface VCSAdapter {
	detect(rootPath: string): Promise<boolean>;
	getCurrentBranch(): Promise<string | null>;
	getBranches(): Promise<string[]>;
	getStatus(): Promise<VCSStatus>;
	switchBranch(branchName: string, options?: { dryRun?: boolean }): Promise<SwitchResult>;
	getChanges?(): Promise<GitChange[]>;
	getCommits?(): Promise<GitCommit[]>;
	stageFile?(filepath: string): Promise<void>;
	unstageFile?(filepath: string): Promise<void>;
	discardChanges?(filepath: string): Promise<void>;
	stageHunk?(change: GitChange, hunk: HunkRange): Promise<void>;
	unstageHunk?(change: GitChange, hunk: HunkRange): Promise<void>;
	discardHunk?(change: GitChange, hunk: HunkRange): Promise<void>;
	commit?(message: string, options?: { author?: { name: string; email: string }; amend?: boolean }): Promise<void>;
	createBranch?(branchName: string): Promise<void>;
	getUserConfig?(): Promise<{ name: string; email: string } | null>;
	updateIndexContent?(filepath: string, content: string): Promise<void>;
	updateFileContent?(filepath: string, content: string): Promise<void>;
}
