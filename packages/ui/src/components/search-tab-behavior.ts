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
