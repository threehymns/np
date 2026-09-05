import { describe, it, expect } from "bun:test";
import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { Table, GFM } from "@lezer/markdown";
import { WikiLinkExtension } from "./wikilinks";

/**
 * S1 characterization net (#142).
 *
 * Locks already-covered inline forms so later S1–S3 work can't regress them.
 * Headless parse-tree only — no production-code change, no EditorView.
 *
 * Production stack under test: markdown({ extensions: [Table, GFM, WikiLinkExtension] })
 * which is the sole Markdown language (see editor/index.ts).
 */

function mdState(doc: string): EditorState {
	const mdExt = markdown({
		extensions: [Table, GFM, WikiLinkExtension] as any,
	});
	return EditorState.create({ doc, extensions: [mdExt] });
}

function nodeNames(doc: string): string[] {
	const state = mdState(doc);
	const kinds: string[] = [];
	syntaxTree(state).iterate({
		enter: (n: any) => {
			kinds.push(n.name);
		},
	});
	return kinds;
}

function nodeTexts(doc: string, name: string): string[] {
	const state = mdState(doc);
	const out: string[] = [];
	syntaxTree(state).iterate({
		enter: (n: any) => {
			if (n.name === name) out.push(state.doc.sliceString(n.from, n.to));
		},
	});
	return out;
}

describe("S1 net: bold / italic / both", () => {
	it("**bold** parses to StrongEmphasis with EmphasisMarks", () => {
		const kinds = nodeNames("**bold**");
		expect(kinds).toContain("StrongEmphasis");
		expect(kinds).toContain("EmphasisMark");
		expect(nodeTexts("**bold**", "StrongEmphasis")).toEqual(["**bold**"]);
	});

	it("__bold__ parses to StrongEmphasis", () => {
		const kinds = nodeNames("__bold__");
		expect(kinds).toContain("StrongEmphasis");
		expect(kinds).toContain("EmphasisMark");
	});

	it("*italic* parses to Emphasis with EmphasisMarks", () => {
		const kinds = nodeNames("*italic*");
		expect(kinds).toContain("Emphasis");
		expect(kinds).toContain("EmphasisMark");
		expect(nodeTexts("*italic*", "Emphasis")).toEqual(["*italic*"]);
	});

	it("_italic_ parses to Emphasis", () => {
		const kinds = nodeNames("_italic_");
		expect(kinds).toContain("Emphasis");
		expect(kinds).toContain("EmphasisMark");
	});

	it("***both*** parses to nested Emphasis + StrongEmphasis", () => {
		const kinds = nodeNames("***both***");
		expect(kinds).toContain("Emphasis");
		expect(kinds).toContain("StrongEmphasis");
		expect(kinds).toContain("EmphasisMark");
	});
});

describe("S1 net: ATX + Setext headings", () => {
	it("# H1 parses to ATXHeading1 with HeaderMark", () => {
		const kinds = nodeNames("# H1");
		expect(kinds).toContain("ATXHeading1");
		expect(kinds).toContain("HeaderMark");
		expect(kinds).not.toContain("Paragraph");
	});

	it("###### H6 parses to ATXHeading6", () => {
		const kinds = nodeNames("###### H6");
		expect(kinds).toContain("ATXHeading6");
		expect(kinds).toContain("HeaderMark");
	});

	it("## H2 parses to ATXHeading2", () => {
		expect(nodeNames("## H2")).toContain("ATXHeading2");
	});

	it("Setext === parses to SetextHeading1 with HeaderMark underline", () => {
		const kinds = nodeNames("Title\n===");
		expect(kinds).toContain("SetextHeading1");
		expect(kinds).toContain("HeaderMark");
		expect(nodeTexts("Title\n===", "HeaderMark")).toEqual(["==="]);
	});

	it("Setext --- parses to SetextHeading2 with HeaderMark underline", () => {
		const kinds = nodeNames("Title2\n---");
		expect(kinds).toContain("SetextHeading2");
		expect(kinds).toContain("HeaderMark");
	});
});

