import { describe, it, expect } from "bun:test";
import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { markdownHighlightChunks } from "./highlight";
import { HashTagExtension } from "./hash-tags";
import { WikiLinkExtension } from "./wikilinks";

const mdExt = markdown({
	extensions: [GFM, WikiLinkExtension, HashTagExtension] as any,
});

function tagSpans(doc: string): string[] {
	const state = EditorState.create({ doc, extensions: [mdExt] });
	const out: string[] = [];
	syntaxTree(state).iterate({
		enter: (n: any) => {
			if (n.name === "Tag") out.push(state.doc.sliceString(n.from, n.to));
		},
	});
	return out;
}

describe("#140 taxonomy tags", () => {
	it("parses #tag mid-line and at line start", () => {
		expect(tagSpans("text #tag here")).toEqual(["#tag"]);
		expect(tagSpans("#tag at start")).toEqual(["#tag"]);
	});

	it("parses nested #project/active", () => {
		expect(tagSpans("topic #project/active done")).toEqual([
			"#project/active",
		]);
		expect(tagSpans("#project/active")).toEqual(["#project/active"]);
	});

	it("supports hyphens in tags", () => {
		expect(tagSpans("a #tag-name b")).toEqual(["#tag-name"]);
	});

	it("never false-positives on heading # Heading", () => {
		expect(tagSpans("# Heading")).toEqual([]);
	});

	it("never false-positives on a#b (mid-word)", () => {
		expect(tagSpans("a#b")).toEqual([]);
	});

	it("never false-positives on pure-numeric #123", () => {
		expect(tagSpans("#123")).toEqual([]);
	});

	it("rejects trailing and double slashes #a/ and #a//b", () => {
		expect(tagSpans("#a/")).toEqual([]);
		expect(tagSpans("#a//b")).toEqual([]);
	});

	it("does not double-parse tags inside wikilinks, code, or link URLs", () => {
		expect(tagSpans("[[#inside-talks]]")).toEqual([]);
		expect(tagSpans("`#code span`")).toEqual([]);
		expect(tagSpans("[label](url#frag)")).toEqual([]);
	});

	it("applies a cm-tag style chunk", () => {
		expect(
			markdownHighlightChunks.some(
				(c) => (c as any).class === "cm-tag",
			),
		).toBe(true);
	});
});
