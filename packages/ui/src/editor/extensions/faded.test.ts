import { describe, it, expect } from "bun:test";
import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { markdownHighlightChunks } from "./highlight";
import { HideMarkersPlugin } from "./hide-markers";
import { FadedExtension } from "./faded";
import { FootnoteExtension } from "./footnote";

const mdExt = markdown({
	extensions: [GFM, FootnoteExtension, FadedExtension] as any,
});

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

function nodeTexts(doc: string, name: string): string[] {
	const state = EditorState.create({ doc, extensions: [mdExt] });
	const out: string[] = [];
	syntaxTree(state).iterate({
		enter: (n: any) => {
			if (n.name === name) out.push(state.doc.sliceString(n.from, n.to));
		},
	});
	return out;
}

function hiddenRanges(doc: string): { from: number; to: number }[] {
	const state = EditorState.create({
		doc,
		selection: { anchor: 0 },
		extensions: [mdExt],
	});
	const mockView: any = {
		state,
		visibleRanges: [{ from: 0, to: doc.length }],
		hasFocus: false,
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

describe("#143 faded hidden text + block anchors", () => {
	it("parses %%hidden%% as faded text that stays visible", () => {
		expect(nodeTexts("before %%hidden%% after", "FadedText")).toContain(
			"%%hidden%%",
		);
		// never replaced-hidden: nothing is collapsed off-cursor
		expect(hiddenRanges("x %%hidden%% y")).toEqual([]);
	});

	it("leaves unclosed %% as plain text", () => {
		expect(hasNode("unclosed %%", "FadedText")).toBe(false);
	});

	it("parses trailing ^block-id anchors as faded", () => {
		expect(nodeTexts("text ^blk-42 done", "BlockAnchor")).toContain(
			"^blk-42",
		);
	});

	it("lets ^[inline footnote] win over a block-anchor scan", () => {
		expect(hasNode("see ^[inline note]", "BlockAnchor")).toBe(false);
		expect(hasNode("see ^[inline note]", "Footnote")).toBe(true);
	});

	it("leaves HTML <!-- comments --> unchanged", () => {
		expect(hasNode("<!-- html -->", "CommentBlock")).toBe(true);
		expect(hasNode("<!-- html -->", "FadedText")).toBe(false);
	});

	it("applies the faded style chunk", () => {
		expect(
			markdownHighlightChunks.some(
				(c) => (c as any).class === "md-faded",
			),
		).toBe(true);
	});
});
