import "../../../../tests/contract/rune-setup";
import { describe, it, expect, beforeAll, afterAll, mock } from "bun:test";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import {
	CompletionContext,
	type Completion,
	type CompletionResult,
} from "@codemirror/autocomplete";
import { workspaceFacet, currentDocFacet } from "./extensions/wikilinks";
import {
	COMPLETION_RANK_TIERS,
	hostCompletionChain,
} from "./extensions/completion-sources";
import type { RegisteredSnippet } from "@np/core";

/**
 * Composition regression net for the host completion chain (issue #260 for the
 * buffer-word source, issue #262 for the snippet source).
 *
 * Everything here drives the real editor wiring: the extension array
 * `createEditorExtensions` builds, with the completion compartment placed
 * after the language one. The assertions are on offered labels and their
 * order, never on source internals.
 */

let getLanguageExtensions: (desc: LanguageDescription | null) => Promise<Extension[]>;
let resolveActiveLanguage: (desc: LanguageDescription | null) => Promise<any>;

beforeAll(async () => {
	mock.module("svelte/reactivity", () => ({
		SvelteMap: Map,
		SvelteSet: Set,
	}));
	// codemirror-markdown-tables probes `window.matchMedia` from a state-field
	// initializer, and bun test has no DOM. Both probes feed view-only editor
	// attributes, so the real Markdown extension array builds fine with a stub.
	(globalThis as Record<string, unknown>).window = {
		matchMedia: () => ({ matches: false }),
	};
	const mod = await import("./index");
	getLanguageExtensions = mod.getLanguageExtensions;
	resolveActiveLanguage = mod.resolveActiveLanguage;
});

afterAll(() => {
	delete (globalThis as Record<string, unknown>).window;
});

const mockWorkspace: any = {
	project: {
		projectTree: {
			nodes: [
				{
					kind: "file",
					name: "Note A.md",
					origin: { scheme: "file", path: "/worktree/Note A.md", name: "Note A.md" },
				},
				{
					kind: "file",
					name: "Research.md",
					origin: { scheme: "file", path: "/worktree/Research.md", name: "Research.md" },
				},
			],
		},
	},
	documents: [],
};

const mockCurrentDoc: any = {
	content: "# Introduction\nIntro\n\n## Deep Dive\nDetails\n^dive-block\n",
};

function description(name: string): LanguageDescription {
	const desc = languages.find((l) => l.name === name);
	expect(desc).toBeDefined();
	return desc!;
}

/**
 * The editor's extension array: note sources from the language compartment,
 * then the completion compartment. Mirrors `createEditorExtensions` ordering
 * because that ordering is the contract under test.
 */
async function composedExtensions(
	desc: LanguageDescription,
	opts: { words?: boolean; snippets?: readonly RegisteredSnippet[] } = {},
): Promise<Extension[]> {
	const languageCompartment = new Compartment();
	const completionCompartment = new Compartment();
	const language = await resolveActiveLanguage(desc);
	const completion =
		opts.words === false
			? []
			: hostCompletionChain({
					language,
					languageName: desc.name,
					snippets: opts.snippets ?? [],
				});

	return [
		workspaceFacet.of(mockWorkspace),
		currentDocFacet.of(mockCurrentDoc),
		languageCompartment.of(await getLanguageExtensions(desc)),
		completionCompartment.of(completion),
	];
}

/** Runs every source CodeMirror would run, in chain order, and merges offers. */
function offeredOptions(
	state: EditorState,
	pos: number,
	explicit: boolean,
): Completion[] {
	const context = new CompletionContext(state, pos, explicit);
	const options: Completion[] = [];
	for (const source of state.languageDataAt("autocomplete", pos) as any[]) {
		const result = source(context as any) as CompletionResult | null;
		if (result) options.push(...result.options);
	}
	return options;
}

/** Offer labels in the order CodeMirror would rank them into the popover. */
function offeredLabels(
	state: EditorState,
	pos: number,
	explicit: boolean,
): string[] {
	return offeredOptions(state, pos, explicit).map((o) => o.label);
}

