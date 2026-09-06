import "../../../../tests/contract/rune-setup";
import { describe, it, expect, beforeAll, mock } from "bun:test";
import { EditorState } from "@codemirror/state";
import { syntaxTree, LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { ViewPlugin } from "@codemirror/view";

// Characterization tests for Sprint 3 block forms:
//   #151: Callout blocks
//   #152: Fenced code blocks
//   #153: Pipe tables
//   #154: Callout fold + nesting

let getLanguageExtensions: any;
let calloutPlugin: ViewPlugin<any>;
let codeBlockPlugin: ViewPlugin<any>;
let hideMarkersPlugin: ViewPlugin<any>;
let calloutFoldField: any;
let toggleCalloutFoldEffect: any;

beforeAll(async () => {
	mock.module("svelte/reactivity", () => ({
		SvelteMap: Map,
		SvelteSet: Set,
	}));
	const mod = await import("./index");
	getLanguageExtensions = mod.getLanguageExtensions;
	calloutPlugin = mod.calloutPlugin;
	codeBlockPlugin = mod.codeBlockPlugin;
	hideMarkersPlugin = mod.hideMarkersPlugin;
	calloutFoldField = mod.calloutFoldField;
	const calloutExtMod = await import("./extensions/callout");
	toggleCalloutFoldEffect = calloutExtMod.toggleCalloutFoldEffect;
});

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
			out.push({
				kind: "widget",
				ctor: w.constructor.name,
				lang: (w as any).lang,
				text: (w as any).text,
				from: f,
				to: t,
			});
		} else if (spec?.class) {
			out.push({ kind: "line", classes: spec.class, from: f, to: t });
		}
	});
	return out;
}

// ---------------------------------------------------------------------------
// Callouts: baseline, nesting, aliases, fold state
// ---------------------------------------------------------------------------

describe("callout base parsing and styling", () => {
	const doc = "> [!note] Title\n> body content";

	it("parses Callout header without polluting AST with Link nodes", async () => {
		const state = await makeState(doc);
		const ks = kinds(state);
		expect(ks).toContain("Callout");
		expect(ks).toContain("CalloutMark");
		expect(ks).toContain("CalloutType");
		expect(ks).not.toContain("Link");
	});

	it("accents all callout lines with cm-callout and cm-callout-note", async () => {
		const state = await makeState(doc);
		const classes = lineDecorations(calloutPlugin, state);
		expect(classes).toContain("cm-callout");
		expect(classes).toContain("cm-callout-note");
	});

	it("falls back to a plain quote for unknown type", async () => {
		const state = await makeState("> [!unknown] title\n> text");
		const classes = lineDecorations(calloutPlugin, state);
		expect(classes).not.toContain("cm-callout");
	});

	it("nests depth by blockquote hierarchy", async () => {
		const nested = "> > [!warning] nested warning\n> > inside";
		const state = await makeState(nested);
		const classes = lineDecorations(calloutPlugin, state);
		expect(classes).toContain("cm-callout-nested");
		expect(classes).toContain("cm-callout-warning");
	});

	it("canonicalizes aliases (e.g. caution -> warning, tldr -> abstract)", async () => {
		const caution = await makeState("> [!caution] careful");
		expect(lineDecorations(calloutPlugin, caution)).toContain("cm-callout-warning");

		const tldr = await makeState("> [!tldr] summary");
		expect(lineDecorations(calloutPlugin, tldr)).toContain("cm-callout-abstract");
	});
});

// ---------------------------------------------------------------------------
// Fenced code blocks: language tag, copy button, line styling
// ---------------------------------------------------------------------------

describe("fenced code block enhancements", () => {
	const code = "```python\nprint(\"hello\")\n```";

	it("parses FencedCode with CodeInfo and CodeText intact", async () => {
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
		const copies = deco.filter(
			(d): d is Extract<Decoded, { kind: "widget" }> =>
				d.kind === "widget" && d.ctor === "CopyButtonWidget",
		);
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
			const labels = deco.filter(
				(d): d is Extract<Decoded, { kind: "widget" }> =>
					d.kind === "widget" && d.ctor === "LanguageLabelWidget",
			);
			expect(labels).toHaveLength(1);
			expect(labels[0].lang).toBe(lang);
		}
	});

	it("shows no language label for a fence without an info string", async () => {
		const state = await makeState("```\nplain\n```");
		const deco = decodeDecorations(hideMarkersPlugin, state);
		expect(
			deco.filter((d) => d.kind === "widget" && d.ctor === "LanguageLabelWidget"),
		).toHaveLength(0);
	});

	it("still copies body under a 4-backtick fence", async () => {
		const state = await makeState("````md\n# title\n````");
		const ks = kinds(state);
		expect(ks).toContain("FencedCode");
		expect(textsOf(state, "CodeInfo")).toEqual(["md"]);
		const copies = decodeDecorations(codeBlockPlugin, state).filter(
			(d): d is Extract<Decoded, { kind: "widget" }> =>
				d.kind === "widget" && d.ctor === "CopyButtonWidget",
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

	it("parses in-cell Markdown (strong, link, inline code) inside cells", async () => {
		const state = await makeState(table);
		const ks = kinds(state);
		expect(ks).toContain("StrongEmphasis");
		expect(ks).toContain("Link");
		expect(ks).toContain("InlineCode");
	});

	it("exposes table text without dropping cell pipes", async () => {
		const state = await makeState(table);
		expect(state.doc.toString()).toBe(table);
	});
});
