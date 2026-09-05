import "../../../../tests/contract/rune-setup";
import { describe, it, expect, beforeAll, mock } from "bun:test";
import { EditorState } from "@codemirror/state";
import { LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { ViewPlugin } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { Table, GFM } from "@lezer/markdown";
import { WikiLinkExtension } from "./extensions/wikilinks";
import { SizeBadgeWidget } from "./extensions/image-size";
import { decideImageClick } from "./extensions/link-events";

let getLanguageExtensions: any;
let sizeBadgePlugin: ViewPlugin<any>;

beforeAll(async () => {
	mock.module("svelte/reactivity", () => ({
		SvelteMap: Map,
		SvelteSet: Set,
	}));
	const mod = await import("./index");
	getLanguageExtensions = mod.getLanguageExtensions;
	sizeBadgePlugin = mod.sizeBadgePlugin;
});

async function makeState(doc: string): Promise<EditorState> {
	const desc = languages.find((l) => l.name === "Markdown")!;
	const exts = await getLanguageExtensions(desc);
	const support = exts.filter((e) => e instanceof LanguageSupport);
	return EditorState.create({ doc, extensions: support });
}

function badges(plugin: ViewPlugin<any>, state: EditorState): number[] {
	const inst: any = plugin.create(
		{ state, hasFocus: false, visibleRanges: [{ from: 0, to: state.doc.length }] },
		undefined,
	);
	const found: number[] = [];
	inst.decorations.between(0, state.doc.length, (_f: number, _t: number, d: any) => {
		const w = d.spec?.widget;
		if (w instanceof SizeBadgeWidget) found.push(w.width);
	});
	return found;
}

function imgState(doc: string) {
	const mdExt = markdown({
		extensions: [Table, GFM, WikiLinkExtension] as any,
	});
	return EditorState.create({ doc, extensions: [mdExt] });
}

describe("#149 embed size badges + image click", () => {
	it("renders a size badge for ![[photo.png|300]] via the shared parser", async () => {
		const state = await makeState("see ![[photo.png|300]] ok");
		expect(badges(sizeBadgePlugin, state)).toEqual([300]);
	});

	it("renders a size badge for ![alt|400](photo.png)", async () => {
		const state = await makeState("![alt|400](photo.png)");
		expect(badges(sizeBadgePlugin, state)).toEqual([400]);
	});

	it("renders WxH badges and no badge for unsized embeds", async () => {
		const state = await makeState("![[a.png|300x200]] ![[plain.png]]");
		expect(badges(sizeBadgePlugin, state)).toEqual([300]);
	});

	it("never renders a badge for a text alias [[Note|Alias]]", async () => {
		const state = await makeState("[[Note|Custom Text]]");
		expect(badges(sizeBadgePlugin, state)).toEqual([]);
	});

	it("image click verdict: external -> external open, vault-relative -> never create", () => {
		const ext = imgState("![x](https://example.com/i.png)");
		const pos = ext.doc.line(1).from + 6;
		expect(decideImageClick(ext, pos)).toEqual({
			kind: "image",
			dest: "https://example.com/i.png",
			external: true,
		});

		const rel = imgState("![[note.png]]");
		// WikiLink embeds are handled by the wikilink path, so a bare rel image Markdown
		const relIm = imgState("![x](vault/img.png)");
		expect(decideImageClick(relIm, 6)).toEqual({
			kind: "image",
			dest: "vault/img.png",
			external: false,
		});

		// plain paragraph is not an image
		expect(decideImageClick(imgState("just text"), 2)).toEqual({
			kind: null,
			raw: "",
		});
	});
});