/**
 * Offer labels in the order CodeMirror's popover would show them. CodeMirror
 * sorts on `fuzzy score + boost` descending; every option in these fixtures
 * is the same shape of match for the same typed prefix, so the fuzzy score is
 * equal and the boost alone decides. The index breaks ties so note options
 * keep the order the note sources produced them in.
 */
function rankedLabels(
	state: EditorState,
	pos: number,
	explicit: boolean,
): string[] {
	return offeredOptions(state, pos, explicit)
		.map((option, index) => ({
			label: option.label,
			key: (option.boost ?? COMPLETION_RANK_TIERS.noteSources) * 1000 - index,
		}))
		.sort((a, b) => b.key - a.key)
		.map((entry) => entry.label);
}

function markdownState(
	doc: string,
	opts?: { words?: boolean; snippets?: readonly RegisteredSnippet[] },
): Promise<EditorState> {
	return composedExtensions(description("Markdown"), opts).then((extensions) =>
		EditorState.create({ doc, selection: { anchor: doc.length }, extensions }),
	);
}

describe("completion composition — Markdown", () => {
	it("offers note completions before buffer words on the explicit trigger", async () => {
		const doc = "Notes about widgets\n\nSee [[Not";
		const state = await markdownState(doc);

		// The wikilink offer leads, every buffer word follows it, and the
		// unrelated note is filtered out exactly as before.
		expect(offeredLabels(state, doc.length, true)).toEqual(["Note A", "Notes"]);
	});

	it("preserves the existing sources' own order ahead of the words", async () => {
		const doc = "Notebook notes\n\nSee [[Not";
		const withWords = await markdownState(doc);
		const withoutWords = await markdownState(doc, { words: false });

		expect(offeredLabels(withoutWords, doc.length, true)).toEqual(["Note A"]);
		expect(offeredLabels(withWords, doc.length, true)).toEqual([
			"Note A",
			"Notebook",
			"notes",
		]);
	});

	it("ranks every buffer word below every note option", async () => {
		const doc = "Notebook notes\n\nSee [[Not";
		const state = await markdownState(doc);
		const options = offeredOptions(state, doc.length, true);

		const noteBoosts = options
			.filter((o) => o.type !== "text")
			.map((o) => o.boost ?? 0);
		const wordBoosts = options
			.filter((o) => o.type === "text")
			.map((o) => o.boost ?? 0);

		expect(noteBoosts.length).toBeGreaterThan(0);
		expect(wordBoosts.length).toBeGreaterThan(0);
		// The existing sources carry no boost, and CodeMirror sorts on
		// fuzzy score + boost descending with every fuzzy score <= 0 — so a
		// negative boost is an unconditionally lower rank.
		expect(noteBoosts).toEqual(noteBoosts.map(() => 0));
		expect(Math.min(...wordBoosts)).toBeLessThan(0);
	});

	it("leaves the table source's offers unchanged", async () => {
		const doc = "Intro\n|";
		const withWords = await markdownState(doc);
		const withoutWords = await markdownState(doc, { words: false });

		const labels = offeredLabels(withWords, doc.length, true);
		expect(labels).toEqual(offeredLabels(withoutWords, doc.length, true));
		expect(labels.length).toBeGreaterThan(0);
	});

	it("leaves automatic wikilink offers unchanged", async () => {
		const doc = "See [[Not";
		const withWords = await markdownState(doc);
		const withoutWords = await markdownState(doc, { words: false });

		expect(offeredLabels(withWords, doc.length, false)).toEqual(
			offeredLabels(withoutWords, doc.length, false),
		);
	});

	it("leaves heading and block completions unchanged", async () => {
		for (const doc of ["Jump [[#", "Jump [[#^"]) {
			const withWords = await markdownState(doc);
			const withoutWords = await markdownState(doc, { words: false });

			expect(offeredLabels(withWords, doc.length, true)).toEqual(
				offeredLabels(withoutWords, doc.length, true),
			);
		}
	});

	it("leaves automatic table offers unchanged", async () => {
		const doc = "Intro\n|";
		const withWords = await markdownState(doc);
		const withoutWords = await markdownState(doc, { words: false });

		expect(offeredLabels(withWords, doc.length, false)).toEqual(
			offeredLabels(withoutWords, doc.length, false),
		);
	});

	it("adds nothing automatic in Markdown prose", async () => {
		const doc = "Notes about widgets\n\nNot";
		const state = await markdownState(doc);

		expect(offeredOptions(state, doc.length, false)).toEqual([]);
	});

	it("answers the explicit trigger in Markdown prose with document words only", async () => {
		const doc = "Notes about widgets\n\nNot";
		const state = await markdownState(doc);

		expect(offeredLabels(state, doc.length, true)).toEqual(["Notes"]);
	});
});

