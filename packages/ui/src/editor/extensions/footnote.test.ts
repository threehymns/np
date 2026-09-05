import { describe, it, expect } from "bun:test";
import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { GFM, Table } from "@lezer/markdown";
import { markdownHighlightChunks } from "./highlight";
import { HideMarkersPlugin } from "./hide-markers";
import { FootnoteExtension } from "./footnote";
import { WikiLinkExtension } from "./wikilinks";

const mdExt = markdown({
	extensions: [Table, GFM, WikiLinkExtension, FootnoteExtension] as any,
});

function footnoteLabels(doc: string): string[] {
	const state = EditorState.create({ doc, extensions: [mdExt] });
	const out: string[] = [];
	syntaxTree(state).iterate({
		enter: (n: any) => {
			if (n.name === "FootnoteLabel")
				out.push(state.doc.sliceString(n.from, n.to));
		},
	});
	return out;
}

function hasNode(doc: string, name: string): boolean {
	const state = EditorState.create({ doc, extensions: [mdExt] });
	let found = false;
	syntaxTree(state).iterate({
		enter: (n: any) => {
			if (n.name === name) found = true;
		},
	});
	return found;
}

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

describe("#141 footnotes (references + inline)", () => {
	it("parses [^1] reference into Footnote with label", () => {
		expect(footnoteLabels("a footnote[^1] here")).toEqual(["1"]);
		expect(footnoteLabels("ref[^note] done")).toEqual(["note"]);
	});

	it("parses ^[inline note] into a Footnote", () => {
		expect(footnoteLabels("see ^[inline note] now")).toEqual([
			"inline note",
		]);
	});

	it("leaves normal [links](…) unaffected", () => {
		const doc = "[normal](https://example.com)";
		expect(footnoteLabels(doc)).toEqual([]);
		expect(hasNode(doc, "Link")).toBe(true);
	});

	it("applies raised cm-footnote styling", () => {
		expect(
			markdownHighlightChunks.some(
				(c) => (c as any).className === "cm-footnote",
			),
		).toBe(true);
	});

	it("hides footnote markers off-cursor and shows them when the cursor is inside", () => {
		// "a footnote[^1] here": `[^` at 10-12, `]` at 13-14
		expect(replacedRanges("a footnote[^1] here", 0, false)).toEqual([
			{ from: 10, to: 12 },
			{ from: 13, to: 14 },
		]);
		expect(replacedRanges("a footnote[^1] here", 12, true)).toEqual([]);
	});
});