describe("S1 net: bullets / ordered / task lists", () => {
	it.each(["-", "*", "+"])("%s bullet parses to BulletList + ListMark", (mark) => {
		const kinds = nodeNames(`${mark} bullet`);
		expect(kinds).toContain("BulletList");
		expect(kinds).toContain("ListItem");
		expect(kinds).toContain("ListMark");
		expect(kinds).toContain("Paragraph");
	});

	it("nested bullets parse to nested BulletLists", () => {
		const kinds = nodeNames("- a\n  - nested");
		expect(kinds.filter((k) => k === "BulletList").length).toBe(2);
		expect(kinds).toContain("ListMark");
	});

	it("1. ordered parses to OrderedList + ListMark", () => {
		const kinds = nodeNames("1. ordered");
		expect(kinds).toContain("OrderedList");
		expect(kinds).toContain("ListItem");
		expect(kinds).toContain("ListMark");
		expect(nodeTexts("1. ordered", "ListMark")).toEqual(["1."]);
	});

	it("1) ordered parses to OrderedList (paren style accepted)", () => {
		const kinds = nodeNames("1) ordered-paren");
		expect(kinds).toContain("OrderedList");
		expect(kinds).toContain("ListMark");
		expect(nodeTexts("1) ordered-paren", "ListMark")).toEqual(["1)"]);
	});

	it("- [ ] task parses to Task + TaskMarker", () => {
		const kinds = nodeNames("- [ ] task");
		expect(kinds).toContain("BulletList");
		expect(kinds).toContain("Task");
		expect(kinds).toContain("TaskMarker");
	});

	it("- [x] done parses to Task + TaskMarker", () => {
		const kinds = nodeNames("- [x] done");
		expect(kinds).toContain("Task");
		expect(kinds).toContain("TaskMarker");
		expect(nodeTexts("- [x] done", "TaskMarker")).toEqual(["[x]"]);
	});
});

describe("S1 net: inline code", () => {
	it("`code` parses to InlineCode with CodeMarks", () => {
		const kinds = nodeNames("`code`");
		expect(kinds).toContain("InlineCode");
		expect(kinds).toContain("CodeMark");
		expect(nodeTexts("`code`", "InlineCode")).toEqual(["`code`"]);
	});

	it("markup inside code spans stays unparsed", () => {
		const kinds = nodeNames("`code with *not emphasis*`");
		expect(kinds).toContain("InlineCode");
		expect(kinds).not.toContain("Emphasis");
		expect(kinds).not.toContain("StrongEmphasis");
	});
});

describe("S1 net: escapes", () => {
	it("\\* parses to Escape, not Emphasis", () => {
		const kinds = nodeNames("\\* not emphasis");
		expect(kinds).toContain("Escape");
		expect(kinds).not.toContain("Emphasis");
		expect(nodeTexts("\\* not emphasis", "Escape")).toEqual(["\\*"]);
	});

	it("\\# parses to Escape", () => {
		const kinds = nodeNames("\\# not heading");
		expect(kinds).toContain("Escape");
	});

	it("escaped bold markers stay literal", () => {
		const kinds = nodeNames("\\*\\*not bold\\*\\*");
		expect(kinds).toContain("Escape");
		expect(kinds).not.toContain("StrongEmphasis");
		expect(kinds).not.toContain("Emphasis");
	});
});

describe("S1 net: hard / soft breaks", () => {
	it("two trailing spaces parse to HardBreak", () => {
		const kinds = nodeNames("line  \nbreak");
		expect(kinds).toContain("HardBreak");
	});

	it("backslash newline parses to HardBreak", () => {
		const kinds = nodeNames("line\\\nbreak");
		expect(kinds).toContain("HardBreak");
	});

	it("single newline is a soft break with no HardBreak node", () => {
		const kinds = nodeNames("line\nbreak");
		expect(kinds).toContain("Paragraph");
		expect(kinds).not.toContain("HardBreak");
	});
});

