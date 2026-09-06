import "../../../../tests/contract/rune-setup";
import { describe, it, expect, beforeAll, mock } from "bun:test";
import { EditorState } from "@codemirror/state";
import { LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { EditorView, type ViewPlugin } from "@codemirror/view";

let getLanguageExtensions: any;
let calloutPlugin: ViewPlugin<any>;
let calloutFoldField: any;
let toggleCalloutFoldEffect: any;

beforeAll(async () => {
	if (typeof globalThis.document === "undefined") {
		class MockElement {
			tagName: string;
			style: Record<string, any> = {};
			childNodes: any[] = [];
			attributes: any[] = [];
			classList = { add: () => {}, remove: () => {}, contains: () => false };
			ownerDocument: any;
			parentNode: any = null;
			constructor(tag = "DIV") {
				this.tagName = tag.toUpperCase();
				this.ownerDocument = globalThis.document;
			}
			setAttribute() {}
			getAttribute() { return null; }
			appendChild(child: any) { child.parentNode = this; this.childNodes.push(child); return child; }
			insertBefore(child: any) { child.parentNode = this; this.childNodes.push(child); return child; }
			removeChild() {}
			remove() {
				if (this.parentNode) {
					this.parentNode = null;
				}
			}
			addEventListener() {}
			removeEventListener() {}
			contains() { return false; }
			getBoundingClientRect() { return { top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 20 }; }
		}

		(globalThis as any).MutationObserver = class {
			observe() {}
			disconnect() {}
			takeRecords() { return []; }
		};
		(globalThis as any).Window = class Window {};
		const head = new MockElement("HEAD");
		(globalThis as any).requestAnimationFrame = () => 0;
		(globalThis as any).cancelAnimationFrame = () => {};
		(globalThis as any).document = {
			head,
			body: new MockElement("BODY"),
			createElement: (tag: string) => new MockElement(tag),
			createDocumentFragment: () => new MockElement("FRAGMENT"),
			createTextNode: (text: string) => ({ nodeValue: text, ownerDocument: globalThis.document }),
			hasFocus: () => false,
			defaultView: globalThis,
			addEventListener: () => {},
			removeEventListener: () => {},
			getSelection: () => null,
			insertBefore: (child: any) => child,
		};
		(globalThis as any).window = {
			...(globalThis as any).window,
			matchMedia: () => ({ matches: false, addListener: () => {}, removeListener: () => {} }),
		};
	}

	mock.module("svelte/reactivity", () => ({
		SvelteMap: Map,
		SvelteSet: Set,
	}));
	const mod = await import("./index");
	getLanguageExtensions = mod.getLanguageExtensions;
	calloutPlugin = mod.calloutPlugin;
	const calloutExtMod = await import("./extensions/callout");
	calloutFoldField = calloutExtMod.calloutFoldField;
	toggleCalloutFoldEffect = calloutExtMod.toggleCalloutFoldEffect;
});

async function makeState(doc: string, folded: number[] = []): Promise<EditorState> {
	const desc = languages.find((l) => l.name === "Markdown")!;
	const exts = await getLanguageExtensions(desc);
	const support = exts.filter((e) => e instanceof LanguageSupport);
	return EditorState.create({
		doc,
		extensions: [...support, calloutPlugin, calloutFoldField.init(() => folded)],
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
		// line decorations are point-ranges; a real replace has f < t and no class
		if (d.spec?.widget === undefined && !d.spec?.class && f < t) out.push([f, t]);
	});
	return out;
}

describe("#154 callout fold + nesting", () => {
	it("styles nested callouts with cm-callout-nested by quote depth", async () => {
		const deep = await makeState(">> [!note] Deep\n>> body");
		expect(lineClasses(calloutPlugin, deep)).toContain("cm-callout-nested");

		const spacedDeep = await makeState("> > [!note] Spaced Deep\n> > body");
		expect(lineClasses(calloutPlugin, spacedDeep)).toContain("cm-callout-nested");

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

	it("updates callout fold field via StateEffect", async () => {
		const doc = "> [!note] Title\n> body line";
		let state = await makeState(doc, []);
		expect(state.field(calloutFoldField)).toEqual([]);

		state = state.update({ effects: toggleCalloutFoldEffect.of(1) }).state;
		expect(state.field(calloutFoldField)).toEqual([1]);

		state = state.update({ effects: toggleCalloutFoldEffect.of(1) }).state;
		expect(state.field(calloutFoldField)).toEqual([]);
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

	it("mounts EditorView with collapsed multi-line callout without throwing replacement line break errors", async () => {
		const doc = "> [!note] Multi line\n> body line 1\n> body line 2\n> body line 3";
		const state = await makeState(doc, [1]);
		expect(() => {
			const view = new EditorView({
				state,
				parent: (globalThis as any).document.createElement("div"),
			});
			view.destroy();
		}).not.toThrow();
	});

	it("rebuilds decorations when calloutFoldField changes via toggleCalloutFoldEffect on mounted view", async () => {
		const doc = "> [!note] Multi line\n> body line 1\n> body line 2";
		const state = await makeState(doc, []);
		const view = new EditorView({
			state,
			parent: (globalThis as any).document.createElement("div"),
		});
		const plugin = view.plugin(calloutPlugin);
		expect(plugin).toBeDefined();

		// Initially uncollapsed -> no replace decorations
		let replaceCount = 0;
		plugin!.decorations.between(0, view.state.doc.length, (f: number, t: number, d: any) => {
			if (d.spec?.widget === undefined && !d.spec?.class && f < t) replaceCount++;
		});
		expect(replaceCount).toBe(0);

		// Toggle fold
		view.dispatch({ effects: toggleCalloutFoldEffect.of(1) });

		replaceCount = 0;
		plugin!.decorations.between(0, view.state.doc.length, (f: number, t: number, d: any) => {
			if (d.spec?.widget === undefined && !d.spec?.class && f < t) replaceCount++;
		});
		expect(replaceCount).toBe(2); // 2 body lines replaced individually

		view.destroy();
	});
});
