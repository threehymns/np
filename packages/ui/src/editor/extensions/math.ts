import type { MarkdownConfig } from "@lezer/markdown";
import { styleTags, tags as t } from "@lezer/highlight";

function isEscaped(cx: any, pos: number): boolean {
	return pos > 0 && cx.char(pos - 1) === 92 /* \ */;
}

/**
 * Obsidian math as plain code: `$…$` inline and `$$…$$` display are highlighted
 * with the monospace code style and kept unparsed (no markdown inside). No
 * render attempt — a future renderer PR must flip the golden tests deliberately.
 */
export const MathExtension: MarkdownConfig = {
	defineNodes: [
		{ name: "Math" },
		{ name: "MathMark" },
	],
	parseInline: [
		{
			name: "InlineMath",
			before: "Emphasis",
			parse(cx, next, pos) {
				if (next !== 36 /* $ */) return -1;
				if (isEscaped(cx, pos)) return -1;

				const isDisplay = cx.char(pos + 1) === 36;
				const markLen = isDisplay ? 2 : 1;
				if (isDisplay && cx.char(pos + 2) === 36) return -1; // $$$

				const start = pos;
				const contentStart = start + markLen;
				if (contentStart >= cx.end) return -1;

				let end = -1;
				let i = contentStart;
				if (isDisplay) {
					// Display math may span lines; find closing `$$`.
					while (i < cx.end) {
						if (
							cx.char(i) === 36 &&
							cx.char(i + 1) === 36 &&
							cx.char(i + 2) !== 36
						) {
							end = i + 2;
							break;
						}
						i++;
					}
				} else {
					// Inline math: tight wrap, no leading/trailing whitespace, one line.
					if (cx.char(contentStart) === 32 /* space */) return -1;
					let prevWasSpace = false;
					while (i < cx.end) {
						const ch = cx.char(i);
						if (ch === 10) return -1; // inline math must stay single-line
						if (ch === 36 && cx.char(i + 1) !== 36) {
							if (prevWasSpace) return -1; // " $ " not math
							end = i + 1;
							break;
						}
						prevWasSpace = ch === 32;
						i++;
					}
				}

				if (end === -1 || end - markLen <= contentStart) return -1;

				cx.addElement(
					cx.elt("Math", start, end, [
						cx.elt("MathMark", start, contentStart),
						cx.elt("MathMark", end - markLen, end),
					]),
				);
				return end;
			},
		},
	],
	props: [
		styleTags({
			Math: t.monospace,
			MathMark: t.monospace,
		}),
	],
};