describe("S1 net: autolinks", () => {
	it("<https://example.com> parses to Autolink with URL and LinkMarks", () => {
		const kinds = nodeNames("<https://example.com>");
		expect(kinds).toContain("Autolink");
		expect(kinds).toContain("URL");
		expect(kinds).toContain("LinkMark");
	});

	it("bare https:// URL parses to URL (GFM Autolink)", () => {
		const kinds = nodeNames("visit https://example.com end");
		expect(kinds).toContain("URL");
		expect(nodeTexts("visit https://example.com end", "URL")).toEqual([
			"https://example.com",
		]);
	});

	it("bare www. URL parses to URL", () => {
		const kinds = nodeNames("visit www.example.com end");
		expect(kinds).toContain("URL");
	});
});

describe("S1 net: HTML passthrough (Markdown inside HTML blocks unparsed)", () => {
	it("<div> block parses to HTMLBlock", () => {
		expect(nodeNames("<div>\n**not bold**\n</div>")).toContain("HTMLBlock");
	});

	it("Markdown inside an HTML block stays unparsed", () => {
		const kinds = nodeNames("<div>\n**not bold**\n</div>");
		expect(kinds).toContain("HTMLBlock");
		expect(kinds).not.toContain("StrongEmphasis");
		expect(kinds).not.toContain("Emphasis");
		expect(kinds).not.toContain("Paragraph");
	});

	it("inline <br> parses to HTMLTag or HTMLBlock passthrough", () => {
		const kinds = nodeNames("a <br> b");
		expect(kinds.some((k) => k === "HTMLTag" || k === "HTMLBlock")).toBe(
			true,
		);
		expect(kinds).not.toContain("HardBreak");
	});

	it("inline <u>/<sub>/<sup> tags pass through as HTMLTag", () => {
		expect(nodeNames("Text <u>underline</u> more")).toContain("HTMLTag");
		expect(nodeNames("x <sub>y</sub> z")).toContain("HTMLTag");
		expect(nodeNames("x <sup>y</sup> z")).toContain("HTMLTag");
	});
});

describe("S1 net: HTML comments", () => {
	it("standalone <!-- --> parses to CommentBlock", () => {
		expect(nodeNames("<!-- hidden -->")).toContain("CommentBlock");
	});

	it("inline <!-- --> parses to Comment", () => {
		expect(nodeNames("text <!-- hi --> text")).toContain("Comment");
	});
});

describe("S1 net: direct emoji, no :shortcode: expansion", () => {
	it("direct unicode emoji stays plain paragraph text (no Emoji node)", () => {
		const kinds = nodeNames("hello 🎉 world");
		expect(kinds).toContain("Paragraph");
		expect(kinds).not.toContain("Emoji");
	});

	it(":smile: stays plain text (Emoji extension not enabled)", () => {
		const kinds = nodeNames(":smile:");
		expect(kinds).toEqual(["Document", "Paragraph"]);
		expect(kinds).not.toContain("Emoji");
	});

	it(":: double colon stays plain text", () => {
		const kinds = nodeNames(":: double colon");
		expect(kinds).toEqual(["Document", "Paragraph"]);
		expect(kinds).not.toContain("Emoji");
	});
});

describe("S1 net: deliberate non-enablement of Subscript / Superscript", () => {
	it("~sub~ stays plain text (no Subscript node)", () => {
		const kinds = nodeNames("~sub~");
		expect(kinds).toEqual(["Document", "Paragraph"]);
		expect(kinds).not.toContain("Subscript");
		expect(kinds).not.toContain("Strikethrough");
	});

	it("H~2~O stays plain text", () => {
		const kinds = nodeNames("H~2~O");
		expect(kinds).toEqual(["Document", "Paragraph"]);
		expect(kinds).not.toContain("Subscript");
	});

	it("^sup^ stays plain text (no Superscript node)", () => {
		const kinds = nodeNames("^sup^");
		expect(kinds).toEqual(["Document", "Paragraph"]);
		expect(kinds).not.toContain("Superscript");
	});

	it("x^2^ stays plain text", () => {
		const kinds = nodeNames("x^2^");
		expect(kinds).toEqual(["Document", "Paragraph"]);
		expect(kinds).not.toContain("Superscript");
	});
});
