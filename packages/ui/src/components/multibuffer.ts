import { tick } from 'svelte';
import { EditorView, keymap } from "@codemirror/view";
import { type EditorState } from "@codemirror/state";
import { getChunks, type MergeView } from "@codemirror/merge";

/**
 * Reusable multibuffer infrastructure (extracted from the Diff Viewer, #300).
 *
 * A multibuffer is a stacked list of per-file CodeMirror views (one section
 * per filepath) with cross-file keyboard navigation, collapse, and
 * active-file sync. The Diff Viewer renders diffs through it; the diagnostics
 * panel (#309), project search, and other diff views share this module.
 * Pure move: behavior is identical to the Diff Viewer originals.
 */

export type MultibufferViewEntry = { inline?: EditorView; split?: MergeView };
export type MultibufferViewMode = 'inline' | 'split';
export type MultibufferPreferSide = 'a' | 'b';

export const MULTIBUFFER_COLLAPSE_CONFIG = { margin: 3, minSize: 4 } as const;

type ViewWaiter = {
	mode: MultibufferViewMode;
	preferSide: MultibufferPreferSide;
	resolve: (view: EditorView | undefined) => void;
};

/**
 * Tracks active EditorView or MergeView per filepath, with mode-keyed
 * waiters so a registration for one mode never resolves a waiter for the
 * other mode during rapid inline<->split switches (issue #81).
 */
export function createViewRegistry() {
	let editorViews = new Map<string, MultibufferViewEntry>();
	let editorResolvers = new Map<string, Array<ViewWaiter>>();

	function pickView(views: MultibufferViewEntry | undefined, mode: MultibufferViewMode, preferSide: MultibufferPreferSide): EditorView | undefined {
		if (mode === 'split') {
			const split = views?.split;
			return preferSide === 'a' ? (split?.a || split?.b) : (split?.b || split?.a);
		}
		return views?.inline;
	}

	function removeWaiter(filepath: string, waiter: ViewWaiter) {
		const list = editorResolvers.get(filepath);
		if (!list) return;
		const idx = list.indexOf(waiter);
		if (idx !== -1) list.splice(idx, 1);
		if (list.length === 0) editorResolvers.delete(filepath);
	}

	// Resolve only waiters whose requested mode now has a matching view.
	// Waiters for other modes stay queued for their own registration.
	function fireReadyResolvers(filepath: string) {
		const list = editorResolvers.get(filepath);
		if (!list || list.length === 0) return;
		const views = editorViews.get(filepath);
		for (const waiter of [...list]) {
			const view = pickView(views, waiter.mode, waiter.preferSide);
			if (view !== undefined) {
				removeWaiter(filepath, waiter);
				waiter.resolve(view);
			}
		}
	}

	// Settle waiters for a view that is being torn down (mode switch or file
	// removal) with undefined so callers skip instead of hanging on the
	// backstop or being resolved by a stale registration. When mode is
	// omitted, all waiters for the filepath are aborted.
	function abortResolvers(filepath: string, mode?: MultibufferViewMode) {
		const list = editorResolvers.get(filepath);
		if (!list || list.length === 0) return;
		for (const waiter of [...list]) {
			if (mode === undefined || waiter.mode === mode) {
				removeWaiter(filepath, waiter);
				waiter.resolve(undefined);
			}
		}
	}

	async function getOrWait(filepath: string, mode: MultibufferViewMode, preferSide: MultibufferPreferSide = 'b'): Promise<EditorView | undefined> {
		const targetView = pickView(editorViews.get(filepath), mode, preferSide);
		if (targetView) return targetView;

		return new Promise<EditorView | undefined>((resolve) => {
			// Last-resort backstop for genuinely slow registrations (view setup
			// awaits async language extensions). Mode-aware paths below settle
			// first in every normal flow.
			const timer = setTimeout(() => {
				removeWaiter(filepath, waiter);
				resolve(pickView(editorViews.get(filepath), mode, preferSide));
			}, 500);

			const waiter: ViewWaiter = {
				mode,
				preferSide,
				resolve: (view) => {
					clearTimeout(timer);
					resolve(view);
				}
			};
			const list = editorResolvers.get(filepath) || [];
			list.push(waiter);
			editorResolvers.set(filepath, list);
		});
	}

	function register(filepath: string, entry: MultibufferViewEntry) {
		const current = editorViews.get(filepath) || {};
		const updated = { ...current, ...entry };
		editorViews.set(filepath, updated);

		fireReadyResolvers(filepath);
	}

	function dropEntry(filepath: string, mode: MultibufferViewMode) {
		const existing = editorViews.get(filepath);
		if (existing) {
			delete existing[mode];
			if (!existing.inline && !existing.split) editorViews.delete(filepath);
		}
		// The view is gone: settle its waiters now instead of
		// leaving them for the backstop or a stale registration.
		abortResolvers(filepath, mode);
	}

	return {
		get: (filepath: string) => editorViews.get(filepath),
		entries: () => editorViews.entries(),
		register,
		getOrWait,
		abort: abortResolvers,
		unregisterInline: (filepath: string) => dropEntry(filepath, 'inline'),
		unregisterSplit: (filepath: string) => dropEntry(filepath, 'split'),
	};
}

