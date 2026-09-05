import "../../../../tests/contract/rune-setup";
import { describe, it, expect, beforeAll, mock } from "bun:test";
import { EditorState } from "@codemirror/state";
import { LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { ViewPlugin } from "@codemirror/view";
import { getHeadings } from "@np/core/links";

let getLanguageExtensions: any;
let frontmatterPlugin: ViewPlugin<any>;
let horizontalRulePlugin: ViewPlugin<any>;

beforeAll(async () => {
	mock.module("svelte/reactivity", () => ({
		SvelteMap: Map,
		SvelteSet: Set,
	}));
	const mod = await import("./index");
	getLanguageExtensions = mod.getLanguageExtensions;
	frontmatterPlugin = mod.frontmatterPlugin;
	horizontalRulePlugin = mod.horizontalRulePlugin;
});

async function makeState(doc: string): Promise<EditorState> {
	const desc = languages.find((l) => l.name === "Markdown")!;
	const exts = await getLanguageExtensions(desc);
	const support = exts.filter((e) => e instanceof LanguageSupport);
	return EditorState.create({ doc, extensions: support });
}

function lineClasses(plugin: ViewPlugin<any>, state: EditorState): string[] {
	const inst: any = plugin.create(
		{ state, hasFocus: false, visibleRanges: [{ from: 0, to: state.doc.length }] },
		undefined,
	);
	const out: string[] = [];
	inst.decorations.between(0, state.doc.length, (_f: number, _t: number, d: any) => {
		if (d.spec?.class) out.push(d.spec.class);
	});
	return out;
}

describe("#155 leading YAML frontmatter", () => {
	it("dims a closed frontmatter block (fence + keys)", async () => {
		const state = await makeState("---\ntags: [a]\n---\n# Hi");
		expect(lineClasses(frontmatterPlugin, state).filter((c) => c === "md-faded").length).toBe(
			3,
		);
	});

	it("does not widgetify the frontmatter --- fences (HR plugin skips them)", async () => {
		const state = await makeState("---\ntags: [a]\n---\n# Hi");
		expect(lineClasses(horizontalRulePlugin, state)).not.toContain("cm-hr-line");
	});

	it("keeps unclosed leading --- as a HorizontalRule (per #150)", async () => {
		const open = await makeState("---\ntag: value");
		expect(lineClasses(frontmatterPlugin, open)).not.toContain("md-faded");
		expect(lineClasses(horizontalRulePlugin, open)).toContain("cm-hr-line");
	});

	it("leaves a mid-document --- as a real HorizontalRule", async () => {
		const mid = await makeState("line\n\n---\nmore");
		expect(lineClasses(frontmatterPlugin, mid)).not.toContain("md-faded");
		expect(lineClasses(horizontalRulePlugin, mid)).toContain("cm-hr-line");
	});

	it("extraction (headings) skips the frontmatter block", () => {
		const headings = getHeadings("---\n# NotAHeading\ntags: [a]\n---\n# Real");
		expect(headings.map((h) => h.text)).toEqual(["Real"]);
		expect(headings.map((h) => h.text)).not.toContain("NotAHeading");
	});
});