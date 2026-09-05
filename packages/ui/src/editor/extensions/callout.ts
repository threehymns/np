import {
	Decoration,
	ViewPlugin,
	ViewUpdate,
	EditorView,
} from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { RangeSetBuilder, Facet } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { keymap } from "@codemirror/view";

/**
 * Fold state: 1-based start lines of callouts whose body is collapsed. Purely
 * visual — toggling never edits the source text.
 */
export const calloutFoldState = Facet.define<number[], number[]>({
	combine: (values) => values.flat(),
});

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
		const collected: { from: number; to: number; value: Decoration }[] = [];
		const add = (from: number, to: number, value: Decoration) =>
			collected.push({ from, to, value });
		const doc = view.state.doc;

		for (let { from, to } of view.visibleRanges) {
			syntaxTree(view.state).iterate({
				from,
				to,
				enter: (node) => {
					if (node.name !== "Blockquote") return;
					const firstLine = doc.lineAt(node.from);
					const lineText = firstLine.text;
					// Nested callouts are one depth per leading `>`.
					const depth = (lineText.match(/^>+/) || [''])[0].length;
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
					const collapsed = view.state.facet(calloutFoldState);
					const isCollapsed = collapsed.includes(startLine);
					const baseClass = `cm-callout cm-callout-${type}${
						depth > 1 ? " cm-callout-nested" : ""
					}`;

					add(
						firstLine.from,
						firstLine.from,
						Decoration.line({ class: baseClass }),
					);

					const title =
						(m[2] || "").trim() || CALLOUT_TYPES[type].label;
					add(
						markerStart,
						markerEnd,
						Decoration.mark({ className: "cm-callout-type", title }),
					);
					if (m[2].trim()) {
						const titleEnd = firstLine.from + li + rest.length;
						add(
							markerEnd + 1,
							titleEnd,
							Decoration.mark({ className: "cm-callout-title" }),
						);
					}

					if (isCollapsed) {
						// Fold: hide the body lines (source text untouched).
						add(
							doc.line(startLine + 1).from,
							doc.line(endLine).to,
							Decoration.replace({ class: "cm-callout-folded" }),
						);
					} else {
						for (let n = startLine + 1; n <= endLine; n++) {
							const line = doc.line(n);
							add(
								line.from,
								line.from,
								Decoration.line({ class: baseClass }),
							);
						}
					}
				},
			});
		}
		// Nested blockquotes iterate outer-then-inner, so collect + sort by
		// `from` (then `to`) so the builder receives strictly-ascending ranges.
		collected.sort((a, b) => a.from - b.from || a.to - b.to);
		const builder = new RangeSetBuilder<Decoration>();
		for (const c of collected) builder.add(c.from, c.to, c.value);
		return builder.finish();
	}
}

export const calloutPlugin = ViewPlugin.fromClass(CalloutPlugin, {
	decorations: (v) => v.decorations,
});

/** 1-based start line of the callout blockquote enclosing `pos`, or null. */
function calloutStartLine(state: any, pos: number): number | null {
	let node: any = syntaxTree(state).resolveInner(pos, -1);
	while (node && node.name !== "Blockquote" && node.parent) {
		node = node.parent;
	}
	if (!node || node.name !== "Blockquote") return null;
	const startLine = state.doc.lineAt(node.from).number;
	// Confirm it's actually a callout (first line opens with `[!type]`).
	let t = state.doc.line(startLine).text.trim();
	while (t.startsWith(">")) t = t.slice(1).trimStart();
	if (!/^\[!\w+\]/.test(t)) return null;
	return startLine;
}

/** Toggle a callout's body fold (purely visual; source bytes unchanged). */
export function toggleCallout(view: EditorView): boolean {
	const startLine = calloutStartLine(view.state, view.state.selection.main.head);
	if (startLine == null) return false;
	const set = new Set(view.state.facet(calloutFoldState));
	if (set.has(startLine)) set.delete(startLine);
	else set.add(startLine);
	view.dispatch({ effects: calloutFoldState.of([...set]) });
	return true;
}

export const calloutFoldKeymap = keymap.of([{ key: "Mod-Alt-f", run: toggleCallout }]);