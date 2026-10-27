import { EditorView } from "@codemirror/view";
import {
	foldCode,
	unfoldCode,
	toggleFold as cmToggleFold,
	foldAll as cmFoldAll,
	unfoldAll as cmUnfoldAll,
	foldEffect,
	unfoldEffect,
	foldable,
	foldedRanges,
	syntaxTree,
} from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

/**
 * Calculates line indentation depth in steps of `tabSize`.
 */
export function getLineIndent(text: string, tabSize = 2): number {
	let spaces = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === " ") spaces++;
		else if (ch === "\t") spaces += tabSize;
		else break;
	}
	return Math.floor(spaces / tabSize);
}

/**
 * Folds the code block at the current selection / cursor (`editor: fold`).
 */
export function fold(view: EditorView): boolean {
	return foldCode(view);
}

/**
 * Unfolds the code block at the current selection / cursor (`editor: unfold lines`).
 */
export function unfold(view: EditorView): boolean {
	return unfoldCode(view);
}

/**
 * Toggles the fold state of the code block at the current cursor (`editor: toggle fold`).
 */
export function toggleFold(view: EditorView): boolean {
	return cmToggleFold(view);
}

/**
 * Folds all foldable regions in the document (`editor: fold all`).
 */
export function foldAll(view: EditorView): boolean {
	return cmFoldAll(view);
}

/**
 * Unfolds all folded regions in the document (`editor: unfold all`).
 */
export function unfoldAll(view: EditorView): boolean {
	return cmUnfoldAll(view);
}

/**
 * Folds the active selected ranges (`editor: fold selected ranges`).
 */
export function foldSelectedRanges(view: EditorView): boolean {
	const effects: any[] = [];
	for (const range of view.state.selection.ranges) {
		if (range.empty) continue;
		const from = range.from;
		const to = range.to;
		if (from < to) {
			effects.push(foldEffect.of({ from, to }));
		}
	}
	if (effects.length > 0) {
		view.dispatch({ effects });
		return true;
	}
	return false;
}

/**
 * Folds all code blocks at a specified indentation level (1-indexed) (`editor: fold at level [1-9]`).
 * Level 1 corresponds to indent level 0 (outermost blocks); level 2 corresponds to 1 indent step, etc.
 */
export function foldAtLevel(view: EditorView, level: number, tabSize = 2): boolean {
	const targetIndent = Math.max(0, level - 1);
	const effects: any[] = [];
	const doc = view.state.doc;

	for (let i = 1; i <= doc.lines; i++) {
		const line = doc.line(i);
		if (line.length === 0) continue;
		const indent = getLineIndent(line.text, tabSize);
		if (indent === targetIndent) {
			const range = foldable(view.state, line.from, line.to);
			if (range) {
				effects.push(foldEffect.of(range));
			}
		}
	}

	if (effects.length > 0) {
		view.dispatch({ effects });
		return true;
	}
	return false;
}

/**
 * Helper to locate the enclosing foldable range around an offset.
 */
function findEnclosingFoldableRange(
	state: EditorState,
	pos: number
): { from: number; to: number } | null {
	let lineNum = state.doc.lineAt(pos).number;
	while (lineNum >= 1) {
		const line = state.doc.line(lineNum);
		const range = foldable(state, line.from, line.to);
		if (range && line.from <= pos && range.to >= pos) {
			return range;
		}
		lineNum--;
	}
	return null;
}

/**
 * Folds the current code block and all its children recursively (`editor: fold recursive`).
 */
export function foldRecursive(view: EditorView): boolean {
	const sel = view.state.selection.main;
	const enclosing = findEnclosingFoldableRange(view.state, sel.from);
	if (!enclosing) return false;

	const effects: any[] = [foldEffect.of(enclosing)];
	const doc = view.state.doc;
	const startLine = doc.lineAt(enclosing.from).number;
	const endLine = doc.lineAt(enclosing.to).number;

	for (let l = startLine + 1; l <= endLine; l++) {
		const line = doc.line(l);
		const range = foldable(view.state, line.from, line.to);
		if (range && range.to <= enclosing.to) {
			effects.push(foldEffect.of(range));
		}
	}

	view.dispatch({ effects });
	return true;
}

/**
 * Unfolds the current code block and all its nested folds recursively (`editor: unfold recursive`).
 */
export function unfoldRecursive(view: EditorView): boolean {
	const sel = view.state.selection.main;
	const enclosing = findEnclosingFoldableRange(view.state, sel.from);
	const bounds = enclosing ?? { from: 0, to: view.state.doc.length };

	const effects: any[] = [];
	foldedRanges(view.state).between(bounds.from, bounds.to, (from, to) => {
		effects.push(unfoldEffect.of({ from, to }));
	});

	if (effects.length > 0) {
		view.dispatch({ effects });
		return true;
	}
	return false;
}

const FUNCTION_NODE_PATTERN =
	/^(FunctionDeclaration|FunctionExpression|ArrowFunction|MethodDeclaration|FunctionDefinition|MethodDefinition|ConstructorDeclaration|Function|Method)$/;

const BODY_NODE_PATTERN = /^(Block|Body|CompoundStatement|ClassBody)$/;

/**
 * Folds all function bodies in the editor (`editor: fold function bodies`).
 */
export function foldFunctionBodies(view: EditorView): boolean {
	const tree = syntaxTree(view.state);
	const effects: any[] = [];

	tree.iterate({
		enter(node) {
			if (FUNCTION_NODE_PATTERN.test(node.name)) {
				// Find body child
				let cursor = node.node.firstChild;
				while (cursor) {
					if (BODY_NODE_PATTERN.test(cursor.name) || cursor.name === "{" || cursor.name === ":") {
						// Found body
						const from = cursor.from;
						const to = cursor.to;
						const startLine = view.state.doc.lineAt(from).number;
						const endLine = view.state.doc.lineAt(to).number;
						if (endLine > startLine) {
							// Check if foldable or fold body
							const range = foldable(view.state, view.state.doc.line(startLine).from, view.state.doc.line(startLine).to);
							if (range) {
								effects.push(foldEffect.of(range));
							} else if (from < to) {
								effects.push(foldEffect.of({ from, to }));
							}
						}
						break;
					}
					cursor = cursor.nextSibling;
				}
			}
		},
	});

	if (effects.length > 0) {
		view.dispatch({ effects });
		return true;
	}
	return false;
}
