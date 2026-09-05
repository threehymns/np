import { Decoration, ViewPlugin, ViewUpdate, EditorView } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

/**
 * Distinct embed styling: `![[….]]` (notes, media placeholders like
 * `![[audio.mp3]]` / `![[video.mp4]]` / `![[document.pdf]]`) get a `cm-embed`
 * mark over their visible target so embeds read differently from normal
 * wikilinks (and never as error styling). Marker hiding and click/Enter
 * navigation are handled elsewhere and are unaffected.
 */
class EmbedPlugin {
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
					if (node.name !== "WikiLink") return;
					if (doc.sliceString(node.from, node.from + 1) !== "!")
						return; // not an embed
					let targetFrom = -1;
					let targetTo = -1;
					const cursor = node.node.cursor();
					if (cursor.firstChild()) {
						do {
							if (cursor.name === "WikiLinkTarget") {
								targetFrom = cursor.from;
								targetTo = cursor.to;
								break;
							}
						} while (cursor.nextSibling());
					}
					if (targetFrom === -1) return;
					builder.add(
						targetFrom,
						targetTo,
						Decoration.mark({ className: "cm-embed" }),
					);
				},
			});
		}
		return builder.finish();
	}
}

export const embedPlugin = ViewPlugin.fromClass(EmbedPlugin, {
	decorations: (v) => v.decorations,
});