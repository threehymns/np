import "../../../../tests/contract/rune-setup";
import { describe, it, expect, beforeAll, afterAll, mock } from "bun:test";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import {
	CompletionContext,
	autocompletion,
	startCompletion,
	type Completion,
	type CompletionResult,
} from "@codemirror/autocomplete";
import { workspaceFacet, currentDocFacet } from "./extensions/wikilinks";
import { completionCompartmentExtensions } from "./extensions/completion-sources";
import { readBufferWordSettings, type SettingReader } from "./extensions/completion-settings";
import {
	DEFAULT_BUFFER_WORD_SETTINGS,
	type BufferWordSettings,
} from "./extensions/buffer-words";

/** A settings reader over editor-level values plus one per-language map. */
function scopedSettingReader(
	languages: unknown,
	editorLevel: Record<string, unknown> = {},
): SettingReader {
	const stored: Record<string, unknown> = {
		words: "enabled",
		min_word_length: 3,
		languages,
		...editorLevel,
	};
	return (namespace, key) => (namespace === "editor" ? stored[key] : undefined);
}

/**
 * Composition regression net for the buffer-word source (issues #260, #261).
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
 * because that ordering is the contract under test, and goes through
 * `completionCompartmentExtensions` so the compartment also carries the popup
 * gate.
 */
