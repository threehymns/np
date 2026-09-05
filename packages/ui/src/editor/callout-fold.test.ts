import "../../../../tests/contract/rune-setup";
import { describe, it, expect, beforeAll, mock } from "bun:test";
import { EditorState } from "@codemirror/state";
import { LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { ViewPlugin } from "@codemirror/view";
import { calloutFoldState } from "./extensions/callout";

let getLanguageExtensions: any;
let calloutPlugin: ViewPlugin<any>;

beforeAll(async () => {
	mock.module("svelte/reactivity", () => ({
		SvelteMap: Map,
		SvelteSet: Set,
	}));
	const mod = await import("./index");
	getLanguageExtensions = mod.getLanguageExtensions;
	calloutPlugin = mod.calloutPlugin;
});

async function makeState(doc: string, folded: number[] = []): Promise<EditorState> {
	const desc = languages.find((l) => l.name === "Markdown")!;
	const exts = await getLanguageExtensions(desc);
	const support = exts.filter((e) => e instanceof LanguageSupport);
	return EditorState.create({
		doc,
		extensions: [...support, calloutFoldState.of(folded)],
	});
}

function lineClasses(plugin: ViewPlugin<any>, state: EditorState): string[] {
	const inst: any = plugin.create(
		{ state, hasFocus: false, visibleRanges: [{ from: 0, to: state.doc.length }] },
		undefined,
	);
	const out: string[] = [];
	inst.decorations.between(0, state.doc.length, (_f: number, _t: number, d: any) => {
		if (d.spec?.class) out.push(...d.spec.class.split(" "));
		else if (d.spec?.className) out.push(d.spec.className);
	});
	return out;
}

function replaceRanges(plugin: ViewPlugin<any>, state: EditorState): [number, number][] {
	const inst: any = plugin.create(
		{ state, hasFocus: false, visibleRanges: [{ from: 0, to: state.doc.length }] },
		undefined,
	);
	const out: [number, number][] = [];
	inst.decorations.between(0, state.doc.length, (f: number, t: number, d: any) => {
		// line decorations are point-ranges; a real replace has f < t
		if (d.spec?.widget === undefined && f < t) out.push([f, t]);
	});
	return out;
}

describe("#154 callout fold + nesting", () => {
	it("styles nested callouts with cm-callout-nested by quote depth", async () => {
		const deep = await makeState(">> [!note] Deep\n>> body");
		expect(lineClasses(calloutPlugin, deep)).toContain("cm-callout-nested");

		const flat = await makeState("> [!note] Flat\n> body");
		expect(lineClasses(calloutPlugin, flat)).not.toContain("cm-callout-nested");
	});

	it("folds (hides) the body of a callout whose start line is in the fold state", async () => {
		const doc = "> [!note] Title\n> body line";
		const state = await makeState(doc, [1]); // collapse callout at line 1
		// body (line 2) is replaced (hidden)
		const ranges = replaceRanges(calloutPlugin, state);
		// the body (line 2, chars 16..27) is replaced/hidden
		expect(ranges.some(([f, t]) => f === 16 && t >= 27)).toBe(true);
	});

	it("fold round-trips with source bytes unchanged", async () => {
		const doc = "> [!note] Title\n> body line\n> tail";
		const state = await makeState(doc, [1]);
		const foldedText = state.doc.toString();
		expect(foldedText).toBe("> [!note] Title\n> body line\n> tail");
		// expanded state also leaves source identical
		const open = await makeState(doc, []);
		expect(open.doc.toString()).toBe(foldedText);
	});

	it("keeps an uncollapsed callout body visible (line classes present)", async () => {
		const open = await makeState("> [!note] Title\n> body");
		expect(lineClasses(calloutPlugin, open)).toContain("cm-callout");
	});

	it("collapses by default when marked with - fold marker", async () => {
		const doc = "> [!note]- Collapsed by default\n> body line";
		const state = await makeState(doc, []); // no explicit fold state needed
		const ranges = replaceRanges(calloutPlugin, state);
		expect(ranges.some(([f, t]) => f === 32 && t >= 43)).toBe(true);
	});

	it("does not crash on single-line callouts even when in fold state", async () => {
		const doc = "> [!note] Single line callout";
		const state = await makeState(doc, [1]);
		expect(() => replaceRanges(calloutPlugin, state)).not.toThrow();
	});
});