import { WidgetType, ViewPlugin, ViewUpdate, Decoration } from "@codemirror/view";
import type { EditorView, DecorationSet } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { keymap } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";

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
	docText: string,
	from: number,
	to: number,
): { from: number; to: number; insert: string } | null {
	const cur = docText.slice(from, to);
	if (cur !== "[ ]" && cur !== "[x]" && cur !== "[X]") return null;
	const insert = cur === "[ ]" ? "[x]" : "[ ]";
	return { from, to, insert };
}

/** Toggle the task at a TaskMarker range via an undoable transaction. */
export function dispatchTaskToggle(view: EditorView, from: number, to: number) {
	const change = taskToggleChange(view.state.doc.toString(), from, to);
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
		if (update.docChanged || update.viewportChanged)
			this.decorations = this.getDecorations(update.view);
	}

	getDecorations(view: EditorView) {
		const builder = new RangeSetBuilder<Decoration>();
		for (let { from, to } of view.visibleRanges) {
			syntaxTree(view.state).iterate({
				from,
				to,
				enter: (node) => {
					if (node.name === "TaskMarker") {
						const text = view.state.doc.sliceString(
							node.from,
							node.to,
						);
						const checked = text.includes("x") || text.includes("X");
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
	while (node && node.name !== "TaskMarker" && node.parent) {
		node = node.parent;
	}
	if (node && node.name === "TaskMarker") {
		return { from: node.from, to: node.to };
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