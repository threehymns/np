import { WidgetType, ViewPlugin, ViewUpdate, Decoration } from "@codemirror/view";
import type { EditorView, DecorationSet } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { keymap } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";

import type { SyntaxNode } from "@lezer/common";

/** Helper to find the ListMark and TaskMarker in an enclosing ListItem. */
export function getListItemTaskInfo(listItemNode: SyntaxNode): {
	listMark: { from: number; to: number } | null;
	taskMarker: { from: number; to: number } | null;
} | null {
	let listMark: { from: number; to: number } | null = null;
	let taskMarker: { from: number; to: number } | null = null;

	let child = listItemNode.firstChild;
	while (child) {
		if (child.name === "ListMark") {
			listMark = { from: child.from, to: child.to };
		} else if (child.name === "TaskMarker") {
			taskMarker = { from: child.from, to: child.to };
		} else if (child.name === "Task") {
			let taskChild = child.firstChild;
			while (taskChild) {
				if (taskChild.name === "TaskMarker") {
					taskMarker = { from: taskChild.from, to: taskChild.to };
					break;
				}
				taskChild = taskChild.nextSibling;
			}
		}
		child = child.nextSibling;
	}

	if (!taskMarker) return null;
	return { listMark, taskMarker };
}

/** Checkbox that mirrors the source `[ ]` / `[x]` and toggles it on change. */
export class TaskCheckboxWidget extends WidgetType {
	constructor(
		readonly checked: boolean,
		readonly from: number,
		readonly to: number,
	) {
		super();
	}

	eq(other: TaskCheckboxWidget) {
		return (
			other.checked === this.checked &&
			other.from === this.from &&
			other.to === this.to
		);
	}

	toDOM(view: EditorView) {
		const input = document.createElement("input");
		input.type = "checkbox";
		input.checked = this.checked;
		input.className = "cm-task-checkbox";
		input.addEventListener("change", () => {
			// The source text is the single source of truth; the checkbox flip
			// only splices the source (undoable).
			dispatchTaskToggle(view, this.from, this.to);
		});
		return input;
	}
}

/** Pure replacement needed to toggle a task marker: `[ ]` <-> `[x]`. */
export function taskToggleChange(
	marker: string,
	from: number,
	to: number,
): { from: number; to: number; insert: string } | null {
	const cur = marker;
	if (cur !== "[ ]" && cur !== "[x]" && cur !== "[X]") return null;
	const insert = cur === "[ ]" ? "[x]" : "[ ]";
	return { from, to, insert };
}

/** Toggle the task at a TaskMarker range via an undoable transaction. */
export function dispatchTaskToggle(view: EditorView, from: number, to: number) {
	const change = taskToggleChange(view.state.doc.sliceString(from, to), from, to);
	if (!change) return;
	view.dispatch({
		changes: [change],
		userEvent: "input.toggle",
	});
}

class TaskCheckboxPlugin {
	decorations: DecorationSet;

	constructor(view: EditorView) {
		this.decorations = this.getDecorations(view);
	}

	update(update: ViewUpdate) {
		if (
			update.docChanged ||
			update.selectionSet ||
			update.viewportChanged ||
			update.focusChanged
		)
			this.decorations = this.getDecorations(update.view);
	}

	getDecorations(view: EditorView) {
		const builder = new RangeSetBuilder<Decoration>();
		const selection = view.state.selection;
		for (let { from, to } of view.visibleRanges) {
			syntaxTree(view.state).iterate({
				from,
				to,
				enter: (node) => {
					if (node.name === "TaskMarker") {
						let parent = node.node.parent;
						while (
							parent &&
							parent.name !== "ListItem" &&
							parent.name !== "Document"
						) {
							parent = parent.parent;
						}
						const info =
							parent && parent.name === "ListItem"
								? getListItemTaskInfo(parent)
								: null;
						const syntaxFrom = info?.listMark?.from ?? node.from;
						const syntaxTo = node.to;

						const isCursorInSyntax =
							view.hasFocus &&
							selection.ranges.some(
								(r) =>
									r.from <= syntaxTo && r.to >= syntaxFrom,
							);

						if (!isCursorInSyntax) {
							const text = view.state.doc.sliceString(
								node.from,
								node.to,
							);
							const checked =
								text.includes("x") || text.includes("X");
							builder.add(
								node.from,
								node.to,
								Decoration.replace({
									widget: new TaskCheckboxWidget(
										checked,
										node.from,
										node.to,
									),
								}),
							);
						}
					}
				},
			});
		}
		return builder.finish();
	}
}

export const taskCheckboxPlugin = ViewPlugin.fromClass(TaskCheckboxPlugin, {
	decorations: (v) => v.decorations,
});

/** Find the TaskMarker node enclosing `pos`, if any. */
function findTaskMarker(state: EditorState, pos: number): { from: number; to: number } | null {
	let node: any = syntaxTree(state).resolveInner(pos, -1);
	while (
		node &&
		node.name !== "Task" &&
		node.name !== "ListItem" &&
		node.name !== "TaskMarker" &&
		node.parent &&
		node.name !== "Document"
	) {
		node = node.parent;
	}
	if (node && node.name === "TaskMarker") {
		return { from: node.from, to: node.to };
	}
	if (node) {
		let cursor = node.cursor();
		if (cursor.firstChild()) {
			do {
				if (cursor.name === "TaskMarker") {
					return { from: cursor.from, to: cursor.to };
				}
				if (cursor.name === "Task") {
					let inner = cursor.node.cursor();
					if (inner.firstChild()) {
						do {
							if (inner.name === "TaskMarker") {
								return { from: inner.from, to: inner.to };
							}
						} while (inner.nextSibling());
					}
				}
			} while (cursor.nextSibling());
		}
	}
	return null;
}

/** Toggle the task under the cursor (keyboard command). Returns false off-task. */
export function toggleTaskCommand(view: EditorView): boolean {
	const pos = view.state.selection.main.head;
	const marker = findTaskMarker(view.state, pos);
	if (!marker) return false;
	dispatchTaskToggle(view, marker.from, marker.to);
	return true;
}

export const toggleTaskKeymap = keymap.of([{ key: "Mod-Enter", run: toggleTaskCommand }]);