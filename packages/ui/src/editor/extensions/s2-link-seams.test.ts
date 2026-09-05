import { describe, it, expect } from "bun:test";
import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { Table, GFM } from "@lezer/markdown";
import { CompletionContext } from "@codemirror/autocomplete";
import { WikiLinkExtension, wikilinkAutocompletion, workspaceFacet, currentDocFacet } from "./wikilinks";
import { HideMarkersPlugin } from "./hide-markers";
import { decideLinkClick, decideLinkMousedown } from "./link-events";
import { parseInternalLink } from "@np/core/links";

/**
 * S2 characterization net (issue #144).
 *
 * Locks the proven link/wikilink seams so the S2 additions (spec #135) cannot
 * regress them. Every form below is asserted at the parse-tree + decoration
 * level end-to-end; navigation adds the pure target-resolution seam
 * (parseInternalLink), and click verdicts (decideLinkClick / decideLinkMousedown)
 * for the interactive link vs inert image distinction.
 *
 * No production code is touched: these tests only characterize existing seams.
 */

const mdExt = markdown({ extensions: [Table, GFM, WikiLinkExtension] as any });

function mdState(doc: string): EditorState {
	return EditorState.create({ doc, extensions: [mdExt] });
}

/** Collect every syntax node name + its source text. */
function nodeKinds(doc: string): string[] {
	const state = mdState(doc);
	const kinds: string[] = [];
	syntaxTree(state).iterate({
		enter: (n: any) => {
			kinds.push(n.name);
		},
	});
	return kinds;
}

/** Slice a named node from the tree, or null if absent. */
function sliceNodes(state: EditorState, names: string[]): string[] {
	const out: string[] = [];
	syntaxTree(state).iterate({
		enter: (n: any) => {
			if (names.includes(n.name)) out.push(state.doc.sliceString(n.from, n.to));
		},
	});
	return out;
}

/** Build a collapsed (blurred) marker view for decoration tests. */
function collapsedView(doc: string): HideMarkersPlugin {
	const state = mdState(doc);
	const mockView: any = {
		state,
		visibleRanges: [{ from: 0, to: doc.length }],
		hasFocus: false,
	};
	return new HideMarkersPlugin(mockView);
}

/** Replacement ranges (markers hidden): Decoration.replace with no widget. */
function replacementRanges(plugin: HideMarkersPlugin): { from: number; to: number }[] {
	const ranges: { from: number; to: number }[] = [];
	const cursor = plugin.decorations.iter();
	while (cursor.value !== null) {
		if ((cursor.value as any).spec.widget === undefined) {
			ranges.push({ from: cursor.from, to: cursor.to });
		}
		cursor.next();
	}
	return ranges;
}

/** The `[[` opening marker length (embed-aware: `[[` -> 2, `![[` -> 3). */
function openMarkLen(doc: string): number {
	return doc.charAt(0) === "!" ? 3 : 2;
}

// ---------------------------------------------------------------------------
// 1. Parse-tree: [[...]] forms, aliases, deep targets, same-note refs, unresolved
// ---------------------------------------------------------------------------
describe("parse-tree: wikilink forms", () => {
	it("[[Note]] parses as a plain WikiLink with WikiLinkTarget", () => {
		const kinds = nodeKinds("[[Note]]");
		expect(kinds).toContain("WikiLink");
		expect(kinds).not.toContain("Link");
		expect(kinds).toContain("WikiLinkTarget");
		expect(kinds).not.toContain("WikiLinkAlias");

		const state = mdState("[[Note]]");
		expect(sliceNodes(state, ["WikiLinkTarget"])).toEqual(["Note"]);
	});

	it("[[Note|Custom Text]] parses target + alias", () => {
		const state = mdState("[[Note|Custom Text]]");
		expect(sliceNodes(state, ["WikiLinkTarget"])).toEqual(["Note"]);
		expect(sliceNodes(state, ["WikiLinkAlias"])).toEqual(["Custom Text"]);
	});

	it("[[Note#Heading]] keeps the full deep target in WikiLinkTarget", () => {
		const state = mdState("[[Note#Heading]]");
		expect(sliceNodes(state, ["WikiLinkTarget"])).toEqual(["Note#Heading"]);
		expect(sliceNodes(state, ["WikiLinkAlias"])).toEqual([]);
	});

	it("[[Note#^block]] keeps the block-ref target in WikiLinkTarget", () => {
		const state = mdState("[[Note#^block]]");
		expect(sliceNodes(state, ["WikiLinkTarget"])).toEqual(["Note#^block"]);
	});

	it("[[#Heading]] same-note heading stays a WikiLink", () => {
		const state = mdState("[[#Heading]]");
		expect(sliceNodes(state, ["WikiLinkTarget"])).toEqual(["#Heading"]);
		expect(sliceNodes(state, ["WikiLinkAlias"])).toEqual([]);
	});

	it("[[#^block]] same-note block ref stays a WikiLink", () => {
		const state = mdState("[[#^block]]");
		expect(sliceNodes(state, ["WikiLinkTarget"])).toEqual(["#^block"]);
	});

	it("unresolved [[missing]] still parses as a WikiLink (unchanged styling)", () => {
		const kinds = nodeKinds("[[missing]]");
		expect(kinds).toContain("WikiLink");
		const state = mdState("[[missing]]");
		expect(sliceNodes(state, ["WikiLinkTarget"])).toEqual(["missing"]);
	});
});