async function composedExtensions(
	desc: LanguageDescription,
	opts: {
		words?: boolean;
		settings?: Partial<BufferWordSettings>;
		automaticCompletions?: boolean;
	} = {},
): Promise<Extension[]> {
	const languageCompartment = new Compartment();
	const completionCompartment = new Compartment();
	const language = await resolveActiveLanguage(desc);
	const settings: BufferWordSettings = {
		...DEFAULT_BUFFER_WORD_SETTINGS,
		...opts.settings,
	};
	const completion =
		opts.words === false
			? []
			: completionCompartmentExtensions({
					language,
					languageName: desc.name,
					automaticCompletions: opts.automaticCompletions ?? true,
					readSettings: () => settings,
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
 * Only the buffer-word offers. A code language brings its own completion
 * source (JavaScript offers its keywords), so an exact list of everything on
 * the chain would say more about the grammar than about this ticket.
 */
function offeredWordLabels(
	state: EditorState,
	pos: number,
	explicit: boolean,
): string[] {
	return offeredOptions(state, pos, explicit)
		.filter((o) => o.type === "text")
		.map((o) => o.label);
}

function markdownState(
	doc: string,
	opts: {
		words?: boolean;
		settings?: Partial<BufferWordSettings>;
		automaticCompletions?: boolean;
	} = {},
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

	it("stops automatic words everywhere when words are disabled, but not the explicit trigger", async () => {
		const doc = "Notes about widgets\n\nNot";
		const enabled = await markdownState(doc);
		const disabled = await markdownState(doc, { settings: { words: "disabled" } });

		// Off means quiet, not unavailable: prose was already quiet, and the
		// words are still there for the trigger that asked for them.
		expect(offeredLabels(disabled, doc.length, false)).toEqual([]);
		expect(offeredLabels(disabled, doc.length, true)).toEqual(["Notes"]);
		expect(offeredLabels(disabled, doc.length, true)).toEqual(
			offeredLabels(enabled, doc.length, true),
		);
	});

	it("applies a per-language override without touching the other languages", async () => {
		const read = scopedSettingReader({ Markdown: { words: "disabled" } });
		const note = await markdownState("Notes about widgets\n\nNot");
		const scoped = await markdownState("Notes about widgets\n\nNot", {
			settings: readBufferWordSettings(read, "Markdown"),
		});

		// Markdown's override folds in…
		expect(offeredLabels(scoped, note.doc.length, false)).toEqual([]);
		// …while another language stays on the editor-level value, which is
		// what makes the code auto-trigger fire there.
		expect(readBufferWordSettings(read, "TypeScript")).toEqual({
			words: "enabled",
			minWordLength: 3,
		});
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

	it("adds words on a typing trigger in a code file", async () => {
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

		// A code file is where the automatic trigger belongs; the baseline with
		// no word source at all offers no words on the same keystroke.
		expect(offeredWordLabels(state, doc.length, false)).toEqual(["totalCount"]);
		expect(offeredWordLabels(baseline, doc.length, false)).toEqual([]);
	});

	it("adds no words below the minimum length on a typing trigger in a code file", async () => {
		const desc = description("JavaScript");
		// Two characters typed against `counterValue`, under the default of three.
		const doc = "let counterValue = 1;\nco";
		const state = EditorState.create({
			doc,
			selection: { anchor: doc.length },
			extensions: await composedExtensions(desc),
		});

		expect(offeredWordLabels(state, doc.length, false)).toEqual([]);
	});

	it("tunes the code typing trigger from the minimum length", async () => {
		const desc = description("JavaScript");
		const doc = "let counterValue = 1;\nco";
		const state = EditorState.create({
			doc,
			selection: { anchor: doc.length },
			extensions: await composedExtensions(desc, { settings: { minWordLength: 2 } }),
		});

		expect(offeredWordLabels(state, doc.length, false)).toEqual(["counterValue"]);
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

describe("completion composition — the global popup toggle", () => {
	/**
	 * Which of the language's completion sources CodeMirror would query.
	 *
	 * `active` is the completion state field's own bookkeeping: an inactive
	 * source is never queried, so a pending one means exactly "this trigger
	 * summons an offer". The field has no public accessor without an
	 * `EditorView`, and `autocompletion()` publishes it as the second entry of
	 * the array it returns, so it is taken from there — nothing here reaches
	 * into CodeMirror's internals beyond that.
	 */
	function activeSources(state: EditorState): { pending: number; explicit: boolean } {
		const field = (autocompletion() as unknown as Record<string, unknown>[])[1];
		const completion = state.field(field as never) as unknown as {
			active: { state: number; explicit: boolean }[];
		};
		return {
			pending: completion.active.filter((source) => source.state !== 0).length,
			explicit: completion.active.every((source) => source.explicit),
		};
	}

	/** The state a single keystroke leaves behind. */
	function afterTyping(state: EditorState): EditorState {
		return state.update({ userEvent: "input.type" }).state;
	}

	/**
	 * The state the explicit trigger leaves behind, using the real
	 * `startCompletion` effect dispatched through a stub view. The toggle is
	 * not supposed to touch this path, so it must go through the library's own
	 * effect rather than a hand-rolled flag.
	 */
	function afterExplicitTrigger(state: EditorState): EditorState {
		let effects: unknown;
		startCompletion({
			state,
			dispatch: (spec: { effects: unknown }) => {
				effects = spec.effects;
			},
		} as never);
		return state.update({ effects: [effects as never] }).state;
	}

	it("stops every automatic offer when off, tables and wikilinks included", async () => {
		const on = await markdownState("Intro\n| See [[Not");
		const off = await markdownState("Intro\n| See [[Not", {
			automaticCompletions: false,
		});

		// The note sources are the ones the toggle has to reach: they are
		// registered through the language-data facet, not through our chain.
		expect(activeSources(afterTyping(on)).pending).toBeGreaterThan(0);
		expect(activeSources(afterTyping(off)).pending).toBe(0);
	});

	it("still answers the explicit trigger when off", async () => {
		const doc = "Intro\n| See [[Not";
		const state = await markdownState(doc, { automaticCompletions: false });

		const activation = activeSources(afterExplicitTrigger(state));
		// Every source the language registered wakes up on the explicit effect,
		// and each one is told it was asked for explicitly.
		expect(activation.pending).toBeGreaterThan(0);
		expect(activation.explicit).toBe(true);
		// And the offers themselves are unchanged by the toggle.
		expect(offeredLabels(state, state.doc.length, true)).toEqual(
			offeredLabels(await markdownState(doc), state.doc.length, true),
		);
	});

	it("leaves the automatic trigger alone when on", async () => {
		const state = await markdownState("Notes about widgets\n\nNot");

		expect(activeSources(afterTyping(state)).pending).toBeGreaterThan(0);
	});
});
