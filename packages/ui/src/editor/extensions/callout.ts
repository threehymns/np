import {
	Decoration,
	ViewPlugin,
	ViewUpdate,
	EditorView,
	WidgetType,
} from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { RangeSetBuilder, StateField, StateEffect } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { MarkdownConfig } from "@lezer/markdown";
import { mount } from "svelte";
import { iconRegistry } from "../icons.svelte";

export const setCalloutFoldEffect = StateEffect.define<number[]>();
export const toggleCalloutFoldEffect = StateEffect.define<number>();

/**
 * Fold state: 1-based start lines of callouts whose body is collapsed. Purely
 * visual — toggling never edits the source text.
 */
export const calloutFoldField = StateField.define<number[]>({
	create() {
		return [];
	},
	update(folded, tr) {
		for (const e of tr.effects) {
			if (e.is(setCalloutFoldEffect)) {
				return e.value;
			}
			if (e.is(toggleCalloutFoldEffect)) {
				const line = e.value;
				return folded.includes(line)
					? folded.filter((l) => l !== line)
					: [...folded, line];
			}
		}
		return folded;
	},
});

export const calloutFoldState = calloutFoldField;

/** Obsidian callout type map: type -> { label, aliases }. */
export const CALLOUT_TYPES: Record<string, { label: string; aliases?: string[] }> = {
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
	failure: { label: "failure", aliases: ["fail", "missing"] },
};

export function canonicalType(type: string): string | null {
	const t = type.trim().toLowerCase();
	if (CALLOUT_TYPES[t]) return t;
	for (const [key, val] of Object.entries(CALLOUT_TYPES)) {
		if (val.aliases?.includes(t)) return key;
	}
	return null;
}

/**
 * Lezer Markdown inline extension that intercepts `[!type]` / `[!type]+` / `[!type]-`
 * before the standard Markdown Link parser so callouts do not parse as Links.
 */
export const CalloutExtension: MarkdownConfig = {
	defineNodes: [
		{ name: "Callout" },
		{ name: "CalloutMark" },
		{ name: "CalloutType" },
	],
	parseInline: [
		{
			name: "Callout",
			before: "Link",
			parse(cx, next, pos) {
				if (next !== 91 /* [ */) return -1;
				if (cx.char(pos + 1) !== 33 /* ! */) return -1;
				let i = pos + 2;
				while (i < cx.end) {
					const ch = cx.char(i);
					if (ch === 93 /* ] */) break;
					if (ch === 32 || ch === 10) return -1;
					i++;
				}
				if (i >= cx.end || cx.char(i) !== 93) return -1;
				if (i === pos + 2) return -1;

				let end = i + 1;
				if (cx.char(end) === 43 /* + */ || cx.char(end) === 45 /* - */) {
					end++;
				}

				const start = pos;
				cx.addElement(
					cx.elt("Callout", start, end, [
						cx.elt("CalloutMark", start, start + 2),
						cx.elt("CalloutType", pos + 2, i),
						cx.elt("CalloutMark", i, end),
					]),
				);
				return end;
			},
		},
	],
};

/**
 * Widget for rendering callout icons dynamically from the active icon theme.
 */
export class CalloutIconWidget extends WidgetType {
	constructor(readonly type: string) {
		super();
	}

	eq(other: CalloutIconWidget) {
		return other.type === this.type;
	}

	toDOM() {
		const span = document.createElement("span");
		span.className = `cm-callout-icon cm-callout-icon-${this.type}`;
		span.setAttribute("aria-hidden", "true");

		if (typeof document === "undefined") return span;

		try {
			const chain = iconRegistry.resolveProductIconChain(`callout-${this.type}`);
			const first = chain[0] ?? iconRegistry.resolveProductIconChain(this.type)[0];
			if (first) {
				if (first.type === "component" && typeof mount === "function") {
					mount(first.value, { target: span, props: { size: 16 } });
				} else if (first.type === "url") {
					const img = document.createElement("img");
					img.src = first.value;
					img.alt = this.type;
					img.style.width = "16px";
					img.style.height = "16px";
					span.appendChild(img);
				}
			}
		} catch {
			// Ignore DOM mount error in mock / test environment
		}
		return span;
	}
}

/**
 * Base callout rendering: a blockquote whose first line opens with `[!type]`
 * gets a callout accent (per-type class), a dynamic theme icon widget, and a colored
 * type/title label on that line; inner content (bold, lists, links) still parses normally.
 * An unknown type falls back to a plain quote with content intact (no decoration).
 */
class CalloutPlugin {
	decorations: DecorationSet;

	constructor(view: EditorView) {
		this.decorations = this.getDecorations(view);
	}

	update(update: ViewUpdate) {
		if (
			update.docChanged ||
			update.viewportChanged ||
			update.state.field(calloutFoldField, false) !==
				update.startState.field(calloutFoldField, false)
		) {
			this.decorations = this.getDecorations(update.view);
		}
	}