// ---------------------------------------------------------------------------
// 2. Parse-tree: markdown link and standard image forms
// ---------------------------------------------------------------------------
describe("parse-tree: markdown link + standard image", () => {
	it("[label](other-note.md#section) parses as Link with a URL node", () => {
		const kinds = nodeKinds("[label](other-note.md#section)");
		expect(kinds).toContain("Link");
		expect(kinds).not.toContain("WikiLink");
		const state = mdState("[label](other-note.md#section)");
		expect(sliceNodes(state, ["URL"])).toEqual(["other-note.md#section"]);
		// The section is part of the URL destination, not a separate node.
		expect(sliceNodes(state, ["WikiLink"])).toEqual([]);
	});

	it("![Alt](image.png) parses as Image (not Link/WikiLink)", () => {
		const kinds = nodeKinds("![Alt](image.png)");
		expect(kinds).toContain("Image");
		expect(kinds).not.toContain("Link");
		expect(kinds).not.toContain("WikiLink");
		const state = mdState("![Alt](image.png)");
		expect(sliceNodes(state, ["URL"])).toEqual(["image.png"]);
	});
});

// ---------------------------------------------------------------------------
// 3. Decorations: marker hiding for [[...]] forms (collapsed)
// ---------------------------------------------------------------------------
describe("decorations: wikilink marker hiding (collapsed)", () => {
	it("[[Note]] hides [[ and ]] around the target", () => {
		const doc = "[[Note]]";
		const plugin = collapsedView(doc);
		expect(replacementRanges(plugin)).toEqual([
			{ from: 0, to: openMarkLen(doc) },
			{ from: doc.length - 2, to: doc.length },
		]);
	});

	it("[[Note|Custom Text]] hides [[Note| and ]] keeping only the alias", () => {
		const doc = "[[Note|Custom Text]]";
		const plugin = collapsedView(doc);
		// alias starts after "[[Note|" (7 chars); markers at start and the final "]]"
		expect(replacementRanges(plugin)).toEqual([
			{ from: 0, to: 7 },
			{ from: doc.length - 2, to: doc.length },
		]);
	});

	it("[[Note#Heading]] hides the markers, keeping the deep target", () => {
		const doc = "[[Note#Heading]]";
		const plugin = collapsedView(doc);
		expect(replacementRanges(plugin)).toEqual([
			{ from: 0, to: openMarkLen(doc) },
			{ from: doc.length - 2, to: doc.length },
		]);
	});

	it("[[Note#^block]] hides the markers, keeping the block ref", () => {
		const doc = "[[Note#^block]]";
		const plugin = collapsedView(doc);
		expect(replacementRanges(plugin)).toEqual([
			{ from: 0, to: openMarkLen(doc) },
			{ from: doc.length - 2, to: doc.length },
		]);
	});

	it("[[#Heading]] same-note hides the markers", () => {
		const doc = "[[#Heading]]";
		const plugin = collapsedView(doc);
		expect(replacementRanges(plugin)).toEqual([
			{ from: 0, to: openMarkLen(doc) },
			{ from: doc.length - 2, to: doc.length },
		]);
	});

	it("[[#^block]] same-note hides the markers", () => {
		const doc = "[[#^block]]";
		const plugin = collapsedView(doc);
		expect(replacementRanges(plugin)).toEqual([
			{ from: 0, to: openMarkLen(doc) },
			{ from: doc.length - 2, to: doc.length },
		]);
	});

	it("unresolved [[missing]] keeps the same collapsed hide-marker styling", () => {
		const doc = "[[missing]]";
		const plugin = collapsedView(doc);
		expect(replacementRanges(plugin)).toEqual([
			{ from: 0, to: openMarkLen(doc) },
			{ from: doc.length - 2, to: doc.length },
		]);
	});

	it("expanded wikilink adds cm-link-expanded and hides no markers", () => {
		const doc = "[[Note Target]]";
		const state = mdState(doc);
		const mockView: any = {
			state,
			visibleRanges: [{ from: 0, to: doc.length }],
			hasFocus: true,
			// selection inside the link
		};
		const stateWithSel = EditorState.create({
			doc,
			selection: { anchor: 5 },
			extensions: [mdExt],
		});
		const expandedPlugin = new HideMarkersPlugin({
			...mockView,
			state: stateWithSel,
		} as any);

		let hasExpanded = false;
		let replacementCount = 0;
		const cursor = expandedPlugin.decorations.iter();
		while (cursor.value !== null) {
			const spec = (cursor.value as any).spec;
			if (spec.class === "cm-link-expanded") {
				hasExpanded = true;
				expect(cursor.from).toBe(0);
				expect(cursor.to).toBe(doc.length);
			}
			if (spec.widget === undefined && !spec.class) replacementCount++;
			cursor.next();
		}
		expect(hasExpanded).toBe(true);
		expect(replacementCount).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// 4. Decorations: markdown link + standard image (collapsed)
// ---------------------------------------------------------------------------
describe("decorations: markdown link + standard image (collapsed)", () => {
	it("[label](other-note.md#section) collapses to just the label", () => {
		const doc = "[label](other-note.md#section)";
		const plugin = collapsedView(doc);
		// hides "[", "]", "(", the full URL "other-note.md#section", and ")"
		expect(replacementRanges(plugin)).toEqual([
			{ from: 0, to: 1 },
			{ from: 6, to: 7 },
			{ from: 7, to: 8 },
			{ from: 8, to: 29 },
			{ from: 29, to: 30 },
		]);
	});

	it("![Alt](image.png) hides markers but keeps the URL visible (unchanged)", () => {
		const doc = "![Alt](image.png)";
		const plugin = collapsedView(doc);
		// hides "![", "]", "(" and ")" but NOT the image.png URL node
		expect(replacementRanges(plugin)).toEqual([
			{ from: 0, to: 2 },
			{ from: 5, to: 6 },
			{ from: 6, to: 7 },
			{ from: 16, to: 17 },
		]);
	});
});

// ---------------------------------------------------------------------------
// 5. Navigation: pure target-resolution + click verdicts
// ---------------------------------------------------------------------------
describe("navigation: target resolution + click verdicts", () => {
	it("[[Note]] resolves to path Note with no subpath", () => {
		expect(parseInternalLink("[[Note]]")).toEqual({
			raw: "[[Note]]",
			path: "Note",
			subpath: null,
			alias: null,
			isEmbed: false,
		});
	});

	it("[[Note|Custom Text]] resolves alias from a wikilink", () => {
		expect(parseInternalLink("[[Note|Custom Text]]")).toMatchObject({
			path: "Note",
			alias: "Custom Text",
		});
	});

	it("[[Note#Heading]] resolves a heading subpath", () => {
		expect(parseInternalLink("[[Note#Heading]]")).toMatchObject({
			path: "Note",
			subpath: { type: "heading", value: "Heading" },
		});
	});

	it("[[Note#^block]] resolves a block subpath", () => {
		expect(parseInternalLink("[[Note#^block]]")).toMatchObject({
			path: "Note",
			subpath: { type: "block", value: "block" },
		});
	});

	it("[[#Heading]] same-note resolves to empty path + heading subpath", () => {
		expect(parseInternalLink("[[#Heading]]")).toMatchObject({
			path: "",
			subpath: { type: "heading", value: "Heading" },
		});
	});

	it("[[#^block]] same-note resolves to empty path + block subpath", () => {
		expect(parseInternalLink("[[#^block]]")).toMatchObject({
			path: "",
			subpath: { type: "block", value: "block" },
		});
	});

	it("[label](other-note.md#section) yields a link verdict routed to internal navigation", () => {
		const doc = "[label](other-note.md#section)";
		const state = mdState(doc);
		const labelStart = doc.indexOf("label") + 1;
		const target = {
			classList: { contains: (c: string) => c === "cm-link" },
			closest: (sel: string) => (sel === ".cm-link" ? {} : null),
		} as any;

		expect(decideLinkMousedown(state, labelStart, target, false)).toBe(true);
		expect(decideLinkClick(state, labelStart, target, false)).toEqual({
			kind: "link",
			raw: "other-note.md#section",
		});

		// The raw destination is exactly a parseable internal link (not http).
		expect(parseInternalLink("other-note.md#section")).toMatchObject({
			path: "other-note.md",
			subpath: { type: "heading", value: "section" },
		});
	});

	it("wikilink label click yields a wikilink verdict with raw target", () => {
		const doc = "See [[Note#Heading]]";
		const state = mdState(doc);
		const target = {
			classList: { contains: (c: string) => c === "cm-link" },
			closest: (sel: string) => (sel === ".cm-link" ? {} : null),
		} as any;
		// click on the "Note" glyph
		const pos = doc.indexOf("Note") + 1;
		expect(decideLinkClick(state, pos, target, false)).toEqual({
			kind: "wikilink",
			raw: "[[Note#Heading]]",
		});
	});

	it("standard image is not an interactive link (inert)", () => {
		const doc = "![Alt](image.png)";
		const state = mdState(doc);
		const target = {
			classList: { contains: (c: string) => c === "cm-link" },
			closest: (sel: string) => (sel === ".cm-link" ? {} : null),
		} as any;
		const pos = doc.indexOf("Alt") + 1;
		expect(decideLinkMousedown(state, pos, target, false)).toBe(false);
		expect(decideLinkClick(state, pos, target, false)).toEqual({ kind: null, raw: "" });
	});
});

// ---------------------------------------------------------------------------
// 6. Autocomplete-after-#/^ (existing tests stay green; add cross-note coverage)
// ---------------------------------------------------------------------------
describe("autocomplete: heading/block after # and ^", () => {
	const mockWorkspace: any = {
		projectTree: { nodes: [] },
		documents: [
			{
				fileName: "Note A.md",
				content: "# Introduction\nIntro\n\n## Deep Dive\nDetails\n^dive-block\n",
			},
		],
	};

	const mockCurrentDoc: any = {
		content: "# Introduction\nIntro\n\n## Deep Dive\nDetails\n^dive-block\n",
	};

	function stateAt(doc: string, pos: number): EditorState {
		return EditorState.create({
			doc,
			selection: { anchor: pos },
			extensions: [
				workspaceFacet.of(mockWorkspace),
				currentDocFacet.of(mockCurrentDoc),
			],
		});
	}

	it("completes headings on cross-note [[Note A#", () => {
		const doc = "Jump [[Note A#";
		const state = stateAt(doc, doc.length);
		const result = wikilinkAutocompletion(new CompletionContext(state, doc.length, false));
		expect(result).not.toBeNull();
		expect(result!.options.map((o) => o.label)).toContain("Deep Dive");
		expect(result!.options.map((o) => o.label)).toContain("Introduction");
	});

	it("completes blocks on cross-note [[Note A#^", () => {
		const doc = "Jump [[Note A#^";
		const state = stateAt(doc, doc.length);
		const result = wikilinkAutocompletion(new CompletionContext(state, doc.length, false));
		expect(result).not.toBeNull();
		expect(result!.options.map((o) => o.label)).toContain("dive-block");
	});

	it("filters heading completion by typed query after #", () => {
		const doc = "Jump [[#Deep";
		const state = stateAt(doc, doc.length);
		const result = wikilinkAutocompletion(new CompletionContext(state, doc.length, false));
		expect(result!.options.map((o) => o.label)).toContain("Deep Dive");
		expect(result!.options.map((o) => o.label)).not.toContain("Introduction");
	});

	it("yields to alias after | inside [[..]] (unchanged rule)", () => {
		const doc = "Jump [[Note A|Alias";
		const state = stateAt(doc, doc.length);
		const context = new CompletionContext(state, doc.length, false);
		expect(wikilinkAutocompletion(context)).toBeNull();
	});
});