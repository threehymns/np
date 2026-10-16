import type { FileOrigin } from '../storage';

export interface SearchQuery {
	/** Literal query string to search for */
	pattern: string;
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
}

export interface SearchResultStream extends AsyncIterable<FileSearchResult> {
	readonly progress: SearchProgress;
	cancel(): void;
	all(): Promise<FileSearchResult[]>;
}

export interface SearchBackend {
	search(query: SearchQuery, options?: SearchOptions): SearchResultStream;
}
