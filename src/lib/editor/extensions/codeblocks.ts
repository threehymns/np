import {
	Decoration,
	ViewPlugin,
	ViewUpdate,
	EditorView,
} from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { CopyButtonWidget } from "../widgets/CopyButtonWidget";

class CodeBlockPlugin {
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
					if (node.name === "FencedCode") {
						const fullText = view.state.doc.sliceString(
							node.from,
							node.to,
						);
						const linesArr = fullText.split("\n");
						// Extract content between fences
						const codeToCopy = linesArr.slice(1, -1).join("\n");

						const startLine = view.state.doc.lineAt(
							node.from,
						).number;
						const endLine = view.state.doc.lineAt(
							node.to,
						).number;
						for (let i = startLine; i <= endLine; i++) {
							const line = view.state.doc.line(i);
							let cls = "cm-fencedCode";
							if (i === startLine)
								cls += " cm-fencedCode-top";
							if (i === endLine)
								cls += " cm-fencedCode-bottom";
							if (i > startLine && i < endLine)
								cls += " cm-fencedCode-line";

							// Line decoration must be added at line.from (start of line)
							builder.add(
								line.from,
								line.from,
								Decoration.line({ class: cls }),
							);

							if (i === startLine) {
								// Widget decoration added at line.to (end of line), which is >= line.from
								builder.add(
									line.to,
									line.to,
									Decoration.widget({
										widget: new CopyButtonWidget(
											codeToCopy,
										),
										side: 1,
									}),
								);
							}
						}
					}
				},
			});
		}
		return builder.finish();
	}
}

export const codeBlockPlugin = ViewPlugin.fromClass(CodeBlockPlugin, {
	decorations: (v) => v.decorations,
});
