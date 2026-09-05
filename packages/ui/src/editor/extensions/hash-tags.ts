import type { MarkdownConfig } from "@lezer/markdown";
import { styleTags } from "@lezer/highlight";
import { taxTag } from "./highlight";

function isWord(c: number): boolean {
	return (
		(c >= 48 && c <= 57) || // 0-9
		(c >= 65 && c <= 90) || // A-Z
		(c >= 97 && c <= 122) || // a-z
		c === 95 || // _
		c === 45 // -
	);
}

function isLetterOrUnderscore(c: number): boolean {
	return (
		(c >= 65 && c <= 90) || // A-Z
		(c >= 97 && c <= 122) || // a-z
		c === 95 // _
	);
}

/**
 * Obsidian taxonomy tags: `#tag` and `#project/active`. Obsidian-first
 * disambiguation — a `#` only starts a tag at a word boundary and when the
 * token contains at least one letter/underscore, so headings (`# Heading`),
 * fragments, and pure numbers (`#123`) never match. No markers, so no hiding.
 */
export const HashTagExtension: MarkdownConfig = {
	defineNodes: [
		{ name: "Tag" },
		{ name: "TagMarker" },
	],
	parseInline: [
		{
			name: "Tag",
			before: "Emphasis",
			parse(cx, next, pos) {
				if (next !== 35 /* # */) return -1;
				const prev = pos > 0 ? cx.char(pos - 1) : 0;
				if (isWord(prev)) return -1; // a#b, or inside a word
				const after = cx.char(pos + 1);
				if (!isWord(after)) return -1; // "# Heading" / "#."

				let i = pos + 1;
				let hasLetter = false;
				while (i < cx.end) {
					const c = cx.char(i);
					if (isWord(c)) {
						if (isLetterOrUnderscore(c)) hasLetter = true;
						i++;
					} else if (c === 47 /* / */) {
						if (cx.char(i + 1) === 47) return -1; // #a//b
						if (!isWord(cx.char(i + 1))) return -1; // #a/
						i++;
					} else {
						break;
					}
				}
				if (i === pos + 1) return -1;
				if (!hasLetter) return -1; // #123 pure numeric

				const start = pos;
				const end = i;
				cx.addElement(
					cx.elt("Tag", start, end, [
						cx.elt("TagMarker", start, start + 1),
					]),
				);
				return end;
			},
		},
	],
	props: [
		styleTags({
			Tag: taxTag,
		}),
	],
};