import "../../../../tests/contract/rune-setup";
import { describe, it, expect, beforeAll, mock } from "bun:test";
import { EditorState } from "@codemirror/state";
import { syntaxTree, LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { ViewPlugin } from "@codemirror/view";

let getLanguageExtensions: any;
let calloutPlugin: ViewPlugin<any>;
let iconRegistry: any;

beforeAll(async () => {
	mock.module("svelte/reactivity", () => ({
		SvelteMap: Map,
		SvelteSet: Set,
	}));
	const mod = await import("./index");
	getLanguageExtensions = mod.getLanguageExtensions;
	calloutPlugin = mod.calloutPlugin;
	const iconMod = await import("./icons.svelte");
	iconRegistry = iconMod.iconRegistry;
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
			if (s?.attributes?.title) {
				out.push(`title:${s.attributes.title}`);
			}
			if (s?.class?.startsWith("cm-callout-")) out.push(s.class);
			else if (s?.class) out.push(`line:${s.class}`);
			else if (s?.className) out.push(s.className);
			if (s?.widget) {
				out.push(`widget:${s.widget.constructor.name}:${s.widget.type}`);
			}
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
	it("parses callout header as Callout AST node, never as Link", async () => {
		const state = await makeState("> [!note] Title here");
		const names = nodeNames(state);
		expect(names).toContain("Callout");
		expect(names).toContain("CalloutType");
		expect(names).toContain("CalloutMark");
		// Must not contain Link or LinkMark for [!note]
		expect(names).not.toContain("Link");
		expect(names).not.toContain("LinkMark");
	});

	it("preserves links inside callout title and body while keeping callout header unlinked", async () => {
		const state = await makeState("> [!note] Title with [link](https://example.com)\n> Body with [link2](https://test.com)");
		const names = nodeNames(state);
		expect(names).toContain("Callout");
		expect(names).toContain("CalloutType");
		expect(names).toContain("Link");
		expect(names).toContain("URL");
	});

	it("recognizes a known type and styles lines + type label with tooltip title and icon widget", async () => {
		const state = await makeState("> [!note] Title here");
		const deco = decode(calloutPlugin, state);
		expect(deco).toContain("line:cm-callout cm-callout-note");
		expect(deco).toContain("cm-callout-type");
		expect(deco).toContain("title:Title here");
		expect(deco).toContain("widget:CalloutIconWidget:note");
	});

	it("resolves dynamic icons from iconRegistry for callout types", () => {
		const noteChain = iconRegistry.resolveProductIconChain("note");
		expect(noteChain.length).toBeGreaterThan(0);
		expect(noteChain[0].type).toBe("component");

		const warningChain = iconRegistry.resolveProductIconChain("warning");
		expect(warningChain.length).toBeGreaterThan(0);
		expect(warningChain[0].type).toBe("component");

		const tipChain = iconRegistry.resolveProductIconChain("tip");
		expect(tipChain.length).toBeGreaterThan(0);
		expect(tipChain[0].type).toBe("component");

		const dangerChain = iconRegistry.resolveProductIconChain("danger");
		expect(dangerChain.length).toBeGreaterThan(0);
		expect(dangerChain[0].type).toBe("component");
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
		const fState = await makeState("> [!failure] oops");
		expect(decode(calloutPlugin, fState)).toContain(
			"line:cm-callout cm-callout-failure",
		);
		const failState = await makeState("> [!fail] broken");
		expect(decode(calloutPlugin, failState)).toContain(
			"line:cm-callout cm-callout-failure",
		);
		const missingState = await makeState("> [!missing] lost");
		expect(decode(calloutPlugin, missingState)).toContain(
			"line:cm-callout cm-callout-failure",
		);
	});

	it("recognizes callouts with + and - fold markers", async () => {
		const foldedState = await makeState("> [!note]- Folded Title\n> body");
		expect(decode(calloutPlugin, foldedState)).toContain(
			"line:cm-callout cm-callout-note",
		);
		expect(decode(calloutPlugin, foldedState)).toContain("cm-callout-title");

		const expandedState = await makeState("> [!note]+ Open Title\n> body");
		expect(decode(calloutPlugin, expandedState)).toContain(
			"line:cm-callout cm-callout-note",
		);
		expect(decode(calloutPlugin, expandedState)).toContain("cm-callout-title");
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
		expect(deco.some((d) => d?.includes("cm-callout"))).toBe(false);
		expect(deco).not.toContain("cm-callout-type");
	});

	it("leaves plain blockquotes undecorated", async () => {
		const state = await makeState("> plain quote");
		const deco = decode(calloutPlugin, state);
		expect(deco.some((d) => d?.includes("cm-callout"))).toBe(false);
		expect(deco).toEqual([]);
	});

	it("keeps inner content parsing (bold/list/link intact)", async () => {
		const state = await makeState("> [!note] has\n> - item\n> **bold** [x](u)");
		const names = nodeNames(state);
		expect(names.some((n) => n === "Blockquote")).toBe(true);
		// the callout plugin does not strip the type marker text
		expect(decode(calloutPlugin, state)).toContain("cm-callout-type");
	});

	it("scopes nested callout lines to the inner type with its local color", async () => {
		const state = await makeState(
			"> [!example] Outer callout\n> Content in the outer callout.\n> \n> > [!tip]\n> > Callouts can be nested inside other callouts.",
		);
		const inst: any = calloutPlugin.create(
			{ state, hasFocus: false, visibleRanges: [{ from: 0, to: state.doc.length }] },
			undefined,
		);
		const lineClasses = new Map<number, string[]>();
		inst.decorations.between(0, state.doc.length, (f: number, t: number, d: any) => {
			const cls: string | undefined = d.spec?.class;
			if (cls?.includes("cm-callout") && !cls.includes("type") && !cls.includes("title")) {
				const line = state.doc.lineAt(f === t ? f : f).number;
				lineClasses.set(line, [...(lineClasses.get(line) ?? []), cls]);
			}
		});
		// Outer lines keep the outer accent as a plain shell.
		for (const n of [1, 2, 3]) {
			expect(lineClasses.get(n)).toEqual(["cm-callout cm-callout-example"]);
		}
		// Nested lines carry both roles: outer shell wraps, inner box sits inside.
		for (const n of [4, 5]) {
			expect(lineClasses.get(n)).toEqual([
				"cm-callout cm-callout-nested cm-callout-outer-example cm-callout-inner-tip",
			]);
		}
		// Exactly one line accent per row — no conflicting duplicates.
		for (const n of [1, 2, 3, 4, 5]) {
			expect(lineClasses.get(n)?.length).toBe(1);
		}
	});
});
