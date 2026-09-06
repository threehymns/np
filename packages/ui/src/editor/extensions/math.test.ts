import { describe, it, expect } from "bun:test";
import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { HashTagExtension } from "./hash-tags";
import { MathExtension } from "./math";

const mdExt = markdown({
	extensions: [GFM, HashTagExtension, MathExtension] as any,
});

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

function hasNode(doc: string, name: string): boolean {
	return nodeTexts(doc, name).length > 0;
}

describe("#153 math/mermaid as code", () => {
	it("parses inline $x$ as a Math code node", () => {
		expect(nodeTexts("inline $x$ text", "Math")).toEqual(["$x$"]);
	});

	it("parses display $$..$$ as a Math code node (multiline ok)", () => {
		expect(nodeTexts("$$x+y$$", "Math")).toEqual(["$$x+y$$"]);
		expect(nodeTexts("$$ a\nb\nc $$", "Math")).toEqual(["$$ a\nb\nc $$"]);
	});

	it("does not treat currency/escaped/spaced $ as math", () => {
		expect(hasNode("price $5 and $6", "Math")).toBe(false);
		expect(hasNode("\\$x\\$", "Math")).toBe(false);
		expect(hasNode("$ spaced $", "Math")).toBe(false);
	});

	it("keeps math content unparsed (no inline markdown inside)", () => {
		// bold sigils inside math stay literal
		expect(nodeTexts("$**bold**$", "Math")).toEqual(["$**bold**$"]);
		expect(hasNode("$**bold**$", "StrongEmphasis")).toBe(false);
	});

	it("keeps indented code styled as code with markdown unparsed", () => {
		const doc = "    indented #tag";
		expect(hasNode(doc, "CodeBlock")).toBe(true);
		expect(hasNode(doc, "CodeText")).toBe(true);
		// the #tag inside indented code is not parsed as a taxonomy Tag
		expect(hasNode(doc, "Tag")).toBe(false);
	});

	it("keeps mermaid fences as plain code (no render, CodeInfo label preserved)", () => {
		const doc = "```mermaid\ngraph LR\n```";
		expect(hasNode(doc, "FencedCode")).toBe(true);
		expect(nodeTexts(doc, "CodeInfo")).toEqual(["mermaid"]);
		expect(hasNode(doc, "Math")).toBe(false);
	});
});