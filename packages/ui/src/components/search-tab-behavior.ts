/**
 * The decisions the project search tab makes about the keyboard, the focus,
 * the undo, and what its status line says.
 *
 * They live here, next to the component but outside it, so they can be
 * exercised at runtime. The component only renders what these functions
 * decide, so a test that calls them is a test of what the tab does, not of
 * what its source text says.
 */

/** Why the result set was capped, or undefined when it was not capped. */
export type TruncationReason = 'files' | 'matches' | undefined;

/** The part of a keyboard event the search tab reacts to. */
export interface SearchKeyEvent {
	key: string;
	/** True while an IME composition is active. */
	isComposing?: boolean;
}

/**
 * True when the keystroke should run the search now.
 *
 * Enter confirms the candidate an IME is composing, so it must not start a
 * search on the partial text.
 */
export function shouldRunSearchOnKeydown(event: SearchKeyEvent): boolean {
	return event.key === 'Enter' && !event.isComposing;
}

/**
 * True when the query input should take the focus.
 *
 * The workspace bumps the focus nonce every time the search tab is opened,
 * and the project search tab takes the focus whenever it is the active tab.
 */
export function shouldFocusSearchInput(options: {
	/** How many times the search tab has been opened. */
	focusNonce: number;
	/** The tab that is active right now. */
	activeTabId: string;
	/** The id of the project search tab. */
	searchTabId: string;
}): boolean {
	return options.focusNonce > 0 || options.activeTabId === options.searchTabId;
}

/**
 * True when the next undo in the search tab should undo the whole
 * replace-all operation rather than a single manual edit.
 *
 * A replace-all is one operation across every file it changed, so it is
 * one undo step: the search tab owns it, and undoing it puts every file
 * back. A manual edit made after it is newer, so the editor's own
 * history undoes that one first.
 */
export function shouldUndoReplaceAllOperation(options: {
	/** True when a replace-all operation is waiting to be undone. */
	hasPendingReplaceAll: boolean;
	/** True when a manual edit was made after that operation. */
	manualEditAfterReplaceAll: boolean;
}): boolean {
	return options.hasPendingReplaceAll && !options.manualEditAfterReplaceAll;
}

/**
 * One document as the dirty markers see it.
 *
 * The results are an editor for the files they show, so a replace edits
 * the file's Document and leaves it unsaved until the user saves it. The
 * marker reads the same `Document.isModified` a document tab shows.
 */
export interface DocumentDirtiness {
	/** URI of the file the document holds, or null when it has no file. */
	uri: string | null;
	isModified: boolean;
}

/** True when the document for one file the results show holds unsaved edits. */
export function isResultFileDirty(uri: string, documents: readonly DocumentDirtiness[]): boolean {
	return documents.some((doc) => doc.uri === uri && doc.isModified);
}

/**
 * True when any file the results show holds unsaved edits.
 *
 * The tab keeps the marker for the whole result set: an operation across
 * many files is one change the user has not saved yet, and the tab is
 * where they can see that.
 */
export function hasDirtyResults(
	uris: readonly string[],
	documents: readonly DocumentDirtiness[]
): boolean {
	if (uris.length === 0) return false;
	const dirty = new Set<string>();
	for (const doc of documents) {
		if (doc.isModified && doc.uri !== null) dirty.add(doc.uri);
	}
	return uris.some((uri) => dirty.has(uri));
}

/** The state the search status line reports. */
export interface SearchStatus {
	/** True while a search is running. */
	isSearching: boolean;
	/** The number of matches found so far. */
	totalMatches: number;
	/** The number of files that hold a match. */
	fileCount: number;
	/** True when the query is empty. */
	isQueryEmpty: boolean;
}

/**
 * The text of the search status line: what the search is doing, or what it
 * found.
 */
export function searchStatusText(status: SearchStatus): string {
	if (status.isSearching) {
		if (status.fileCount === 0) return 'Searching...';
		return `Searching... ${countText(status.totalMatches, 'match', 'matches')} across ${countText(status.fileCount, 'file', 'files')}`;
	}
	if (status.isQueryEmpty) return 'Type a query to search';
	if (status.fileCount === 0) return 'No results found';
	return `${countText(status.totalMatches, 'match', 'matches')} across ${countText(status.fileCount, 'file', 'files')}`;
}

/** The cap the result set hit. */
export function truncationCapText(reason: TruncationReason): string {
	return reason === 'files' ? '5,000 files' : '10,000 matches';
}

/**
 * The state the search tab is in when the file snapshot changes.
 */
export interface SnapshotRerunState {
	/** The file-set version of the snapshot the tab last saw. */
	lastSnapshotVersion: number;
	/** The file-set version of the snapshot that just arrived. */
	snapshotVersion: number;
	/**
	 * The content-invalidation generation the tab last saw. Omitted by
	 * callers that only track the file-set version.
	 */
	lastContentVersion?: number;
	/**
	 * The content-invalidation generation that just arrived. Omitted by
	 * callers that only track the file-set version.
	 */
	contentVersion?: number;
	/** The pattern the tab would search for. */
	query: string;
}

/**
 * True when a change of the file snapshot should run the search again.
 *
 * The results describe the files as they were when the search ran, so a
 * snapshot that moved on leaves them describing content the project no
 * longer has: a file edited in a terminal, a branch checked out. A scan that
 * finds the same file set can still have found new file content, which is
 * why the content generation is a re-run signal of its own. A snapshot that
 * moves neither changes nothing about the results, and a search without a
 * pattern has nothing to re-run.
 *
 * The re-run itself uses the session's query and the options that go with
 * it, so the tab never searches for a pattern of its own.
 */
export function shouldRerunSearchOnSnapshotChange(state: SnapshotRerunState): boolean {
	const fileSetChanged = state.snapshotVersion !== state.lastSnapshotVersion;
	const contentChanged =
		state.contentVersion !== undefined &&
		state.lastContentVersion !== undefined &&
		state.contentVersion !== state.lastContentVersion;
	if (!fileSetChanged && !contentChanged) return false;
	if (state.query.trim().length === 0) return false;
	return true;
}

/** "1 match" and "2 matches". */
export function countText(count: number, singular: string, plural: string): string {
	return `${count} ${count === 1 ? singular : plural}`;
}
