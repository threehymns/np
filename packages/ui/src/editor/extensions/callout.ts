import {
	Decoration,
	ViewPlugin,
	ViewUpdate,
	EditorView,
} from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

/** Obsidian callout type map: type -> { label, aliases }. */
const CALLOUT_TYPES: Record<string, { label: string; aliases?: string[] }> = {
	note: { label: "note" },
	abstract: { label: "abstract", aliases: ["summary", "tldr"] },
	info: { label: "info" },
	todo: { label: "todo" },
	tip: { label: "tip", aliases: ["hint", "important"] },
	success: { label: "success", aliases: ["check", "done"] },
	question: { label: "question", aliases: ["help", "faq"] },
	warning: { label: "warning", aliases: ["caution", "attention"] },
	danger: { label: "danger", aliases: ["error"] },
	bug: { label: "bug" },
	example: { label: "example" },
	quote: { label: "quote", aliases: ["cite"] },
};

function canonicalType(type: string): string | null {
	const t = type.trim().toLowerCase();
	if (CALLOUT_TYPES[t]) return t;
	for (const [key, val] of Object.entries(CALLOUT_TYPES)) {
		if (val.aliases?.includes(t)) return key;
	}
	return null;
}

/**
 * Base callout rendering: a blockquote whose first line opens with `[!type]`
 * gets a callout accent (per-type class) and a colored type/title label on that
 * line; inner content (bold, lists, links) still parses normally. An unknown
 * type falls back to a plain quote with content intact (no decoration).
 */
class CalloutPlugin {
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
					if (node.name !== "Blockquote") return;
					const firstLine = doc.lineAt(node.from);
					const lineText = firstLine.text;
					// Strip leading `>` (and one space) to reach the marker.
					let li = 0;
					while (li < lineText.length && lineText[li] === ">") {
						li++;
						if (lineText[li] === " ") li++;
					}
					const rest = lineText.slice(li);
					const m = rest.match(/^\[!(\w+)\](.*)$/);
					const type = m ? canonicalType(m[1]) : null;
					if (!type || !m) return; // plain quote / unknown type

					const markerStart = firstLine.from + li + m[0].indexOf("[!");
					const markerEnd = markerStart + m[0].indexOf("]") + 1;

					// Accent each line of the callout block.
					const startLine = doc.lineAt(node.from).number;
					const endLine = doc.lineAt(node.to).number;

					// Decorations must be added in ascending `from` order: line 1
					// accent, the `[!type]` mark, the custom title mark, then the
					// accent for lines 2..end.
					builder.add(
						firstLine.from,
						firstLine.from,
						Decoration.line({
							class: `cm-callout cm-callout-${type}`,
						}),
					);

					// Colored type label over the `[!type]` marker (default title =
					// the type name when no custom title is given).
					const title = (m[2] || "").trim() || CALLOUT_TYPES[type].label;
					builder.add(
						markerStart,
						markerEnd,
						Decoration.mark({ className: "cm-callout-type", title }),
					);
					if (m[2].trim()) {
						const titleEnd = firstLine.from + li + rest.length;
						builder.add(
							markerEnd + 1,
							titleEnd,
							Decoration.mark({ className: "cm-callout-title" }),
						);
					}

					for (let n = startLine + 1; n <= endLine; n++) {
						const line = doc.line(n);
						builder.add(
							line.from,
							line.from,
							Decoration.line({
								class: `cm-callout cm-callout-${type}`,
							}),
						);
					}
				},
			});
		}
		return builder.finish();
	}
}

export const calloutPlugin = ViewPlugin.fromClass(CalloutPlugin, {
	decorations: (v) => v.decorations,
});