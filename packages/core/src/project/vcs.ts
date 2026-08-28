import { Text } from '@codemirror/state';
import { Chunk } from '@codemirror/merge';

export type SwitchResult =
	| { status: 'switched' }
	| { status: 'noop' }
	| { status: 'blocked'; reason: 'conflict' | 'worktree' | 'unreadable'; files: string[] }
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

/**
 * Count lines in a string without creating intermediate arrays.
 * Handles trailing newlines properly by excluding trailing empty segment.
 */
export function countLines(text: string): number {
	if (!text) return 0;
	let count = 1;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) {
			// If newline is at the very end of the text, do not count extra empty line
			if (i === text.length - 1) break;
			count++;
		}
	}
	return count;
}

/**
 * Parse unified diff text and compute additions and deletions.
 *
 * Only lines inside hunks (after an `@@` header) are counted: within a hunk every
 * line is prefixed, so `+`/`-` lines always count — including added or deleted
 * lines whose content itself begins with `+` or `-` (e.g. `+++added`, `---gone`),
 * which a naive whole-text scan misreads as `+++`/`---` file headers. Any
 * non-context line (`diff --git`, `index`, `--- a/`, `+++ b/`) ends the
 * current hunk, so headers between files and trailing lines are never counted.
 */
export function countDiffStats(diffText: string): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	if (!diffText) return { additions, deletions };

	let inHunk = false;
	for (const line of diffText.split('\n')) {
		if (line.startsWith('@@')) {
			inHunk = true;
			continue;
		}
		if (!inHunk) continue;
		if (line.startsWith('+')) {
			additions++;
		} else if (line.startsWith('-')) {
			deletions++;
		} else if (line === '' || line.startsWith('\\') || line.startsWith(' ')) {
			// `\ No newline at end of file` markers, empty context lines, and normal context lines are not diff lines.
		} else {
			inHunk = false;
		}
	}
	return { additions, deletions };
}

/**
 * Derives a consistent cache key for a file diff based on its path and staging scope.
 */
export function diffCacheKey(fileChange: { filepath: string; staged?: boolean; combined?: boolean }): string {
	if (fileChange.combined) return `${fileChange.filepath}:combined`;
	if (fileChange.staged !== undefined) return `${fileChange.filepath}:${fileChange.staged ? 'staged' : 'unstaged'}`;
	return fileChange.filepath;
}

export interface HunkCoordinates {
	fromA: number;
	toA: number;
	fromB: number;
	toB: number;
}

function chunkOverlapsUnstaged(chunk: Chunk, unstagedChunks: readonly Chunk[], modText: Text): boolean {
	const startB = modText.lineAt(Math.min(chunk.fromB, modText.length)).number;
	const endB = modText.lineAt(Math.min(chunk.toB, modText.length)).number;
	return unstagedChunks.some((uc) => {
		const ucStartB = modText.lineAt(Math.min(uc.fromB, modText.length)).number;
		const ucEndB = modText.lineAt(Math.min(uc.toB, modText.length)).number;
		if (chunk.fromB === chunk.toB && uc.fromB === uc.toB) {
			return Math.abs(uc.fromB - chunk.fromB) <= 1 || startB === ucStartB;
		}
		return startB <= ucEndB && endB >= ucStartB;
	});
}

export function getUnifiedHunks(origText: Text, modText: Text, stagedText?: Text): HunkCoordinates[] {
	const rawChunks = Chunk.build(origText, modText);
	if (rawChunks.length <= 1) {
		return rawChunks.map(c => ({ fromA: c.fromA, toA: c.toA, fromB: c.fromB, toB: c.toB }));
	}

	const unstagedChunks = stagedText ? Chunk.build(stagedText, modText) : null;

	const merged: HunkCoordinates[] = [];
	let current: HunkCoordinates = {
		fromA: rawChunks[0].fromA,
		toA: rawChunks[0].toA,
		fromB: rawChunks[0].fromB,
		toB: rawChunks[0].toB
	};
	let currentStaged: boolean | null = unstagedChunks
		? !chunkOverlapsUnstaged(rawChunks[0], unstagedChunks, modText)
		: null;

	for (let i = 1; i < rawChunks.length; i++) {
		const next = rawChunks[i];
		const lineGapA = origText.lineAt(Math.min(next.fromA, origText.length)).number - origText.lineAt(Math.min(current.toA, origText.length)).number;
		const lineGapB = modText.lineAt(Math.min(next.fromB, modText.length)).number - modText.lineAt(Math.min(current.toB, modText.length)).number;
		const nextStaged: boolean | null = unstagedChunks
			? !chunkOverlapsUnstaged(next, unstagedChunks, modText)
			: null;

		if (lineGapA <= 3 && lineGapB <= 3 && currentStaged === nextStaged) {
			current.toA = next.toA;
			current.toB = next.toB;
		} else {
			merged.push(current);
			current = {
				fromA: next.fromA,
				toA: next.toA,
				fromB: next.fromB,
				toB: next.toB
			};
			currentStaged = nextStaged;
		}
	}
	merged.push(current);

	return merged;
}

/**
 * Resolves the appropriate `{ staged: boolean }` discard option for a given file path,
 * taking into account its presence in staged and/or unstaged changes and the current context.
 */
export function resolveDiscardOptions(
	filepath: string,
	contextIsStaged: boolean,
	changes?: GitChange[]
): { staged: boolean } {
	if (!changes || changes.length === 0) {
		return { staged: contextIsStaged };
	}
	const fileChanges = changes.filter((c) => c.filepath === filepath);
	if (fileChanges.length === 0) {
		return { staged: contextIsStaged };
	}
	const hasStaged = fileChanges.some((c) => c.staged);
	const hasUnstaged = fileChanges.some((c) => !c.staged);

	if (hasStaged && !hasUnstaged) {
		return { staged: true };
	}
	if (!hasStaged && hasUnstaged) {
		return { staged: false };
	}
	return { staged: contextIsStaged };
}

export interface VCSAdapter {
	detect(rootPath: string): Promise<boolean>;
	getCurrentBranch(): Promise<string | null>;
	getBranches(): Promise<string[]>;
	getStatus(): Promise<VCSStatus>;
	switchBranch(branchName: string, options?: { dryRun?: boolean }): Promise<SwitchResult>;
	getChanges?(): Promise<GitChange[]>;
	getCommits?(): Promise<GitCommit[]>;
	getFileDiff?(filepath: string, options?: { staged?: boolean }): Promise<FileDiffDetail>;
	stageFile?(filepath: string): Promise<void>;
	unstageFile?(filepath: string): Promise<void>;
	discardChanges?(filepath: string, options?: { staged?: boolean }): Promise<void>;
	stageAll?(): Promise<void>;
	unstageAll?(): Promise<void>;
	discardAll?(): Promise<void>;
	commit?(message: string, options?: { author?: { name: string; email: string }; amend?: boolean }): Promise<void>;
	createBranch?(branchName: string): Promise<void>;
	getUserConfig?(): Promise<{ name: string; email: string } | null>;
	updateIndexContent?(filepath: string, content: string): Promise<void>;
	updateFileContent?(filepath: string, content: string): Promise<void>;
}



