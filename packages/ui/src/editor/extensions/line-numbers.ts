/**
 * Note: CodeMirror 6 does not provide a built-in plugin or setting for
 * VS Code / Zed style gutter drag selection. This extension wraps the core
 * `lineNumbers()` extension and implements full-line drag selection and
 * multi-range selection (`Ctrl+drag` / `Cmd+drag`) via `domEventHandlers.mousedown`.
 */

import {
	lineNumbers as cmLineNumbers,
	type BlockInfo,
	EditorView,
} from "@codemirror/view";
import {
	EditorSelection,
	type SelectionRange,
	type Text,
	type Line,
} from "@codemirror/state";

export type LineNumberConfig = Parameters<typeof cmLineNumbers>[0];

/**
 * Returns the line end offset including the trailing newline unless at EOF.
 */
function lineEndWithNewline(doc: Text, line: Line): number {
	return line.to < doc.length ? line.to + 1 : line.to;
}

/**
 * Calculates a selection range covering from startLine to targetLine
 * (whole lines, including the trailing newline when not at EOF).
 */
export function getLineSelectionRange(
	doc: Text,
	startLine: Line,
	targetLine: Line,
): SelectionRange {
	if (targetLine.number >= startLine.number) {
		const anchor = startLine.from;
		const head = lineEndWithNewline(doc, targetLine);
		return EditorSelection.range(anchor, head);
	} else {
		const anchor = lineEndWithNewline(doc, startLine);
		const head = targetLine.from;
		return EditorSelection.range(anchor, head);
	}
}

/**
 * Computes an EditorSelection for gutter line dragging given doc, startLine, targetLine,
 * initial selection ranges, and modifier keys (Ctrl/Cmd, Shift).
 */
export function computeGutterDragSelection(
	doc: Text,
	startLine: Line,
	targetLine: Line,
	options: {
		isMulti?: boolean;
		isShift?: boolean;
		shiftAnchor?: number | null;
		initialRanges?: readonly SelectionRange[];
	} = {},
): EditorSelection {
	const {
		isMulti = false,
		isShift = false,
		shiftAnchor = null,
		initialRanges = [],
	} = options;

	let dragRange: SelectionRange;
	if (isShift && shiftAnchor !== null) {
		const head =
			targetLine.to < shiftAnchor
				? targetLine.from
				: lineEndWithNewline(doc, targetLine);
		dragRange = EditorSelection.range(shiftAnchor, head);
	} else {
		dragRange = getLineSelectionRange(doc, startLine, targetLine);
	}

	if (isMulti) {
		const ranges = [...initialRanges, dragRange];
		return EditorSelection.create(ranges, ranges.length - 1);
	}

	return EditorSelection.create([dragRange]);
}

/**
 * Line numbers gutter extension with VS Code/Zed-style drag-to-select whole lines
 * and Ctrl/Cmd+drag multi-line range selection.
 */
export function lineNumbers(config: LineNumberConfig = {}) {
	return [
		cmLineNumbers({
			...config,
			domEventHandlers: {
				...config.domEventHandlers,
				mousedown(view: EditorView, lineBlock: BlockInfo, event: Event) {
					const mouseEvent = event as MouseEvent;
					if (mouseEvent.button !== 0) {
						return (
							config.domEventHandlers?.mousedown?.(
								view,
								lineBlock,
								event,
							) ?? false
						);
					}

					view.focus();

					const isMulti = mouseEvent.ctrlKey || mouseEvent.metaKey;
					const isShift = mouseEvent.shiftKey && !isMulti;
					const startDoc = view.state.doc;
					const startLine = startDoc.lineAt(lineBlock.from);

					const initialRanges = isMulti ? view.state.selection.ranges : [];
					const shiftAnchor = isShift
						? view.state.selection.main.anchor
						: null;

					const applySelection = (targetLine: Line) => {
						const currentDoc = view.state.doc;
						const selection = computeGutterDragSelection(
							currentDoc,
							startLine,
							targetLine,
							{
								isMulti,
								isShift,
								shiftAnchor,
								initialRanges,
							},
						);
						view.dispatch({ selection, scrollIntoView: true });
					};

					// Apply selection on initial mousedown
					applySelection(startLine);

					if (typeof window === "undefined") {
						return true;
					}

					const cleanup = () => {
						window.removeEventListener("mousemove", onMouseMove);
						window.removeEventListener("mouseup", onMouseUp);
						window.removeEventListener("blur", cleanup);
						window.removeEventListener("contextmenu", cleanup);
					};

					const onMouseMove = (moveEvent: MouseEvent) => {
						if ((moveEvent.buttons & 1) === 0) {
							cleanup();
							return;
						}

						const height = Math.max(
							0,
							Math.min(
								view.contentHeight - 1,
								moveEvent.clientY - view.documentTop,
							),
						);
						const currentBlock = view.lineBlockAtHeight(height);
						const currentLine = view.state.doc.lineAt(currentBlock.from);
						applySelection(currentLine);
					};

					const onMouseUp = () => {
						cleanup();
					};

					window.addEventListener("mousemove", onMouseMove);
					window.addEventListener("mouseup", onMouseUp);
					window.addEventListener("blur", cleanup);
					window.addEventListener("contextmenu", cleanup);

					return true;
				},
			},
		}),
	];
}
