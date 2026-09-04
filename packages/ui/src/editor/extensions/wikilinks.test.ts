import { describe, it, expect } from "bun:test";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import {
	WikiLinkExtension,
	wikilinkAutocompletion,
	workspaceFacet,
	currentDocFacet,
} from "./wikilinks";
import { HideMarkersPlugin } from "./hide-markers";
import { CompletionContext } from "@codemirror/autocomplete";

describe("WikiLink Lezer Markdown Extension", () => {
	it("parses WikiLink AST nodes with marks, target, and alias", () => {
		const mdExt = markdown({ extensions: [WikiLinkExtension] as any });
		const state = EditorState.create({
			doc: "Check [[Note Target|Custom Alias]] please.",
			extensions: [mdExt],
		});

		const tree = (state as any).tree;
		expect(tree).toBeDefined();

		let foundWikiLink = false;
		let foundTarget = false;
		let foundAlias = false;
		let markCount = 0;

		tree.iterate({
			enter: (node: any) => {
				if (node.name === "WikiLink") foundWikiLink = true;
				if (node.name === "WikiLinkTarget") {
					foundTarget = true;
					expect(state.doc.sliceString(node.from, node.to)).toBe(
						"Note Target"
					);
				}
				if (node.name === "WikiLinkAlias") {
					foundAlias = true;
					expect(state.doc.sliceString(node.from, node.to)).toBe(
						"Custom Alias"
					);
				}
				if (node.name === "WikiLinkMark") {
					markCount++;
				}
			},
		});

		expect(foundWikiLink).toBe(true);
		expect(foundTarget).toBe(true);
		expect(foundAlias).toBe(true);
		expect(markCount).toBe(3); // [[, |, ]]
	});

	it("parses embed wikilinks ![[Figure 1.png]]", () => {
		const mdExt = markdown({ extensions: [WikiLinkExtension] as any });
		const state = EditorState.create({
			doc: "![[Figure 1.png]]",
			extensions: [mdExt],
		});

		const tree = (state as any).tree;
		let foundEmbed = false;
		let targetText = "";

		tree.iterate({
			enter: (node: any) => {
				if (node.name === "WikiLink") foundEmbed = true;
				if (node.name === "WikiLinkTarget") {
					targetText = state.doc.sliceString(node.from, node.to);
				}
			},
		});

		expect(foundEmbed).toBe(true);
		expect(targetText).toBe("Figure 1.png");
	});
});

