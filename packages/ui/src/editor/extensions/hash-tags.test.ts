import { describe, it, expect } from "bun:test";
import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { highlightTree } from "@lezer/highlight";
import { readFileSync } from "fs";
import { resolve } from "path";
import { markdownHighlight, markdownHighlightChunks } from "./highlight";
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

	it("keeps the cm-tag chunk class-only (TagStyle drops style props when class is set)", () => {
		const chunk: any = markdownHighlightChunks.find(
			(c) => (c as any).class === "cm-tag",
		);
		expect(chunk).toBeDefined();
		expect(Object.keys(chunk).sort()).toEqual(["class", "tag"]);
	});

	it("emits cm-tag on tag text via the composed style", () => {
		const state = EditorState.create({
			doc: "#tag",
			extensions: [mdExt],
		});
		const classes: string[] = [];
		highlightTree(syntaxTree(state), markdownHighlight, (_from, _to, cls) => {
			classes.push(cls);
		});
		expect(classes.some((c) => c.split(" ").includes("cm-tag"))).toBe(
			true,
		);
	});

	it("backs cm-tag with a background rule in markdown.css", () => {
		const css = readFileSync(
			resolve(__dirname, "../styles/markdown.css"),
			"utf-8",
		);
		expect(css).toContain(".cm-tag");
		expect(css).toContain(
			"color-mix(in srgb, var(--accent), transparent 72%)",
		);
	});
});
