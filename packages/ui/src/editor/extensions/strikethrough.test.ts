import { describe, it, expect } from "bun:test";
import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { markdownHighlight, markdownHighlightChunks } from "./highlight";
import { HideMarkersPlugin } from "./hide-markers";
import { StrikethroughExtension } from "./strikethrough";

const mdExt = markdown({ extensions: [GFM, StrikethroughExtension] as any });

function replacedRanges(
	doc: string,
	anchor: number,
	hasFocus: boolean,
): { from: number; to: number }[] {
	const state = EditorState.create({
		doc,
		selection: { anchor },
		extensions: [mdExt],
	});
	const mockView: any = {
		state,
		visibleRanges: [{ from: 0, to: doc.length }],
		hasFocus,
	};
	const plugin = new HideMarkersPlugin(mockView);
	const out: { from: number; to: number }[] = [];
	const cursor = plugin.decorations.iter();
	while (cursor.value !== null) {
		const spec = (cursor.value as any).spec;
		if (spec.widget === undefined && !spec.class) {
			out.push({ from: cursor.from, to: cursor.to });
		}
		cursor.next();
	}
	return out;
}

describe("#138 strikethrough", () => {
	it("parses ~~struck~~ as Strikethrough with sigil Mark nodes (parse unchanged)", () => {
		const state = EditorState.create({
			doc: "~~struck~~",
			extensions: [mdExt],
		});
		const names: string[] = [];
		syntaxTree(state).iterate({
			enter: (n: any) => names.push(n.name),
		});
		expect(names).toContain("Strikethrough");
		expect(names.filter((n) => n === "StrikethroughMark").length).toBe(2);
	});

	it("applies line-through styling to Strikethrough-typed text", () => {
		// The composed highlight style carries a line-through rule (seam: a
		// feature style chunk is composed into markdownHighlightChunks).
		expect(
			markdownHighlightChunks.some(
				(c) => (c as any).textDecoration === "line-through",
			),
		).toBe(true);
		expect(markdownHighlight).toBeTruthy();
	});

	it("hides the ~~ sigils when the cursor is outside the node (unfocused)", () => {
		// "abc ~~struck~~ def" — sigil ranges at 4-6 and 12-14
		expect(replacedRanges("abc ~~struck~~ def", 1, false)).toEqual([
			{ from: 4, to: 6 },
			{ from: 12, to: 14 },
		]);
	});

	it("shows the ~~ sigils when the cursor is inside the node", () => {
		// cursor at the start of the struck text (inside the node) shows sigils
		expect(replacedRanges("abc ~~struck~~ def", 6, true)).toEqual([]);
	});

	it("hides sigils when cursor is on the same line but outside the node", () => {
		// cursor after the closing sigils (inside node => shown). Use a cursor
		// before the node to verify the "outside node" rule hides on the same line.
		expect(replacedRanges("abc ~~struck~~", 1, true)).toEqual([
			{ from: 4, to: 6 },
			{ from: 12, to: 14 },
		]);
	});
});