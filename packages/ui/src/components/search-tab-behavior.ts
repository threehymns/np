/**
 * The decisions the project search tab makes about its keyboard, its
 * focus, and what its status line says.
 *
 * They live here, next to the component but outside it, so they can be
 * exercised at runtime. The component only renders what these functions
 * decide, so a test that calls them is a test of what the tab does, not of
 * what its source text says.
 */

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
