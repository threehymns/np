import "../../../../tests/contract/rune-setup";
import { describe, it, expect, beforeAll, mock } from "bun:test";
import { EditorState } from "@codemirror/state";
import { LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { ViewPlugin } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { Table, GFM } from "@lezer/markdown";
import { WikiLinkExtension } from "./extensions/wikilinks";
import { decideLinkClick } from "./extensions/link-events";
import { HideMarkersPlugin } from "./extensions/hide-markers";

let getLanguageExtensions: any;
let embedPlugin: ViewPlugin<any>;

beforeAll(async () => {
	mock.module("svelte/reactivity", () => ({
		SvelteMap: Map,
		SvelteSet: Set,
	}));
	const mod = await import("./index");
	getLanguageExtensions = mod.getLanguageExtensions;
	embedPlugin = mod.embedPlugin;
});

async function makeState(doc: string): Promise<EditorState> {
	const desc = languages.find((l) => l.name === "Markdown")!;
	const exts = await getLanguageExtensions(desc);
	const support = exts.filter((e) => e instanceof LanguageSupport);
	return EditorState.create({ doc, extensions: support });
}

function embedMarks(plugin: ViewPlugin<any>, state: EditorState): string[] {
	const inst: any = plugin.create(
		{ state, hasFocus: false, visibleRanges: [{ from: 0, to: state.doc.length }] },
		undefined,
	);
	const out: string[] = [];
	inst.decorations.between(0, state.doc.length, (_f: number, _t: number, d: any) => {
		if (d.spec?.class) out.push(d.spec.class);
		else if (d.spec?.className) out.push(d.spec.className);
	});
	return out;
}

function linkState(doc: string) {
	const mdExt = markdown({
		extensions: [Table, GFM, WikiLinkExtension] as any,
	});
	return EditorState.create({ doc, extensions: [mdExt] });
}

const linkTarget = () => ({
	classList: { contains: (c: string) => c === "cm-link" },
	closest: (sel: string) => (sel === ".cm-link" ? {} : null),
});

describe("#148 embeds", () => {
	it("marks note embeds, section/block embeds, and media placeholders", async () => {
		const cases = [
			"![[Note]]",
			"![[Note#Heading]]",
			"![[Note#^block]]",
			"![[audio.mp3]]",
			"![[video.mp4]]",
			"![[document.pdf]]",
		];
		for (const c of cases) {
			const state = await makeState(c);
			expect(embedMarks(embedPlugin, state)).toContain("cm-embed");
		}
	});

	it("does not mark normal wikilinks", async () => {
		const state = await makeState("[[Note]]");
		expect(embedMarks(embedPlugin, state)).not.toContain("cm-embed");
	});

	it("keeps marker-hiding collapse on embeds (no replace overlap)", async () => {
		const doc = "![[Note]]";
		const state = await makeState(doc);
		expect(() => embedMarks(embedPlugin, state)).not.toThrow();

		const mockView: any = {
			state,
			visibleRanges: [{ from: 0, to: doc.length }],
			hasFocus: false,
		};
		const plugin = new HideMarkersPlugin(mockView);
		const ranges: [number, number][] = [];
		const cursor = plugin.decorations.iter();
		while (cursor.value !== null) {
			ranges.push([cursor.from, cursor.to]);
			cursor.next();
		}
		expect(ranges).toEqual([
			[0, 3],
			[7, 9],
		]);
	});

	it("clicking an embed navigates (wikilink verdict)", () => {
		const state = linkState("![[Other Note]]");
		const pos = state.doc.line(1).from + 3;
		expect(decideLinkClick(state, pos, linkTarget(), false)).toEqual({
			kind: "wikilink",
			raw: "![[Other Note]]",
		});
	});
});
