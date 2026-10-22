/**
 * The DOM focus of a pane.
 *
 * Moving the focus between panes is a command (ADR 0024), and the command
 * runs in the core, which knows nothing about the DOM. The shell knows
 * which editor belongs to which pane, so it publishes the way to focus the
 * active one. The rule lives here, the way the rules of an editor live in
 * `editor-focus.ts`, so that it can be tested without a DOM.
 */

/** The part of an editor view the focus needs. */
export interface FocusableEditor {
	focus(): void;
}

/** The editor views of the panes, filed by pane and tab. */
export type PaneEditorViews = Record<string, FocusableEditor | undefined>;

/** The key a pane's editor view is filed under. */
export function paneEditorKey(paneId: string, tabId: string): string {
	return `${paneId}:${tabId}`;
}

/**
 * Hand the DOM focus to the editor of a pane.
 *
 * A pane with no tab, or a tab that is not an editor, has nothing to
 * focus: the focus stays where it is. The return value says whether there
 * was an editor to focus.
 */
export function focusPaneEditor(
	views: PaneEditorViews,
	pane: { id: string; activeTabId: string } | undefined,
): boolean {
	if (!pane?.activeTabId) return false;
	const view = views[paneEditorKey(pane.id, pane.activeTabId)];
	if (!view) return false;
	view.focus();
	return true;
}
