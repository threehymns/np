import { EditorView, keymap } from "@codemirror/view";
import { type Extension, StateEffect, StateField } from "@codemirror/state";
import { foldGutter, foldService } from "@codemirror/language";
import {
	fold,
	unfold,
	toggleFold,
	foldAll,
	unfoldAll,
	foldRecursive,
	unfoldRecursive,
	foldFunctionBodies,
	foldSelectedRanges,
	foldAtLevel,
	type DocumentFoldingRange,
	type LspFoldingRange,
} from "@np/core";

export const OPEN_CARET_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 256 256" fill="currentColor"><path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z"/></svg>`;

export const CLOSED_CARET_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 256 256" fill="currentColor"><path d="M181.66,133.66l-80,80A8,8,0,0,1,88,208V48a8,8,0,0,1,13.66-5.66l80,80A8,8,0,0,1,181.66,133.66Z"/></svg>`;

/**
 * Creates custom SVG caret markers matching Phosphor icons for fold/unfold.
 */
export function createFoldMarkerDOM(open: boolean): HTMLElement {
	const span = document.createElement("span");
	span.className = open ? "cm-foldMarker cm-foldMarker-open" : "cm-foldMarker cm-foldMarker-closed";
	span.setAttribute("aria-hidden", "true");
	span.innerHTML = open ? OPEN_CARET_SVG : CLOSED_CARET_SVG;
	return span;
}

/**
 * Creates a themed CodeMirror fold gutter with custom carets and hover reveal.
 */
export function themedFoldGutter(): Extension {
	return foldGutter({
		markerDOM: createFoldMarkerDOM,
	});
}

/**
 * StateEffect to deliver updated document folding ranges to an editor.
 */
export const setDocumentFoldingRangesEffect = StateEffect.define<readonly DocumentFoldingRange[]>();
export const setLspFoldingEffect = setDocumentFoldingRangesEffect;

/**
 * StateField caching the latest document folding ranges for the active document.
 */
export const documentFoldingRangesField = StateField.define<readonly DocumentFoldingRange[]>({
	create: () => [],
	update: (ranges, tr) => {
		for (const effect of tr.effects) {
			if (effect.is(setDocumentFoldingRangesEffect)) {
				return effect.value;
			}
		}
		return ranges;
	},
});
export const lspFoldingField = documentFoldingRangesField;

/**
 * CodeMirror foldService facet provider consulting cached document folding ranges first,
 * falling back to the syntax tree if no range matches.
 */
export const documentFoldingRangeService = foldService.of((state, lineStart, lineEnd) => {
	const ranges = state.field(documentFoldingRangesField, false);
	if (!ranges || ranges.length === 0) return null;

	const startLineNum = state.doc.lineAt(lineStart).number - 1; // 0-based line
	const match = ranges.find((r) => r.startLine === startLineNum);
	if (!match) return null;

	const endLineNum = match.endLine + 1; // 1-based line number in CM
	if (endLineNum <= state.doc.lines) {
		const from = match.startCharacter !== undefined ? lineStart + match.startCharacter : lineEnd;
		const targetLine = state.doc.line(endLineNum);
		const to = match.endCharacter !== undefined ? targetLine.from + match.endCharacter : targetLine.to;
		if (from < to) {
			return { from, to };
		}
	}
	return null;
});
export const lspFoldService = documentFoldingRangeService;

/**
 * Combined extension providing document folding ranges service.
 */
export const documentFoldingRangesExtension: Extension = [
	documentFoldingRangesField,
	documentFoldingRangeService,
];
export const lspFoldingExtension: Extension = documentFoldingRangesExtension;

/**
 * Standard keyboard shortcuts for folding actions.
 */
export const defaultFoldKeymap = keymap.of([
	{ key: "Ctrl-Shift-[", mac: "Cmd-Alt-[", run: fold },
	{ key: "Ctrl-Shift-]", mac: "Cmd-Alt-]", run: unfold },
	{ key: "Ctrl-k Ctrl-0", mac: "Cmd-k Cmd-0", run: foldAll },
	{ key: "Ctrl-k Ctrl-j", mac: "Cmd-k Cmd-j", run: unfoldAll },
	{ key: "Ctrl-k Ctrl-l", mac: "Cmd-k Cmd-l", run: toggleFold },
	{ key: "Ctrl-k Ctrl-1", mac: "Cmd-k Cmd-1", run: (v) => foldAtLevel(v, 1) },
	{ key: "Ctrl-k Ctrl-2", mac: "Cmd-k Cmd-2", run: (v) => foldAtLevel(v, 2) },
	{ key: "Ctrl-k Ctrl-3", mac: "Cmd-k Cmd-3", run: (v) => foldAtLevel(v, 3) },
	{ key: "Ctrl-k Ctrl-4", mac: "Cmd-k Cmd-4", run: (v) => foldAtLevel(v, 4) },
	{ key: "Ctrl-k Ctrl-5", mac: "Cmd-k Cmd-5", run: (v) => foldAtLevel(v, 5) },
	{ key: "Ctrl-k Ctrl-6", mac: "Cmd-k Cmd-6", run: (v) => foldAtLevel(v, 6) },
	{ key: "Ctrl-k Ctrl-7", mac: "Cmd-k Cmd-7", run: (v) => foldAtLevel(v, 7) },
	{ key: "Ctrl-k Ctrl-8", mac: "Cmd-k Cmd-8", run: (v) => foldAtLevel(v, 8) },
	{ key: "Ctrl-k Ctrl-9", mac: "Cmd-k Cmd-9", run: (v) => foldAtLevel(v, 9) },
]);

export {
	fold,
	unfold,
	toggleFold,
	foldAll,
	unfoldAll,
	foldRecursive,
	unfoldRecursive,
	foldFunctionBodies,
	foldSelectedRanges,
	foldAtLevel,
};
