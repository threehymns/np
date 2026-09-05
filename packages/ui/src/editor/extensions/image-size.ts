import { WidgetType, ViewPlugin, ViewUpdate, Decoration } from "@codemirror/view";
import type { EditorView, DecorationSet } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { parseResizeToken } from "@np/core/links";

/** Non-editing size badge (e.g. `300w`). */
export class SizeBadgeWidget extends WidgetType {
	constructor(readonly width: number) {
		super();
	}
	eq(other: SizeBadgeWidget) {
		return other.width === this.width;
	}
	toDOM() {
		const span = document.createElement("span");
		span.className = "cm-size-badge";
		span.textContent = `${this.width}w`;
		return span;
	}
}

/**
 * Renders a non-editing size badge for sized embeds/images, reusing the shared
 * resize parser. `![[photo.png|300]]` and `![alt|400](photo.png)` get a badge
 * over their numeric size token; marker-hiding collapse is unaffected.
 */
class ImageSizePlugin {
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
		const doc = view.state.doc;

		for (let { from, to } of view.visibleRanges) {
			syntaxTree(view.state).iterate({
				from,
				to,
				enter: (node) => {
					const type = node.name;

					if (type === "WikiLink") {
						const isEmbed =
							doc.sliceString(node.from, node.from + 1) === "!";
						if (!isEmbed) return;
						let target = "";
						let aliasFrom = -1;
						let aliasTo = -1;
						const cursor = node.node.cursor();
						if (cursor.firstChild()) {
							do {
								if (cursor.name === "WikiLinkTarget")
									target = doc.sliceString(cursor.from, cursor.to);
								if (cursor.name === "WikiLinkAlias") {
									aliasFrom = cursor.from;
									aliasTo = cursor.to;
								}
							} while (cursor.nextSibling());
						}
						if (aliasFrom === -1) return;
						const aliasText = doc.sliceString(aliasFrom, aliasTo);
						const res = parseResizeToken(`${target}|${aliasText}`);
						if (!res.size) return;
						// Replace `|300` (the pipe + numeric alias) with the badge.
						builder.add(
							aliasFrom - 1,
							aliasTo,
							Decoration.replace({
								widget: new SizeBadgeWidget(res.size.width),
							}),
						);
						return;
					}

					if (type === "Image") {
						const text = doc.sliceString(node.from, node.to);
						// label sits between `![` and the `](` that precedes the URL
						const labelStart = node.from + 2;
						const labelEndRel = text.indexOf("](");
						if (labelEndRel === -1) return;
						const labelEnd = node.from + labelEndRel;
						const label = doc.sliceString(labelStart, labelEnd);
						const res = parseResizeToken(label);
						if (!res.size) return;
						const pipeIdx = label.indexOf("|");
						if (pipeIdx === -1) return;
						builder.add(
							labelStart + pipeIdx,
							labelEnd,
							Decoration.replace({
								widget: new SizeBadgeWidget(res.size.width),
							}),
						);
					}
				},
			});
		}
		return builder.finish();
	}
}

export const sizeBadgePlugin = ViewPlugin.fromClass(ImageSizePlugin, {
	decorations: (v) => v.decorations,
});