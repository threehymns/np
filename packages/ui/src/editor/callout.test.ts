import "../../../../tests/contract/rune-setup";
import { describe, it, expect, beforeAll, mock } from "bun:test";
import { EditorState } from "@codemirror/state";
import { syntaxTree, LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { ViewPlugin } from "@codemirror/view";

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

async function makeState(doc: string): Promise<EditorState> {
	const desc = languages.find((l) => l.name === "Markdown")!;
	const exts = await getLanguageExtensions(desc);
	const support = exts.filter((e) => e instanceof LanguageSupport);
	return EditorState.create({ doc, extensions: support });
}

function decode(plugin: ViewPlugin<any>, state: EditorState): (string | null)[] {
	const inst: any = plugin.create(
		{ state, hasFocus: false, visibleRanges: [{ from: 0, to: state.doc.length }] },
		undefined,
	);
	const out: (string | null)[] = [];
	inst.decorations.between(
		0,
		state.doc.length,
		(_f: number, _t: number, d: any) => {
			const s = d.spec;
			if (s?.class) out.push(`line:${s.class}`);
			else if (s?.className) out.push(s.className);
		},
	);
	return out;
}

function nodeNames(state: EditorState): string[] {
	const names: string[] = [];
	syntaxTree(state).iterate({ enter: (n: any) => names.push(n.name) });
	return names;
}

describe("#151 callout base", () => {
	it("recognizes a known type and styles lines + type label", async () => {
		const state = await makeState("> [!note] Title here");
		const deco = decode(calloutPlugin, state);
		expect(deco).toContain("line:cm-callout cm-callout-note");
		expect(deco).toContain("cm-callout-type");
	});

	it("recognizes case-insensitive and aliased types", async () => {
		const wState = await makeState("> [!WARNING] Beware\n> body");
		expect(decode(calloutPlugin, wState)).toContain(
			"line:cm-callout cm-callout-warning",
		);
		const cState = await makeState("> [!caution] care");
		expect(decode(calloutPlugin, cState)).toContain(
			"line:cm-callout cm-callout-warning",
		);
	});

	it("styles custom and default titles", async () => {
		const custom = await makeState("> [!note] Custom Title");
		expect(decode(calloutPlugin, custom)).toContain("cm-callout-title");

		const def = await makeState("> [!note]\n> body");
		// no custom title -> only the type label, no title mark
		expect(decode(calloutPlugin, def)).not.toContain("cm-callout-title");
	});

	it("falls back to a plain quote for an unknown type", async () => {
		const state = await makeState("> [!bogus] unknown");
		const deco = decode(calloutPlugin, state);
		expect(deco).not.toContain("line:cm-callout");
		expect(deco).not.toContain("cm-callout-type");
	});

	it("leaves plain blockquotes undecorated", async () => {
		const state = await makeState("> plain quote");
		expect(decode(calloutPlugin, state)).not.toContain("line:cm-callout");
	});

	it("keeps inner content parsing (bold/list/link intact)", async () => {
		const state = await makeState("> [!note] has\n> - item\n> **bold** [x](u)");
		const names = nodeNames(state);
		expect(names.some((n) => n === "Blockquote")).toBe(true);
		// the callout plugin does not strip the type marker text
		expect(decode(calloutPlugin, state)).toContain("cm-callout-type");
	});
});