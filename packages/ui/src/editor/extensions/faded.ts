import type { MarkdownConfig } from "@lezer/markdown";
import { styleTags } from "@lezer/highlight";
import { fadedTag } from "./highlight";

function isWord(c: number): boolean {
	return (
		(c >= 48 && c <= 57) || // 0-9
		(c >= 65 && c <= 90) || // A-Z
		(c >= 97 && c <= 122) || // a-z
		c === 95 || // _
		c === 45 // -
	);
}

/**
 * Obsidian hidden text (`%%…%%`) and trailing block anchors (`^id`), both
 * rendered faded-but-visible. `^[inline footnote]` wins over `^id` (footnote
 * ships before this extension), and HTML comments (`<!-- … -->`) are untouched.
 */
export const FadedExtension: MarkdownConfig = {
	defineNodes: [
		{ name: "FadedText" },
		{ name: "FadedMark" },
		{ name: "BlockAnchor" },
		{ name: "BlockAnchorMark" },
	],
	parseInline: [
		{
			name: "HiddenComment",
			before: "Emphasis",
			parse(cx, next, pos) {
				if (next !== 37 /* % */) return -1;
				if (cx.char(pos + 1) !== 37) return -1; // need %%
				const start = pos;
				const contentStart = pos + 2;
				let i = contentStart;
				while (i < cx.end) {
					const ch = cx.char(i);
					if (ch === 10) return -1; // single paragraph
					if (ch === 37 && cx.char(i + 1) === 37) break;
					i++;
				}
				if (i >= cx.end || cx.char(i) !== 37 || cx.char(i + 1) !== 37)
					return -1;
				if (i === contentStart) return -1; // empty
				const end = i + 2;
				cx.addElement(
					cx.elt("FadedText", start, end, [
						cx.elt("FadedMark", start, contentStart),
						cx.elt("FadedMark", i, end),
					]),
				);
				return end;
			},
		},
		{
			name: "BlockAnchor",
			before: "Emphasis",
			parse(cx, next, pos) {
				if (next !== 94 /* ^ */) return -1;
				if (cx.char(pos + 1) === 91 /* [ */) return -1; // footnote wins
				const prev = pos > 0 ? cx.char(pos - 1) : 0;
				if (isWord(prev)) return -1; // a^b
				let i = pos + 1;
				if (i >= cx.end || !isWord(cx.char(i))) return -1;
				while (i < cx.end && isWord(cx.char(i))) i++;
				const start = pos;
				const end = i;
				cx.addElement(
					cx.elt("BlockAnchor", start, end, [
						cx.elt("BlockAnchorMark", start, start + 1),
					]),
				);
				return end;
			},
		},
	],
	props: [
		styleTags({
			FadedText: fadedTag,
			FadedMark: fadedTag,
			BlockAnchor: fadedTag,
			BlockAnchorMark: fadedTag,
		}),
	],
};