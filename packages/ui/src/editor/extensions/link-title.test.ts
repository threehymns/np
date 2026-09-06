import "../../../../../tests/contract/rune-setup";
import { describe, it, expect, beforeAll, mock } from "bun:test";
import { EditorState } from "@codemirror/state";
import { LanguageSupport } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import type { ViewPlugin } from "@codemirror/view";

let getLanguageExtensions: any;
let hideMarkersPlugin: ViewPlugin<any>;

beforeAll(async () => {
	mock.module("svelte/reactivity", () => ({
		SvelteMap: Map,
		SvelteSet: Set,
	}));
	const mod = await import("../index");
	getLanguageExtensions = mod.getLanguageExtensions;
	hideMarkersPlugin = mod.hideMarkersPlugin;
});

async function makeState(
	doc: string,
	cursor: number,
	hasFocus: boolean,
): Promise<EditorState> {
	const desc = languages.find((l) => l.name === "Markdown")!;
	const exts = await getLanguageExtensions(desc);
	const support = exts.filter((e) => e instanceof LanguageSupport);
	return EditorState.create({
		doc,
		selection: { anchor: cursor },
		extensions: support,
	});
}

function replacedRanges(
	doc: string,
	cursor: number,
	hasFocus: boolean,
): { from: number; to: number }[] {
	// synchronous state construction using plain lezer markdown tree
	const state = EditorState.create({
		doc,
		selection: { anchor: cursor },
		extensions: [markdown()],
	});
	const inst: any = hideMarkersPlugin.create(
		{
			state,
			hasFocus,
			visibleRanges: [{ from: 0, to: doc.length }],
		} as any,
		undefined,
	);
	const out: { from: number; to: number }[] = [];
	inst.decorations.between(
		0,
		doc.length,
		(from: number, to: number, deco: any) => {
			if (from < to && !deco.spec?.widget && !deco.spec?.class) {
				out.push({ from, to });
			}
		},
	);
	return out;
}

describe("#145 link titles", () => {
	it("keeps Link/URL/LinkTitle parsing intact", async () => {
		const state = await makeState(
			'[text](https://example.com "hover title")',
			0,
			false,
		);
		const names: string[] = [];
		const { syntaxTree } = await import("@codemirror/language");
		syntaxTree(state).iterate({ enter: (n) => void names.push(n.name) });
		expect(names).toContain("Link");
		expect(names).toContain("URL");
		expect(names).toContain("LinkTitle");
	});

	it("hides the title and URL, keeping only the label, when the cursor is outside", () => {
		const doc = '[text](https://example.com "hover title")';
		// off-cursor -> label visible, everything else hidden:
		// [ at 0..1, ]( at 5..7, URL+title+paren at 7..40
		const ranges = replacedRanges(doc, 0, false);
		// URL 7..26, space 26..27, title 27..40, paren 40..41 -> grouped or individual
		expect(ranges).toContainEqual({ from: 0, to: 1 });
		expect(ranges).toContainEqual({ from: 5, to: 6 });
		expect(ranges).toContainEqual({ from: 6, to: 7 });
		// title range 27..40 is hidden
		expect(ranges).toContainEqual({ from: 27, to: 40 });
		// closing paren 40..41 is hidden
		expect(ranges).toContainEqual({ from: 40, to: 41 });
	});

	it("reveals the full title syntax when the cursor is inside the link", () => {
		const doc = '[text](https://example.com "hover title")';
		// cursor inside the label
		expect(replacedRanges(doc, 7, true)).toEqual([]);
	});

	it("leaves title-less links [text](url) unchanged", () => {
		const doc = "[text](https://example.com)";
		expect(replacedRanges(doc, 0, false)).toEqual([
			{ from: 0, to: 1 },
			{ from: 5, to: 6 },
			{ from: 6, to: 7 },
			{ from: 7, to: 26 },
			{ from: 26, to: 27 },
		]);
	});

	it("hides remote-image titles off-cursor too", () => {
		const doc = '![alt](https://example.com/img.png "title")';
		const ranges = replacedRanges(doc, 2, false);
		// "title" (35-42) is hidden off-cursor
		expect(ranges).toContainEqual({ from: 35, to: 42 });
		// Image URLs stay visible (known #144 gap), so 7-34 is NOT a replace range
		expect(ranges).not.toContainEqual({ from: 7, to: 34 });
	});
});
