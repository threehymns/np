import { describe, it, expect } from "bun:test";
import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { CompletionContext } from "@codemirror/autocomplete";
import {
	WikiLinkExtension,
	wikilinkAutocompletion,
	workspaceFacet,
	currentDocFacet,
} from "./wikilinks";
import { HideMarkersPlugin } from "./hide-markers";

const mdExt = markdown({ extensions: [WikiLinkExtension] as any });

function targetText(doc: string): string | null {
	const state = EditorState.create({ doc, extensions: [mdExt] });
	let found: string | null = null;
	syntaxTree(state).iterate({
		enter: (node: any) => {
			if (node.name === "WikiLinkTarget") {
				found = state.doc.sliceString(node.from, node.to);
			}
		},
	});
	return found;
}

function nodeNames(doc: string): string[] {
	const state = EditorState.create({ doc, extensions: [mdExt] });
	const names: string[] = [];
	syntaxTree(state).iterate({
		enter: (node: any) => names.push(node.name),
	});
	return names;
}

/** Replaced (hidden) decoration ranges with cursor outside the node. */
function hiddenRanges(doc: string): { from: number; to: number }[] {
	const state = EditorState.create({
		doc,
		selection: { anchor: 0 },
		extensions: [mdExt],
	});
	const mockView: any = {
		state,
		visibleRanges: [{ from: 0, to: doc.length }],
		hasFocus: false,
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

describe("S2 wikilink/embed seams (parse tree)", () => {
	it("parses [[Note]] target", () => {
		expect(targetText("[[Note]]")).toBe("Note");
	});

	it("parses [[Note|alias]] into target + alias", () => {
		const state = EditorState.create({
			doc: "[[Note|Custom Alias]]",
			extensions: [mdExt],
		});
		const seen = new Map<string, string>();
		syntaxTree(state).iterate({
			enter: (node: any) => {
				if (
					node.name === "WikiLinkTarget" ||
					node.name === "WikiLinkAlias"
				) {
					seen.set(
						node.name,
						state.doc.sliceString(node.from, node.to),
					);
				}
			},
		});
		expect(seen.get("WikiLinkTarget")).toBe("Note");
		expect(seen.get("WikiLinkAlias")).toBe("Custom Alias");
	});

	it("parses [[Note#Heading]] cross-note heading ref", () => {
		expect(targetText("[[Other#Overview]]")).toBe("Other#Overview");
	});

	it("parses [[Note#^block]] cross-note block ref", () => {
		expect(targetText("[[Other#^abc-123]]")).toBe("Other#^abc-123");
	});

	it("parses same-note [[#Heading]]", () => {
		expect(targetText("[[#Overview]]")).toBe("#Overview");
	});

	it("parses same-note [[#^block]]", () => {
		expect(targetText("[[#^abc-123]]")).toBe("#^abc-123");
	});
});

describe("S2 markdown link/image seams (parse tree)", () => {
	it("parses [label](other-note.md#section) internal navigation link", () => {
		const doc = "[label](other-note.md#section)";
		const names = nodeNames(doc);
		expect(names).toContain("Link");
		expect(names).toContain("URL");
		const state = EditorState.create({ doc, extensions: [mdExt] });
		let href: string | null = null;
		syntaxTree(state).iterate({
			enter: (node: any) => {
				if (node.name === "URL")
					href = state.doc.sliceString(node.from, node.to);
			},
		});
		expect(href).toBe("other-note.md#section");
	});

	it("parses standard ![Alt](image.png) image", () => {
		const doc = "![Alt](image.png)";
		const names = nodeNames(doc);
		expect(names).toContain("Image");
		const state = EditorState.create({ doc, extensions: [mdExt] });
		let href: string | null = null;
		syntaxTree(state).iterate({
			enter: (node: any) => {
				if (node.name === "URL")
					href = state.doc.sliceString(node.from, node.to);
			},
		});
		expect(href).toBe("image.png");
	});
});

describe("S2 marker-hiding seams (decorations)", () => {
	it("hides [[ ]] of [[Note#Heading]], cursor outside", () => {
		expect(hiddenRanges("[[Note#Heading]]")).toEqual([
			{ from: 0, to: 2 },
			{ from: 14, to: 16 },
		]);
	});

	it("hides [[ ]] of [[Note#^block]], cursor outside", () => {
		expect(hiddenRanges("[[Note#^block]]")).toEqual([
			{ from: 0, to: 2 },
			{ from: 13, to: 15 },
		]);
	});

	it("hides [[ ]] of same-note [[#Heading]], cursor outside", () => {
		expect(hiddenRanges("[[#Heading]]")).toEqual([
			{ from: 0, to: 2 },
			{ from: 10, to: 12 },
		]);
	});

	it("hides [[ ]] of same-note [[#^block]], cursor outside", () => {
		expect(hiddenRanges("[[#^block]]")).toEqual([
			{ from: 0, to: 2 },
			{ from: 9, to: 11 },
		]);
	});

	it("keeps unresolved [[missing]] styling identical to a resolved link (same hidden ranges)", () => {
		// Same shape as [[#^block]]: open/close markers hidden, target intact.
		expect(hiddenRanges("[[missing]]")).toEqual([
			{ from: 0, to: 2 },
			{ from: 9, to: 11 },
		]);
	});

	it("hides markdown-link markers ([]() and URL) when cursor outside", () => {
		expect(hiddenRanges("[label](other-note.md#section)")).toEqual([
			{ from: 0, to: 1 },
			{ from: 6, to: 7 },
			{ from: 7, to: 8 },
			{ from: 8, to: 29 },
			{ from: 29, to: 30 },
		]);
	});

	it("hides image markers but keeps the URL visible when cursor outside", () => {
		// Characterization: unlike Markdown links, image URLs are currently NOT
		// hidden (the URL's ancestor is Image, not Link). Locking current behavior.
		expect(hiddenRanges("![Alt](image.png)")).toEqual([
			{ from: 0, to: 2 },
			{ from: 5, to: 6 },
			{ from: 6, to: 7 },
			{ from: 16, to: 17 },
		]);
	});
});

describe("S2 autocomplete after # / ^ (cross-note)", () => {
	const mockWorkspace: any = {
		projectTree: { nodes: [] },
		documents: [
			{
				fileName: "Project.md",
				content: "# Alpha\nIntro\n\n## Beta\nDetails\n^blk-42\n",
			},
		],
	};

	const mockCurrentDoc: any = { content: "" };

	it("completes headings of a target note on [[Project#", () => {
		const state = EditorState.create({
			doc: "Jump [[Project# ",
			selection: { anchor: 15 },
			extensions: [
				workspaceFacet.of(mockWorkspace),
				currentDocFacet.of(mockCurrentDoc),
			],
		});
		const context = new CompletionContext(state, 15, false);
		const result = wikilinkAutocompletion(context);
		expect(result).not.toBeNull();
		const labels = result!.options.map((o) => o.label);
		expect(labels).toContain("Alpha");
		expect(labels).toContain("Beta");
	});

	it("completes blocks of a target note on [[Project#^", () => {
		const state = EditorState.create({
			doc: "Jump [[Project#^ ",
			selection: { anchor: 16 },
			extensions: [
				workspaceFacet.of(mockWorkspace),
				currentDocFacet.of(mockCurrentDoc),
			],
		});
		const context = new CompletionContext(state, 16, false);
		const result = wikilinkAutocompletion(context);
		expect(result).not.toBeNull();
		expect(result!.options.map((o) => o.label)).toContain("blk-42");
	});
});