describe("completion composition — code files", () => {
	it("offers document words on the explicit trigger", async () => {
		const desc = description("JavaScript");
		const extensions = await composedExtensions(desc);
		const doc = "const totalCount = computeTotals(rows);\ntotal";
		const state = EditorState.create({
			doc,
			selection: { anchor: doc.length },
			extensions,
		});

		const labels = offeredLabels(state, doc.length, true);
		expect(labels).toContain("totalCount");
		// The token under the cursor is the prefix, never an offer.
		expect(labels).not.toContain("total");
	});

	it("adds nothing on a typing trigger in a code file", async () => {
		const desc = description("JavaScript");
		const doc = "const totalCount = computeTotals(rows);\ntotal";
		const state = EditorState.create({
			doc,
			selection: { anchor: doc.length },
			extensions: await composedExtensions(desc),
		});
		const baseline = EditorState.create({
			doc,
			selection: { anchor: doc.length },
			extensions: await composedExtensions(desc, { words: false }),
		});

		expect(offeredLabels(state, doc.length, false)).toEqual(
			offeredLabels(baseline, doc.length, false),
		);
	});

	it("contributes no source at all in a document with no language", async () => {
		const doc = "Notes about widgets\n\nNot";
		const plain = EditorState.create({
			doc,
			selection: { anchor: doc.length },
			extensions: [
				workspaceFacet.of(mockWorkspace),
				currentDocFacet.of(mockCurrentDoc),
			],
		});

		// Plain text has no language to attach a source to; it must answer
		// nothing rather than throw.
		expect(await resolveActiveLanguage(null)).toBeNull();
		expect(offeredOptions(plain, doc.length, true)).toEqual([]);
	});
});

/**
 * The snippet source joins on a registered language, so a fixture pack stands
 * in for whatever plugin registered the real one; the registry side is proven
 * in `packages/core/src/plugins/completions.test.ts`.
 */
function snippet(
	id: string,
	trigger: string,
	opts: { language?: string; body?: string; description?: string } = {},
): RegisteredSnippet {
	return {
		id,
		language: opts.language ?? "Markdown",
		trigger,
		body: opts.body ?? `${trigger} body`,
		description: opts.description ?? `${trigger} description`,
		owner: "fixture",
	};
}

