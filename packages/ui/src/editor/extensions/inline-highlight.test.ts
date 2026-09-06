import { describe, it, expect } from "bun:test";
import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { highlightTree } from "@lezer/highlight";
import { readFileSync } from "fs";
import { resolve } from "path";
import { markdownHighlight, markdownHighlightChunks } from "./highlight";
import { HideMarkersPlugin } from "./hide-markers";
import { HighlightExtension } from "./inline-highlight";

const mdExt = markdown({ extensions: [GFM, HighlightExtension] as any });

function highlightSpans(doc: string): string[] {
	const state = EditorState.create({ doc, extensions: [mdExt] });
	const out: string[] = [];
	syntaxTree(state).iterate({
		enter: (n: any) => {
			if (n.name === "Highlight")
				out.push(state.doc.sliceString(n.from, n.to));
		},
	});
	return out;
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

describe("#139 inline highlight", () => {
	it("parses ==highlighted== into Highlight + marks", () => {
		const state = EditorState.create({
			doc: "==both==",
			extensions: [mdExt],
		});
		const names: string[] = [];
		syntaxTree(state).iterate({ enter: (n: any) => names.push(n.name) });
		expect(names).toContain("Highlight");
		expect(names.filter((n) => n === "HighlightMark").length).toBe(2);
	});

	it("never false-positives on a single = (a = b)", () => {
		expect(highlightSpans("a = b")).toEqual([]);
		expect(highlightSpans("x == y")).toEqual([]);
	});

	it("works combined with bold", () => {
		expect(highlightSpans("**bold** ==both== ok")).toEqual(["==both=="]);
	});

	it("works inside lists and quotes", () => {
		expect(highlightSpans("- item ==hi==")).toEqual(["==hi=="]);
		expect(highlightSpans("> quote ==hi==")).toEqual(["==hi=="]);
	});

	it("applies a mark-like style chunk", () => {
		expect(
			markdownHighlightChunks.some(
				(c) => (c as any).class === "cm-mark",
			),
		).toBe(true);
	});

	it("keeps the cm-mark chunk class-only (TagStyle drops style props when class is set)", () => {
		const chunk: any = markdownHighlightChunks.find(
			(c) => (c as any).class === "cm-mark",
		);
		expect(chunk).toBeDefined();
		expect(Object.keys(chunk).sort()).toEqual(["class", "tag"]);
	});

	it("emits cm-mark on the highlighted text via the composed style", () => {
		const state = EditorState.create({
			doc: "==hi==",
			extensions: [mdExt],
		});
		const classes: string[] = [];
		highlightTree(syntaxTree(state), markdownHighlight, (_from, _to, cls) => {
			classes.push(cls);
		});
		expect(classes.some((c) => c.split(" ").includes("cm-mark"))).toBe(
			true,
		);
	});

	it("backs cm-mark with a background rule in markdown.css", () => {
		const css = readFileSync(
			resolve(__dirname, "../styles/markdown.css"),
			"utf-8",
		);
		expect(css).toContain(".cm-mark");
		expect(css).toContain(
			"color-mix(in srgb, var(--accent), transparent 58%)",
		);
	});

	it("hides the == sigils when the cursor is outside the node", () => {
		// "abc ==hi== def": == at 4-6, 8-10
		expect(replacedRanges("abc ==hi== def", 1, false)).toEqual([
			{ from: 4, to: 6 },
			{ from: 8, to: 10 },
		]);
	});

	it("shows the == sigils when the cursor is inside the node", () => {
		expect(replacedRanges("abc ==hi== def", 6, true)).toEqual([]);
	});
});
