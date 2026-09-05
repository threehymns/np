import "../../../../tests/contract/rune-setup";
import { describe, it, expect, beforeAll, mock } from "bun:test";
import { EditorState } from "@codemirror/state";
import { syntaxTree, LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

let getLanguageExtensions: any;

beforeAll(async () => {
	mock.module("svelte/reactivity", () => ({
		SvelteMap: Map,
		SvelteSet: Set,
	}));
	const mod = await import("./index");
	getLanguageExtensions = mod.getLanguageExtensions;
});

function nodeKinds(doc: string, extensions: any[]): string[] {
	const state = EditorState.create({ doc, extensions });
	const kinds: string[] = [];
	syntaxTree(state).iterate({
		enter: (n: any) => {
			kinds.push(n.name);
		},
	});
	return kinds;
}

describe("Markdown language stack wikilink precedence", () => {
	it("exposes a single Markdown language so [[..]] is not shadowed", async () => {
		const mdDesc = languages.find((l) => l.name === "Markdown")!;
		const exts: any[] = await getLanguageExtensions(mdDesc);
		// Regression: the plain Markdown LanguageSupport (no WikiLinkExtension)
		// used to be stacked ahead of the custom one, and CodeMirror resolves
		// the syntax tree from the first language — so [[Note]] parsed as the
		// inner single-bracket Link instead of the outer WikiLink.
		const langs = exts.filter((e: any) => e instanceof LanguageSupport);
		expect(langs.length).toBe(1);
	});

	it("parses plain [[Note]] as WikiLink, not the inner single-bracket Link", async () => {
		const mdDesc = languages.find((l) => l.name === "Markdown")!;
		const exts: any[] = await getLanguageExtensions(mdDesc);
		// Stack the language facets exactly as the editor does.
		const langs = exts.filter((e: any) => e instanceof LanguageSupport);
		const kinds = nodeKinds("A [[Note Target]] B", langs);
		expect(kinds).toContain("WikiLink");
		expect(kinds).not.toContain("Link");
	});
});
