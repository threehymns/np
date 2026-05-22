import {
	Decoration,
	ViewPlugin,
	ViewUpdate,
	EditorView,
} from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

class BlockquotePlugin {
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
					if (node.name === "Blockquote") {
						const startLine = view.state.doc.lineAt(
							node.from,
						).number;
						const endLine = view.state.doc.lineAt(
							node.to,
						).number;
						for (let i = startLine; i <= endLine; i++) {
							const line = view.state.doc.line(i);
							builder.add(
								line.from,
								line.from,
								Decoration.line({ class: "cm-blockquote" }),
							);
						}
					}
				},
			});
		}
		return builder.finish();
	}
}

export const blockquotePlugin = ViewPlugin.fromClass(BlockquotePlugin, {
	decorations: (v) => v.decorations,
});
