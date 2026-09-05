import { describe, it, expect } from "bun:test";
import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { WikiLinkExtension } from "./wikilinks";
import { HideMarkersPlugin } from "./hide-markers";

const mdExt = markdown({ extensions: [GFM, WikiLinkExtension] as any });

function replacedRanges(
	doc: string,
	anchor: number,
	hasFocus: boolean,
): { from: number; to: number }[] {
	const state = EditorState.create({
		doc,
		selection: { anchor },
		extensions: [mdExt],
	});
	const mockView: any = {
		state,
		visibleRanges: [{ from: 0, to: doc.length }],
		hasFocus,
	};
	const plugin = new HideMarkersPlugin(mockView);
	const out: { from: number; to: number }[] = [];
	const cursor = plugin.decorations.iter();
	while (cursor.value !== null) {
		const spec = (cursor.value as any).spec;
		if (spec.widget === undefined && !spec.class) {
			out.push({ from: cursor.from, to: cursor.to });
		}
		cursor.next();
	}
	return out;
}

describe("#145 link titles", () => {
	it("keeps Link/URL/LinkTitle parsing intact", () => {
		const doc = '[text](https://example.com "hover title")';
		const state = EditorState.create({ doc, extensions: [mdExt] });
		const names: string[] = [];
		syntaxTree(state).iterate({ enter: (n: any) => names.push(n.name) });
		expect(names).toContain("Link");
		expect(names).toContain("URL");
		expect(names).toContain("LinkTitle");
	});

	it("hides the title and URL, keeping only the label, when the cursor is outside", () => {
		const doc = '[text](https://example.com "hover title")';
		expect(replacedRanges(doc, 0, false)).toEqual([
			{ from: 0, to: 1 }, // [
			{ from: 5, to: 6 }, // ]
			{ from: 6, to: 7 }, // (
			{ from: 7, to: 26 }, // URL
			{ from: 27, to: 40 }, // "hover title"
			{ from: 40, to: 41 }, // )
		]);
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
		const doc = "![alt](https://example.com/img.png \"title\")";
		const ranges = replacedRanges(doc, 2, false);
		// "title" (35-42) is hidden off-cursor
		expect(ranges).toContainEqual({ from: 35, to: 42 });
		// Image URLs stay visible (known #144 gap), so 7-35 is NOT a replace range
		expect(ranges).not.toContainEqual({ from: 7, to: 35 });
	});
});