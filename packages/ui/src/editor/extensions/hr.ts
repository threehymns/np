import {
	Decoration,
	ViewPlugin,
	ViewUpdate,
	EditorView,
} from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { HorizontalRuleWidget } from "../widgets/HorizontalRuleWidget";
import { closedFrontmatterEnd } from "./frontmatter";

class HorizontalRulePlugin {
	decorations: DecorationSet;
	constructor(view: EditorView) {
		this.decorations = this.getDecorations(view);
	}
	update(update: ViewUpdate) {
		if (
			update.docChanged ||
			update.viewportChanged ||
			update.selectionSet ||
			update.focusChanged
		)
			this.decorations = this.getDecorations(update.view);
	}
	getDecorations(view: EditorView) {
		const builder = new RangeSetBuilder<Decoration>();
		const selection = view.state.selection.main;
		const curLine = view.state.doc.lineAt(selection.from).number;
		const fmEnd = closedFrontmatterEnd(view.state.doc);

		for (let { from, to } of view.visibleRanges) {
			syntaxTree(view.state).iterate({
				from,
				to,
				enter: (node) => {
					if (node.name === "HorizontalRule") {
						const line = view.state.doc.lineAt(node.from);
						// A `---` fence inside a leading frontmatter block is not a
						// real HR; let the frontmatter plugin dim it instead.
						if (fmEnd != null && line.number <= fmEnd) return;
						const isLineActive =
							view.hasFocus && line.number === curLine;

						if (!isLineActive) {
							builder.add(
								line.from,
								line.from,
								Decoration.line({
									class: "cm-hr-line",
								}),
							);
							builder.add(
								line.from,
								line.to,
								Decoration.replace({
									widget: new HorizontalRuleWidget(
										view,
										line.from,
										line.to,
									),
								}),
							);
						} else {
							builder.add(
								line.from,
								line.from,
								Decoration.line({
									class: "cm-horizontal-rule-active",
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

export const horizontalRulePlugin = ViewPlugin.fromClass(HorizontalRulePlugin, {
	decorations: (v) => v.decorations,
});