export type ViewRegistry = ReturnType<typeof createViewRegistry>;

export function makeGutterClickHandler(
	getView: () => EditorView | undefined,
	getFilepath: () => string,
	openFileAtLine: (filepath: string, lineNumber: number) => void
) {
	return (event: MouseEvent) => {
		const target = event.target as HTMLElement;
		const gutterElement = target.closest('.cm-gutterElement');
		if (gutterElement && gutterElement.closest('.cm-lineNumbers')) {
			const view = getView();
			if (view) {
				const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
				if (pos !== null) {
					const lineNum = view.state.doc.lineAt(pos).number;
					openFileAtLine(getFilepath(), lineNum);
				}
			}
		}
	};
}

export function getBufferBoundaries(state: EditorState): { firstLine: number; lastLine: number } {
	const doc = state.doc;
	const chunkInfo = getChunks(state);
	if (!chunkInfo || chunkInfo.chunks.length === 0) {
		return { firstLine: 1, lastLine: doc.lines };
	}

	const { chunks, side } = chunkInfo;
	const isA = side === 'a';

	// Calculate top boundary (first visible line considering collapsed unchanged lines)
	let firstLine = 1;
	const firstChunk = chunks[0];
	const firstChunkFrom = isA ? firstChunk.fromA : firstChunk.fromB;
	const firstChunkLine = doc.lineAt(Math.min(firstChunkFrom, doc.length)).number;
	const topCollapseTo = firstChunkLine - 1 - MULTIBUFFER_COLLAPSE_CONFIG.margin;
	if (topCollapseTo >= MULTIBUFFER_COLLAPSE_CONFIG.minSize) {
		firstLine = topCollapseTo + 1;
	}

	// Calculate bottom boundary (last visible line considering collapsed unchanged lines)
	let lastLine = doc.lines;
	const lastChunk = chunks[chunks.length - 1];
	const lastChunkTo = Math.min(doc.length, isA ? lastChunk.toA : lastChunk.toB);
	const lastChunkLine = doc.lineAt(lastChunkTo).number;
	const bottomCollapseFrom = lastChunkLine + MULTIBUFFER_COLLAPSE_CONFIG.margin;
	const bottomCollapsedLines = doc.lines - bottomCollapseFrom + 1;
	if (bottomCollapsedLines >= MULTIBUFFER_COLLAPSE_CONFIG.minSize) {
		lastLine = bottomCollapseFrom - 1;
	}

	return { firstLine, lastLine };
}

export function isAtBufferBoundary(view: EditorView, direction: 'down' | 'up'): boolean {
	const sel = view.state.selection.main;
	const doc = view.state.doc;
	const curLine = doc.lineAt(sel.head).number;
	const { firstLine, lastLine } = getBufferBoundaries(view.state);
	return direction === 'up' ? curLine <= firstLine : curLine >= lastLine;
}

export function createFileNavKeymap(options: {
	isAtBoundary: (view: EditorView, direction: 'down' | 'up') => boolean;
	onBoundary: (view: EditorView, direction: 'down' | 'up') => void;
}) {
	return keymap.of([
		{
			key: "ArrowDown",
			run: (v) => {
				if (options.isAtBoundary(v, 'down')) {
					options.onBoundary(v, 'down');
					return true;
				}
				return false;
			}
		},
		{
			key: "ArrowUp",
			run: (v) => {
				if (options.isAtBoundary(v, 'up')) {
					options.onBoundary(v, 'up');
					return true;
				}
				return false;
			}
		}
	]);
}

export async function focusSectionHeader(elementId: string) {
	const header = document.getElementById(elementId);
	if (header) {
		header.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
		if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
		await tick();
		header.focus();
	}
}

export async function focusEditorAtLine(editor: EditorView, targetLineNum: number) {
	const clampedLine = Math.min(Math.max(1, targetLineNum), editor.state.doc.lines);
	const line = editor.state.doc.line(clampedLine);
	editor.dispatch({
		selection: { anchor: line.from, head: line.from },
		effects: EditorView.scrollIntoView(line.from, { y: 'center' })
	});
	if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
	await tick();
	editor.focus();
}

export function focusEditorFirstLine(editor: EditorView) {
	const { firstLine } = getBufferBoundaries(editor.state);
	void focusEditorAtLine(editor, firstLine);
}

export function focusEditorLastLine(editor: EditorView) {
	const { lastLine } = getBufferBoundaries(editor.state);
	void focusEditorAtLine(editor, lastLine);
}

export function cursorSyncExtension(
	getFilepath: () => string,
	onCursorActivity: (filepath: string, view: EditorView) => void
) {
	return EditorView.updateListener.of((update) => {
		if (update.docChanged || update.selectionSet) {
			onCursorActivity(getFilepath(), update.view);
		}
	});
}

// Focus without a selection change still counts as cursor activity.
export function trackCursorFocus(
	view: EditorView,
	getFilepath: () => string,
	onCursorActivity: (filepath: string, view: EditorView) => void
) {
	const onFocusIn = () => onCursorActivity(getFilepath(), view);
	view.dom.addEventListener('focusin', onFocusIn);
	return () => view.dom.removeEventListener('focusin', onFocusIn);
}
