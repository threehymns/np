import {
	Decoration,
	ViewPlugin,
	ViewUpdate,
	EditorView,
} from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import type { Text } from "@codemirror/state";

/**
 * Find a properly-closed leading YAML frontmatter block: document starts with
 * `---` and a later line is `---` or `...`. Returns the 1-based end line, or
 * null when there is no closed leading frontmatter (an unclosed leading `---`
 * stays a HorizontalRule, matching the #150 characterization).
 */
export function closedFrontmatterEnd(doc: Text): number | null {
	if (doc.lines < 2) return null;
	if (doc.line(1).text.trim() !== "---") return null;
	for (let l = 2; l <= doc.lines; l++) {
		const t = doc.line(l).text.trim();
		if (t === "---" || t === "...") return l;
	}
	return null;
}

/**
 * Dims a leading YAML frontmatter block as derived Properties metadata. Pure
 * decoration — never rewrites or saves the source. (Unclosed leading `---`
 * stays HR per #150; filed as a gap on #155.)
 */
class FrontmatterPlugin {
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
		const endLine = closedFrontmatterEnd(view.state.doc);
		if (endLine == null) return builder.finish();
		for (let l = 1; l <= endLine; l++) {
			const line = view.state.doc.line(l);
			builder.add(
				line.from,
				line.from,
				Decoration.line({ class: "md-faded" }),
			);
		}
		return builder.finish();
	}
}

export const frontmatterPlugin = ViewPlugin.fromClass(FrontmatterPlugin, {
	decorations: (v) => v.decorations,
});