describe("hideMarkersPlugin with WikiLinks", () => {
	const mdExt = markdown({ extensions: [WikiLinkExtension] as any });

	it("hides markers [[ and ]] when cursor is outside the link", () => {
		const text = "A [[Note Target]] B";
		const state = EditorState.create({
			doc: text,
			selection: { anchor: 0 },
			extensions: [mdExt],
		});

		const mockView: any = {
			state,
			visibleRanges: [{ from: 0, to: text.length }],
			hasFocus: false,
		};

		const plugin = new HideMarkersPlugin(mockView);
		const decos = plugin.decorations;
		const replacedRanges: { from: number; to: number }[] = [];
		const cursor = decos.iter();
		while (cursor.value !== null) {
			if ((cursor.value as any).spec.widget === undefined) {
				replacedRanges.push({ from: cursor.from, to: cursor.to });
			}
			cursor.next();
		}

		// Expected: [[ (2 to 4) and ]] (15 to 17)
		expect(replacedRanges).toEqual([
			{ from: 2, to: 4 },
			{ from: 15, to: 17 },
		]);
	});

	it("hides [[Target| and ]] when aliased and cursor is outside", () => {
		const text = "[[Target|My Alias]]";
		const state = EditorState.create({
			doc: text,
			selection: { anchor: 0 },
			extensions: [mdExt],
		});

		const mockView: any = {
			state,
			visibleRanges: [{ from: 0, to: text.length }],
			hasFocus: false,
		};

		const plugin = new HideMarkersPlugin(mockView);
		const decos = plugin.decorations;
		const replacedRanges: { from: number; to: number }[] = [];
		const cursor = decos.iter();
		while (cursor.value !== null) {
			if ((cursor.value as any).spec.widget === undefined) {
				replacedRanges.push({ from: cursor.from, to: cursor.to });
			}
			cursor.next();
		}

		// Expected: [[Target| (0 to 9) and ]] (17 to 19)
		expect(replacedRanges).toEqual([
			{ from: 0, to: 9 },
			{ from: 17, to: 19 },
		]);
	});

	it("expands link with cm-link-expanded class when cursor is inside", () => {
		const text = "A [[Note Target]] B";
		// Place cursor inside the link at position 5
		const state = EditorState.create({
			doc: text,
			selection: { anchor: 5 },
			extensions: [mdExt],
		});

		const mockView: any = {
			state,
			visibleRanges: [{ from: 0, to: text.length }],
			hasFocus: true,
		};

		const plugin = new HideMarkersPlugin(mockView);
		const decos = plugin.decorations;
		let hasExpandedClass = false;
		let replacedCount = 0;

		const cursor = decos.iter();
		while (cursor.value !== null) {
			const spec = (cursor.value as any).spec;
			if (spec.class === "cm-link-expanded") {
				hasExpandedClass = true;
				expect(cursor.from).toBe(2);
				expect(cursor.to).toBe(17);
			}
			if (spec.widget === undefined && !spec.class) {
				replacedCount++;
			}
			cursor.next();
		}

		expect(hasExpandedClass).toBe(true);
		expect(replacedCount).toBe(0); // Markers are not hidden when expanded
	});
});

describe("wikilinkAutocompletion", () => {
	const mockWorkspace: any = {
		projectTree: {
			nodes: [
				{
					kind: "file",
					name: "Note A.md",
					origin: { scheme: "file", path: "/vault/Note A.md", name: "Note A.md" },
				},
				{
					kind: "file",
					name: "Research.md",
					origin: { scheme: "file", path: "/vault/Research.md", name: "Research.md" },
				},
			],
		},
		documents: [],
	};

	const mockCurrentDoc: any = {
		content: "# Introduction\nIntro\n\n## Deep Dive\nDetails\n^dive-block\n",
	};

	it("completes note names on [[", () => {
		const state = EditorState.create({
			doc: "See [[Not",
			selection: { anchor: 9 },
			extensions: [
				workspaceFacet.of(mockWorkspace),
				currentDocFacet.of(mockCurrentDoc),
			],
		});

		const context = new CompletionContext(state, 9, false);
		const result = wikilinkAutocompletion(context);
		expect(result).not.toBeNull();
		expect(result!.from).toBe(6); // starts after [[
		expect(result!.options.map((o) => o.label)).toContain("Note A");
		expect(result!.options.map((o) => o.label)).toContain("Research");
	});

	it("completes headings on [[#", () => {
		const state = EditorState.create({
			doc: "Jump [[#",
			selection: { anchor: 8 },
			extensions: [
				workspaceFacet.of(mockWorkspace),
				currentDocFacet.of(mockCurrentDoc),
			],
		});

		const context = new CompletionContext(state, 8, false);
		const result = wikilinkAutocompletion(context);
		expect(result).not.toBeNull();
		expect(result!.from).toBe(8); // after #
		expect(result!.options.map((o) => o.label)).toContain("Introduction");
		expect(result!.options.map((o) => o.label)).toContain("Deep Dive");
	});

	it("completes blocks on [[#^", () => {
		const state = EditorState.create({
			doc: "Jump [[#^",
			selection: { anchor: 9 },
			extensions: [
				workspaceFacet.of(mockWorkspace),
				currentDocFacet.of(mockCurrentDoc),
			],
		});

		const context = new CompletionContext(state, 9, false);
		const result = wikilinkAutocompletion(context);
		expect(result).not.toBeNull();
		expect(result!.options.map((o) => o.label)).toContain("dive-block");
	});
});
