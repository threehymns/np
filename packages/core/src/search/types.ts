import type { FileOrigin } from '../storage';
import type { DocumentSession } from '../document.svelte';
import type { Worktree } from '../project/worktree.svelte';

export interface SearchQuery {
	/** Query pattern to search for */
	pattern: string;
	/** Whether the pattern is a regular expression */
	isRegex?: boolean;
	/** Whether the search is case-sensitive */
	caseSensitive?: boolean;
	/** Match whole words only */
	wholeWord?: boolean;
	/** File include globs */
	includeGlobs?: string[] | string;
	/** File exclude globs */
	excludeGlobs?: string[] | string;
}

export interface SearchMatchContextLine {
	line: number;
	text: string;
}

export interface SearchMatch {
	/** 1-based line number of the match */
	line: number;
	/** 1-based column number of the match (start of match) */
	column: number;
	/** 0-based character offset of the match start in the file */
	offset: number;
	/** Length of the match in characters */
	matchLength: number;
	/** The line of text containing the match */
	lineText: string;
	/** Context lines immediately preceding the matching line */
	contextBefore: SearchMatchContextLine[];
	/** Context lines immediately following the matching line */
	contextAfter: SearchMatchContextLine[];
}

export interface FileSearchResult {
	filepath: string;
	origin: FileOrigin;
	matches: SearchMatch[];
}

export interface SearchProgress {
	scannedFiles: number;
	matchedFiles: number;
	totalMatches: number;
	truncated: boolean;
	truncationReason?: 'files' | 'matches';
}

export interface SearchOptions {
	signal?: AbortSignal;
	maxFiles?: number;
	maxMatches?: number;
	contextLines?: number;
	onMatch?: (result: FileSearchResult) => void;
	/**
	 * The live text of a file, when a Document holds it in memory.
	 *
	 * The results are an editor for the files they show, so a file changed
	 * there is unsaved and its text lives in a Document rather than on
	 * disk. A search that read the disk would report the file as it was
	 * before the edit. `undefined` means the file's text is on disk.
	 */
	liveContent?: (origin: FileOrigin) => string | undefined;
}

export interface SearchResultStream extends AsyncIterable<FileSearchResult> {
	readonly progress: SearchProgress;
	cancel(): void;
	all(): Promise<FileSearchResult[]>;
}

export interface SearchBackend {
	search(query: SearchQuery, options?: SearchOptions): SearchResultStream;
	/**
	 * Hand the backend the worktree it reads the file set from. The project
	 * calls it whenever the project root changes, so a backend that holds on
	 * to a worktree can follow the root instead of searching a stale one.
	 */
	attachToWorktree?(worktree: Worktree | null): void;
	/** Release the backend's resources (subscriptions, caches). */
	dispose?(): void;
}

/**
 * A single edit: a range of text replaced by another text.
 */
export interface SingleEdit {
	from: number;
	to: number;
	insert: string;
}

/**
 * One file's share of a replace-all operation.
 */
export interface ReplaceAllFileChange {
	/** The file the operation changed. */
	origin: FileOrigin;
	/**
	 * The content the file held before the operation. The whole content is
	 * put back on undo, because one replace-all is one operation: the edits
	 * it made are not separable from what came after them.
	 */
	before: string;
	/**
	 * The document the change went into. It has a tab when the file was
	 * open, and no tab when it was not: the results are an editor for the
	 * files they show, and a replace never opens a tab.
	 */
	doc: DocumentSession;
}

/**
 * A replace-all operation, kept so it can be undone as one step.
 */
export interface ReplaceAllUndo {
	/** The files the operation changed, in the order it changed them. */
	changes: ReplaceAllFileChange[];
}

/**
 * A replace-all operation waiting to be undone, with what the results held
 * when it ran.
 */
export interface ReplaceAllUndoEntry {
	/** The operation to undo. */
	undo: ReplaceAllUndo;
	/**
	 * How many manual edits the results held when the operation ran. A
	 * manual edit made after it is newer, so it is undone first.
	 */
	manualEdits: number;
}
