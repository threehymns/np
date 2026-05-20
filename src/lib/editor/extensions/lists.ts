import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { indentMore, indentLess } from "@codemirror/commands";

// Helper to find all children of a list item
export function getListBlockRange(state: EditorState, pos: number) {
	const line = state.doc.lineAt(pos);
	const match = line.text.match(/^(\s*)/);
	const indent = match ? match[1].length : 0;
	let to = line.to;

	for (let i = line.number + 1; i <= state.doc.lines; i++) {
		const nextLine = state.doc.line(i);
		if (nextLine.text.trim() === "") continue;
		const nextIndent = nextLine.text.match(/^(\s*)/)?.[1].length || 0;
		if (nextIndent > indent) {
			to = nextLine.to;
		} else {
			break;
		}
	}
	return { from: line.from, to };
}

// Helper to renumber all ordered lists in the document
export function renumberLists(view: EditorView) {
	const { state } = view;
	const doc = state.doc;
	const changes: { from: number; to: number; insert: string }[] = [];
	const stack: { indent: number; count: number }[] = [];

	for (let i = 1; i <= doc.lines; i++) {
		const line = doc.line(i);
		const match = line.text.match(/^(\s*)(\d+)\.\s/);

		if (match) {
			const indent = match[1].length;
			const currentNum = parseInt(match[2]);

			// Manage hierarchy stack
			while (
				stack.length > 0 &&
				stack[stack.length - 1].indent > indent
			) {
				stack.pop();
			}

			if (
				stack.length === 0 ||
				stack[stack.length - 1].indent < indent
			) {
				stack.push({ indent, count: 1 });
			} else {
				stack[stack.length - 1].count++;
			}

			const expectedNum = stack[stack.length - 1].count;
			if (currentNum !== expectedNum) {
				const from = line.from + match[1].length;
				const to = from + match[2].length;
				changes.push({ from, to, insert: String(expectedNum) });
			}
		} else if (line.text.trim() === "") {
			continue;
		} else {
			// Non-list line resets stack for this level and deeper
			const indent = line.text.match(/^\s*/)?.[0].length || 0;
			while (
				stack.length > 0 &&
				stack[stack.length - 1].indent >= indent
			) {
				stack.pop();
			}
		}
	}

	if (changes.length > 0) {
		view.dispatch({ changes });
	}
}

export const smartIndent = (direction: "more" | "less") => (view: EditorView) => {
	const { state } = view;
	const selection = state.selection.main;
	const line = state.doc.lineAt(selection.from);

	// Only use smart indent if it looks like a list item
	if (!/^(\s*)([*+-]|\d+\.)\s/.test(line.text)) {
		return direction === "more" ? indentMore(view) : indentLess(view);
	}

	const range = getListBlockRange(state, selection.from);
	const changes: { from: number; to: number; insert: string }[] = [];
	const indentUnit = "  "; // We'll use 2 spaces as the default for now

	for (
		let i = state.doc.lineAt(range.from).number;
		i <= state.doc.lineAt(range.to).number;
		i++
	) {
		const l = state.doc.line(i);
		if (l.text.trim() === "") continue;

		if (direction === "more") {
			changes.push({ from: l.from, to: l.from, insert: indentUnit });
		} else {
			const match = l.text.match(/^(\s+)/);
			if (match && match[1].length >= indentUnit.length) {
				changes.push({
					from: l.from,
					to: l.from + indentUnit.length,
					insert: "",
				});
			}
		}
	}

	if (changes.length > 0) {
		view.dispatch({
			changes,
			// This keeps the cursor relative to the text
			selection: {
				anchor:
					selection.from +
					(direction === "more"
						? indentUnit.length
						: -indentUnit.length),
				head:
					selection.head +
					(direction === "more"
						? indentUnit.length
						: -indentUnit.length),
			},
		});
		setTimeout(() => renumberLists(view), 10);
		return true;
	}

	return false;
};
