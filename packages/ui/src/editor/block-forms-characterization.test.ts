import "../../../../tests/contract/rune-setup";
import { describe, it, expect, beforeAll, mock } from "bun:test";
import { EditorState } from "@codemirror/state";
import { syntaxTree, LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { ViewPlugin } from "@codemirror/view";
import { insertEmptyMarkdownTable } from "codemirror-markdown-tables";
import { LanguageLabelWidget } from "./widgets/LanguageLabelWidget";
import { CopyButtonWidget } from "./widgets/CopyButtonWidget";
import { HorizontalRuleWidget } from "./widgets/HorizontalRuleWidget";

// Characterization net for already-covered block forms (S3 #150). Locks the
// external, observable behavior of blockquote styling, fenced-code language
// labels + copy, pipe-table alignment/in-cell formatting/tooling, and
// horizontal-rule widgets so S3 work cannot regress them. Tests only.

let getLanguageExtensions: any;
let blockquotePlugin: ViewPlugin<any>;
let codeBlockPlugin: ViewPlugin<any>;
let horizontalRulePlugin: ViewPlugin<any>;
let hideMarkersPlugin: ViewPlugin<any>;

beforeAll(async () => {
	mock.module("svelte/reactivity", () => ({
		SvelteMap: Map,
		SvelteSet: Set,
	}));
	const mod = await import("./index");
	getLanguageExtensions = mod.getLanguageExtensions;
	blockquotePlugin = mod.blockquotePlugin;
	codeBlockPlugin = mod.codeBlockPlugin;
	horizontalRulePlugin = mod.horizontalRulePlugin;
	hideMarkersPlugin = mod.hideMarkersPlugin;
});

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

async function makeState(doc: string): Promise<EditorState> {
	const desc = languages.find((l) => l.name === "Markdown")!;
	const exts: any[] = await getLanguageExtensions(desc);
	// Only the language support drives parsing; the view plugins are instantiated
	// directly below against a mock view so no DOM is needed.
	const support = exts.filter((e: any) => e instanceof LanguageSupport);
	return EditorState.create({ doc, extensions: support });
}

function mockView(state: EditorState, selectionFrom = 0, hasFocus = false) {
	return {
		state,
		hasFocus,
		visibleRanges: [{ from: 0, to: state.doc.length }],
		selection: { main: { from: selectionFrom, to: selectionFrom } },
	};
}

function kinds(state: EditorState): string[] {
	const out: string[] = [];
	syntaxTree(state).iterate({
		enter: (n: any) => {
			out.push(n.name);
		},
	});
	return out;
}

/** Node text of every node matching `name`, in document order. */
function textsOf(state: EditorState, name: string): string[] {
	const out: string[] = [];
	syntaxTree(state).iterate({
		from: 0,
		to: state.doc.length,
		enter: (n: any) => {
			if (n.name === name) out.push(state.doc.sliceString(n.from, n.to));
		},
	});
	return out;
}

function lineDecorations(plugin: ViewPlugin<any>, state: EditorState): string[] {
	const inst: any = plugin.create(mockView(state), undefined);
	const classes: string[] = [];
	inst.decorations.between(
		0,
		state.doc.length,
		(_f: number, _t: number, d: any) => {
			if (d.spec?.class) {
				d.spec.class.split(" ").forEach((c: string) =>
					classes.push(c),
				);
			}
		},
	);
	return classes;
}

type Decoded =
	| { kind: "line"; classes: string; from: number; to: number }
	| { kind: "widget"; ctor: string; lang?: string; text?: string; from: number; to: number };

function decodeDecorations(
	plugin: ViewPlugin<any>,
	state: EditorState,
	selectionFrom = 0,
	hasFocus = false,
): Decoded[] {
	const inst: any = plugin.create(
		mockView(state, selectionFrom, hasFocus),
		undefined,
	);
	const out: Decoded[] = [];
	inst.decorations.between(0, state.doc.length, (f: number, t: number, d: any) => {
		const spec = d.spec;
		if (spec?.widget) {
			const w = spec.widget;
			if (w instanceof LanguageLabelWidget)
				out.push({
					kind: "widget",
					ctor: "LanguageLabelWidget",
					lang: w.lang,
					from: f,
					to: t,
				});
			else if (w instanceof CopyButtonWidget)
				out.push({
					kind: "widget",
					ctor: "CopyButtonWidget",
					text: w.text,
					from: f,
					to: t,
				});
			else if (w instanceof HorizontalRuleWidget)
				out.push({ kind: "widget", ctor: "HorizontalRuleWidget", from: f, to: t });
			else out.push({ kind: "widget", ctor: "other", from: f, to: t });
		} else if (spec?.class != null) {
			out.push({ kind: "line", classes: spec.class, from: f, to: t });
		}
	});
	return out;
}

// ---------------------------------------------------------------------------
// Blockquote styling
// ---------------------------------------------------------------------------

describe("blockquote styling", () => {
	it("parses > lines as Blockquote with a QuoteMark", async () => {
		const state = await makeState("> quoted line");
		expect(kinds(state)).toEqual([
			"Document",
			"Blockquote",
			"QuoteMark",
			"Paragraph",
		]);
	});

	it("covers every quoted line with the cm-blockquote line class", async () => {
		// A blank line closes the blockquote so `not a quote` is not a lazy
		// continuation paragraph still inside the quote.
		const state = await makeState("> one\n> two\n\nnot a quote");
		expect(lineDecorations(blockquotePlugin, state).filter((c) => c === "cm-blockquote"))
			.toHaveLength(2);
	});

	it("applies cm-blockquote to nested quotes", async () => {
		const state = await makeState("> outer\n> > inner");
		expect(lineDecorations(blockquotePlugin, state)).toContain("cm-blockquote");
	});
});

// ---------------------------------------------------------------------------
// Fenced code: language labels + copy behavior
// ---------------------------------------------------------------------------

describe("fenced code language labels + copy", () => {
	const code = "```python\nprint(\"hello\")\n```";

	it("parses as FencedCode with CodeInfo, CodeText and CodeMark", async () => {
		const state = await makeState(code);
		const ks = kinds(state);
		expect(ks).toContain("FencedCode");
		expect(ks).toContain("CodeInfo");
		expect(ks).toContain("CodeText");
		expect(ks).toContain("CodeMark");
	});

	it("exposes the language via the CodeInfo text", async () => {
		const state = await makeState(code);
		expect(textsOf(state, "CodeInfo")).toEqual(["python"]);
	});

	it("places a copy button carrying exactly the fenced inner lines", async () => {
		const state = await makeState(code);
		const deco = decodeDecorations(codeBlockPlugin, state);
		const copies = deco.filter((d) => d.ctor === "CopyButtonWidget");
		expect(copies).toHaveLength(1);
		expect(copies[0].text).toBe('print("hello")');
	});

	it("marks the fence top/line/bottom with cm-fencedCode classes", async () => {
		const state = await makeState("```ts\nconst a = 1;\nconst b = 2;\n```");
		const classes = lineDecorations(codeBlockPlugin, state);
		expect(classes).toContain("cm-fencedCode");
		expect(classes).toContain("cm-fencedCode-top");
		expect(classes).toContain("cm-fencedCode-line");
		expect(classes).toContain("cm-fencedCode-bottom");
	});

	it("replaces the unfocused fence label with a LanguageLabelWidget per language", async () => {
		for (const lang of ["python", "javascript", "mermaid", "math"]) {
			const state = await makeState("```" + lang + "\nbody\n```");
			const deco = decodeDecorations(hideMarkersPlugin, state);
			const labels = deco.filter((d) => d.ctor === "LanguageLabelWidget");
			expect(labels).toHaveLength(1);
			expect(labels[0].lang).toBe(lang);
		}
	});

	it("shows no language label for a fence without an info string", async () => {
		const state = await makeState("```\nplain\n```");
		const deco = decodeDecorations(hideMarkersPlugin, state);
		expect(deco.filter((d) => d.ctor === "LanguageLabelWidget")).toHaveLength(0);
	});

	it("still copies body under a 4-backtick fence", async () => {
		const state = await makeState("````md\n# title\n````");
		const ks = kinds(state);
		expect(ks).toContain("FencedCode");
		expect(textsOf(state, "CodeInfo")).toEqual(["md"]);
		const copies = decodeDecorations(codeBlockPlugin, state).filter(
			(d) => d.ctor === "CopyButtonWidget",
		);
		expect(copies).toHaveLength(1);
		expect(copies[0].text).toBe("# title");
	});
});

// ---------------------------------------------------------------------------
// Pipe tables: alignment + in-cell formatting + tooling
// ---------------------------------------------------------------------------

describe("pipe-table alignment + in-cell formatting + tooling", () => {
	const table = [
		"| a | b | c |",
		"| :--- | :---: | ---: |",
		"| **bold** | [link](u) | `code` |",
	].join("\n");

	it("parses as Table with header, rows, cells and delimiters", async () => {
		const state = await makeState(table);
		const ks = kinds(state);
		expect(ks).toContain("Table");
		expect(ks).toContain("TableHeader");
		expect(ks).toContain("TableRow");
		expect(ks).toContain("TableCell");
		expect(ks).toContain("TableDelimiter");
	});

	it("preserves alignment delimiter source (:---, :---:, ---:)", async () => {
		const state = await makeState(table);
		expect(textsOf(state, "TableDelimiter")).toContain(
			"| :--- | :---: | ---: |",
		);
	});

	it("parses bold, link and code formatting inside cells", async () => {
		const state = await makeState(table);
		const ks = kinds(state);
		expect(textsOf(state, "TableCell")).toContain("**bold**");
		expect(ks).toContain("StrongEmphasis");
		expect(ks).toContain("Link");
		expect(ks).toContain("InlineCode");
	});

	it("table tooling inserts a 2x2 table skeleton via the editor command", async () => {
		const state = await makeState("");
		const cmd = insertEmptyMarkdownTable({ size: { rows: 2, cols: 2 } });
		let next = state;
		const ok = cmd({
			state,
			dispatch: (tr: any) => {
				next = tr.state;
			},
		});
		expect(ok).toBe(true);
		expect(next.doc.toString()).toBe([
			"",
			"|   |   |",
			"| - | - |",
			"|   |   |",
			"",
		].join("\n"));
	});
});

// ---------------------------------------------------------------------------
// Horizontal-rule widgets + HR vs Setext disambiguation
// ---------------------------------------------------------------------------

describe("horizontal-rule widgets", () => {
	it("parses ---, *** and ___ each as a HorizontalRule", async () => {
		for (const src of ["---", "***", "___"]) {
			const ks = kinds(await makeState(src));
			expect(ks).toContain("HorizontalRule");
		}
	});

	it("replaces the inactive rule line with a HorizontalRuleWidget", async () => {
		const state = await makeState("a\n\n---\n\nb");
		const deco = decodeDecorations(horizontalRulePlugin, state, 0, true);
		expect(deco.some((d) => d.ctor === "HorizontalRuleWidget")).toBe(true);
		expect(deco.some((d) => d.kind === "line" && /cm-hr-line/.test(d.classes))).toBe(
			true,
		);
	});

	it("shows the source line instead of the widget when active/focused", async () => {
		const state = await makeState("---");
		const deco = decodeDecorations(horizontalRulePlugin, state, 0, true);
		expect(deco.some((d) => d.ctor === "HorizontalRuleWidget")).toBe(false);
		expect(
			deco.some((d) => d.kind === "line" && /cm-horizontal-rule-active/.test(d.classes)),
		).toBe(true);
	});

	describe("--- HR vs Setext-underline disambiguation", () => {
		it("treats a lone --- on its own line as a HorizontalRule", async () => {
			const ks = kinds(await makeState("---"));
			expect(ks).toContain("HorizontalRule");
			expect(ks).not.toContain("SetextHeading2");
		});

		it("treats --- directly under text as a Setext H2 underline", async () => {
			const ks = kinds(await makeState("Heading\n---"));
			expect(ks).toContain("SetextHeading2");
			expect(ks).toContain("HeaderMark");
			expect(ks).not.toContain("HorizontalRule");
		});

		it("only --- (not *** / ___) is a Setext H2 underline under text", async () => {
			// `---` under a paragraph is a Setext H2 underline, but `***`/`___`
			// stay HorizontalRules; `===` is the Setext H1 underline.
			expect(kinds(await makeState("Heading\n==="))).toContain("SetextHeading1");
			expect(kinds(await makeState("Heading\n***"))).toContain("HorizontalRule");
			expect(kinds(await makeState("Heading\n___"))).toContain("HorizontalRule");
			expect(kinds(await makeState("Heading\n***"))).not.toContain("SetextHeading2");
		});

		it("pins the frontmatter precedence boundary: --- at document start is still a HorizontalRule today", async () => {
			// #155 changes this boundary: a leading --- fence will become frontmatter.
			// Until then, characterize the current precedence explicitly so #155 must
			// flip this assertion.
			const ks = kinds(await makeState("---\ntag: value"));
			expect(ks).toContain("HorizontalRule");
			expect(ks).not.toContain("FencedCode");
		});
	});
});