	getDecorations(view: EditorView) {
		const collected: { from: number; to: number; value: Decoration }[] = [];
		const add = (from: number, to: number, value: Decoration) =>
			collected.push({ from, to, value });
		const doc = view.state.doc;
		const processedStartLines = new Set<number>();
		interface CalloutInfo {
			startLine: number;
			endLine: number;
			depth: number;
			type: string;
			firstLineFrom: number;
			lineOffset: number;
			rest: string;
			calloutMatch: RegExpMatchArray;
			markerStart: number;
			markerEnd: number;
			baseClass: string;
			isCollapsed: boolean;
		}
		const callouts: CalloutInfo[] = [];

		for (let { from, to } of view.visibleRanges) {
			syntaxTree(view.state).iterate({
				from,
				to,
				enter: (node) => {
					if (node.name !== "Blockquote") return;
					const firstLine = doc.lineAt(node.from);
					const lineText = firstLine.text;
					// Strip leading `>` (and one space) to reach the marker and compute depth.
					let depth = 0;
					let lineOffset = 0;
					while (lineOffset < lineText.length && lineText[lineOffset] === ">") {
						depth++;
						lineOffset++;
						if (lineText[lineOffset] === " ") lineOffset++;
					}
					const rest = lineText.slice(lineOffset);
					const calloutMatch = rest.match(/^\[!(\w+)([-+])?\]([-+])?(.*)$/);
					const type = calloutMatch ? canonicalType(calloutMatch[1]) : null;
					if (!type || !calloutMatch) return; // plain quote / unknown type
					const startLine = doc.lineAt(node.from).number;
					if (processedStartLines.has(startLine)) return;
					processedStartLines.add(startLine);

					const foldMarker = calloutMatch[2] || calloutMatch[3];
					const isDefaultCollapsed = foldMarker === "-";

					const markerStart = firstLine.from + lineOffset + calloutMatch[0].indexOf("[!");
					const closeBracketRel = calloutMatch[0].indexOf("]");
					const markerEnd = markerStart + closeBracketRel + 1 + (calloutMatch[3] ? 1 : 0);

					// Accent each line of the callout block.
					const endLine = doc.lineAt(node.to).number;
					const collapsed = view.state.field(calloutFoldField, false) ?? [];
					const isCollapsed = isDefaultCollapsed
						? !collapsed.includes(startLine)
						: collapsed.includes(startLine);
					const baseClass = `cm-callout cm-callout-${type}${
						depth > 1 ? " cm-callout-nested" : ""
					}`;

					callouts.push({
						startLine,
						endLine,
						depth,
						type,
						firstLineFrom: firstLine.from,
						lineOffset,
						rest,
						calloutMatch,
						markerStart,
						markerEnd,
						baseClass,
						isCollapsed,
					});
				},
			});
		}

		// Folded bodies hide every line beneath the header, including nested
		// callouts, so compute the hidden set before emitting line accents.
		const hidden = new Set<number>();
		for (const c of callouts) {
			if (c.isCollapsed && c.startLine < c.endLine) {
				for (let n = c.startLine + 1; n <= c.endLine; n++) hidden.add(n);
			}
		}
		for (const n of hidden) {
			if (n < 1 || n > doc.lines) continue;
			const line = doc.line(n);
			add(line.from, line.to, Decoration.replace({}));
		}

		// Deepest callout owns each line's accent so a nested type keeps its
		// local color instead of inheriting the outer callout's variable.
		const ownerOf = (lineNum: number): CalloutInfo | null => {
			let owner: CalloutInfo | null = null;
			for (const c of callouts) {
				if (lineNum < c.startLine || lineNum > c.endLine) continue;
				if (
					!owner ||
					c.depth > owner.depth ||
					(c.depth === owner.depth && c.startLine > owner.startLine)
				) {
					owner = c;
				}
			}
			return owner;
		};

		for (const c of callouts) {
			if (hidden.has(c.startLine)) continue;
			const owner = ownerOf(c.startLine);
			if (owner !== c) continue; // header owned by a deeper callout
			add(
				c.firstLineFrom,
				c.firstLineFrom,
				Decoration.line({ class: c.baseClass }),
			);

			const title =
				(c.calloutMatch[4] || "").trim() || CALLOUT_TYPES[c.type].label;

			// Add icon widget before the type marker
			add(
				c.markerStart,
				c.markerStart,
				Decoration.widget({
					widget: new CalloutIconWidget(c.type),
					side: -1,
				}),
			);

			add(
				c.markerStart,
				c.markerEnd,
				Decoration.mark({ class: "cm-callout-type", attributes: { title } }),
			);
			if (c.calloutMatch[4] && c.calloutMatch[4].trim()) {
				const firstLine = doc.line(c.startLine);
				const titleEnd = c.firstLineFrom + c.lineOffset + c.rest.length;
				const titleStart = c.markerEnd + (c.calloutMatch[4].startsWith(" ") ? 1 : 0);
				if (titleStart < titleEnd && titleEnd <= firstLine.to + 1) {
					add(
						titleStart,
						titleEnd,
						Decoration.mark({ class: "cm-callout-title" }),
					);
				}
			}
		}

		for (const c of callouts) {
			for (let n = c.startLine + 1; n <= c.endLine; n++) {
				if (hidden.has(n)) continue;
				if (ownerOf(n) !== c) continue;
				const line = doc.line(n);
				add(
					line.from,
					line.from,
					Decoration.line({ class: c.baseClass }),
				);
			}
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
	if (!/^\[!\w+[-+]?\][-+]?/.test(t)) return null;
	return startLine;
}

/** Toggle a callout's body fold (purely visual; source bytes unchanged). */
export function toggleCallout(view: EditorView): boolean {
	const startLine = calloutStartLine(view.state, view.state.selection.main.head);
	if (startLine == null) return false;
	view.dispatch({ effects: toggleCalloutFoldEffect.of(startLine) });
	return true;
}
