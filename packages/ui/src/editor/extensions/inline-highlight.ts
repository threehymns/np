import type { MarkdownConfig } from "@lezer/markdown";
import { styleTags } from "@lezer/highlight";
import { markHighlightTag } from "./highlight";

/**
 * Obsidian `==highlight==`. Parses a `==`…`==` delimiter pair into a
 * Highlight node with HighlightMark children, styled by the composed
 * highlight chunk (mark-like background). Single `=` never matches.
 */
export const HighlightExtension: MarkdownConfig = {
	defineNodes: [
		{ name: "Highlight" },
		{ name: "HighlightMark" },
	],
	parseInline: [
		{
			name: "Highlight",
			before: "Emphasis",
			parse(cx, next, pos) {
				if (next !== 61 /* = */) return -1;
				// Need a double `==`, and not a triple `===` opener.
				if (cx.char(pos + 1) !== 61) return -1;
				if (cx.char(pos + 2) === 61) return -1;

				const start = pos;
				const contentStart = pos + 2;
				if (contentStart >= cx.end) return -1;

				let end = -1;
				for (let i = contentStart; i < cx.end; i++) {
					const ch = cx.char(i);
					if (ch === 10 /* \n */) return -1;
					if (
						ch === 61 &&
						cx.char(i + 1) === 61 &&
						cx.char(i + 2) !== 61 &&
						cx.char(i - 1) !== 61
					) {
						end = i + 2;
						break;
					}
				}
				if (end === -1 || end - 2 <= contentStart) return -1;

				cx.addElement(
					cx.elt("Highlight", start, end, [
						cx.elt("HighlightMark", start, contentStart),
						cx.elt("HighlightMark", end - 2, end),
					]),
				);
				return end;
			},
		},
	],
	props: [
		styleTags({
			Highlight: markHighlightTag,
		}),
	],
};