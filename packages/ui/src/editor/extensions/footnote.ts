import type { MarkdownConfig } from "@lezer/markdown";
import { styleTags } from "@lezer/highlight";
import { footnoteTag } from "./highlight";

/**
 * Obsidian footnotes (references, inline, and definitions). `[^label]` references
 * are parsed before the base Link parser and styled raised/link-like with hidden
 * markers; `^[inline note]` parses as a footnote and wins over any block-anchor scan.
 * `[^label]: definition` blocks are collected without breaking surrounding blocks.
 */
export const FootnoteExtension: MarkdownConfig = {
	defineNodes: [
		{ name: "Footnote" },
		{ name: "FootnoteMark" },
		{ name: "FootnoteLabel" },
		{ name: "FootnoteDefinition", block: true },
	],
	parseBlock: [
		{
			name: "FootnoteDefinition",
			before: "LinkReference",
			parse(cx, line) {
				if (line.pos >= line.text.length) return false;
				const rest = line.text.slice(line.pos);
				const match = rest.match(/^\[\^([^\]\s]+)\]:\s*/);
				if (!match) return false;
				const start = cx.lineStart + line.pos;
				const labelStart = start + 2;
				const labelEnd = labelStart + match[1].length;
				const markEnd = start + match[0].indexOf("]") + 2;
				const from = start;
				let to = cx.lineStart + line.text.length;
				cx.nextLine();
				while (
					line.depth >= 0 &&
					(line.text.startsWith("    ") || line.text.startsWith("\t"))
				) {
					to = cx.lineStart + line.text.length;
					cx.nextLine();
				}
				cx.addElement(
					cx.elt("FootnoteDefinition", from, to, [
						cx.elt("FootnoteMark", start, start + 2),
						cx.elt("FootnoteLabel", labelStart, labelEnd),
						cx.elt("FootnoteMark", labelEnd, markEnd),
					]),
				);
				return true;
			},
		},
	],
	parseInline: [
		{
			name: "Footnote",
			before: "Link",
			parse(cx, next, pos) {
				if (next !== 91 /* [ */) return -1;
				if (cx.char(pos + 1) !== 94 /* ^ */) return -1;
				let i = pos + 2;
				while (i < cx.end) {
					const ch = cx.char(i);
					if (ch === 93 /* ] */) {
						// `[^x](...)` is a link, not a footnote reference.
						if (cx.char(i + 1) === 40 /* ( */) return -1;
						break;
					}
					if (ch === 32 || ch === 10) return -1; // compact label
					i++;
				}
				if (i >= cx.end || cx.char(i) !== 93) return -1;
				if (i === pos + 2) return -1; // empty label
				const start = pos;
				const end = i + 1;
				cx.addElement(
					cx.elt("Footnote", start, end, [
						cx.elt("FootnoteMark", start, start + 2),
						cx.elt("FootnoteLabel", pos + 2, i),
						cx.elt("FootnoteMark", i, end),
					]),
				);
				return end;
			},
		},
		{
			name: "FootnoteInline",
			before: "Emphasis",
			parse(cx, next, pos) {
				if (next !== 94 /* ^ */) return -1;
				if (cx.char(pos + 1) !== 91 /* [ */) return -1;
				let i = pos + 2;
				while (i < cx.end) {
					if (cx.char(i) === 93 /* ] */) break;
					if (cx.char(i) === 10) return -1;
					i++;
				}
				if (i >= cx.end || cx.char(i) !== 93) return -1;
				if (i === pos + 2) return -1;
				const start = pos;
				const end = i + 1;
				cx.addElement(
					cx.elt("Footnote", start, end, [
						cx.elt("FootnoteMark", start, start + 2),
						cx.elt("FootnoteLabel", pos + 2, i),
						cx.elt("FootnoteMark", i, end),
					]),
				);
				return end;
			},
		},
	],
	props: [
		styleTags({
			Footnote: footnoteTag,
			FootnoteMark: footnoteTag,
			FootnoteLabel: footnoteTag,
			FootnoteDefinition: footnoteTag,
		}),
	],
};