describe("completion composition — snippet source", () => {
	it("offers a registered trigger with its body as the inserted text", async () => {
		const body = "{#each items as item}\n\t\n{/each}";
		const doc = "ea";
		const state = await markdownState(doc, {
			snippets: [snippet("each", "each", { body })],
		});

		const options = offeredOptions(state, doc.length, true);
		expect(options.map((o) => o.label)).toEqual(["each"]);
		expect(options[0].detail).toBe("each description");
		expect(options[0].type).toBe("keyword");
		// The match range is the trigger itself, so accepting replaces the
		// typed prefix rather than inserting in front of it.
		expect(options[0].apply).toBeDefined();
	});

	it("answers a typing trigger as well as the explicit one", async () => {
		const doc = "rea";
		const state = await markdownState(doc, {
			snippets: [snippet("reactive", "reactive")],
		});

		expect(offeredLabels(state, doc.length, false)).toEqual(["reactive"]);
	});

	it("offers only triggers extending the typed prefix", async () => {
		const doc = "pro";
		const state = await markdownState(doc, {
			snippets: [snippet("props", "props"), snippet("transition", "transition")],
		});

		expect(offeredLabels(state, doc.length, true)).toEqual(["props"]);
	});

	it("contributes nothing for another language and nothing for an empty prefix", async () => {
		const otherLanguage = "each";
		const state = await markdownState(otherLanguage, {
			snippets: [snippet("each", "each", { language: "svelte" })],
		});
		expect(offeredOptions(state, otherLanguage.length, true)).toEqual([]);

		const empty = await markdownState("see ", {
			snippets: [snippet("each", "each")],
		});
		expect(offeredOptions(empty, 4, true)).toEqual([]);
	});

	it("ranks an exact snippet-trigger match below note sources and above words", async () => {
		// "Not" reaches all three tiers: the wikilink source offers the note
		// "Note A", the fixture pack offers the trigger "Notebook", and the
		// buffer offers the word "Notebook".
		const doc = "Notebook notes\n\nSee [[Not";
		const state = await markdownState(doc, {
			snippets: [snippet("notebook", "Notebook", { body: "snippet body" })],
		});
		const options = offeredOptions(state, doc.length, true);

		const note = options.find((o) => o.label === "Note A")!;
		const triggers = options.filter((o) => o.label === "Notebook");
		const words = options.filter((o) => o.label === "Notebook" && o.type === "text");
		const snippetOption = triggers.find((o) => o.type === "keyword")!;
		expect(note).toBeDefined();
		expect(words.length).toBe(1);

		expect(note.boost ?? COMPLETION_RANK_TIERS.noteSources).toBe(
			COMPLETION_RANK_TIERS.noteSources,
		);
		expect(snippetOption.boost).toBe(COMPLETION_RANK_TIERS.snippets);
		expect(words[0].boost).toBe(COMPLETION_RANK_TIERS.words);
		expect(COMPLETION_RANK_TIERS.noteSources).toBeGreaterThan(
			COMPLETION_RANK_TIERS.snippets,
		);
		expect(COMPLETION_RANK_TIERS.snippets).toBeGreaterThan(COMPLETION_RANK_TIERS.words);

		// Both boosts stay below CodeMirror's fuzzy-score floor, so the tiers
		// hold for any note label rather than only for this fixture.
		const fuzzyFloor = -3000;
		expect(COMPLETION_RANK_TIERS.snippets).toBeLessThan(fuzzyFloor);
		expect(COMPLETION_RANK_TIERS.words).toBeLessThan(fuzzyFloor);

		expect(rankedLabels(state, doc.length, true)).toEqual([
			"Note A",
			"Notebook",
			"Notebook",
			"notes",
		]);
	});

	it("registers the snippet source ahead of the word source in the chain", async () => {
		const doc = "each";
		const state = await markdownState(doc, {
			snippets: [snippet("each", "each")],
		});
		const labels = offeredLabels(state, doc.length, true);

		// Chain order, not ranked order: the snippet source is consulted
		// before the word source.
		expect(labels.indexOf("each")).toBe(0);
	});

	it("leaves the note sources' own offers unchanged when a pack is registered", async () => {
		const doc = "Notebook notes\n\nSee [[Not";
		const withoutSnippets = await markdownState(doc);
		const withSnippets = await markdownState(doc, {
			snippets: [snippet("notebook", "Notebook")],
		});

		const notes = (state: EditorState) =>
			offeredOptions(state, doc.length, true)
				.filter((o) => o.type !== "text" && o.type !== "keyword")
				.map((o) => o.label);
		expect(notes(withSnippets)).toEqual(notes(withoutSnippets));
		expect(notes(withSnippets)).toEqual(["Note A"]);
	});
});
