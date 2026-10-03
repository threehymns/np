import "../../../../tests/contract/rune-setup";
import { describe, it, expect, beforeAll, afterAll, mock } from "bun:test";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
import { EditorView, keymap, type KeyBinding } from "@codemirror/view";
import { LanguageDescription, type Language } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import {
	CompletionContext,
	completionStatus,
	currentCompletions,
	startCompletion,
	type Completion,
	type CompletionResult,
	type CompletionSource,
} from "@codemirror/autocomplete";
import { workspaceFacet, currentDocFacet } from "./extensions/wikilinks";
import {
	COMPLETION_RANK_TIERS,
	completionCompartmentExtensions,
} from "./extensions/completion-sources";
import { readBufferWordSettings, type SettingReader } from "./extensions/completion-settings";
import {
	DEFAULT_BUFFER_WORD_SETTINGS,
	type BufferWordSettings,
} from "./extensions/buffer-words";
import type { RegisteredSnippet } from "@np/core";

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
 * Composition regression net for the host completion chain: issue #260 for the
 * buffer-word source, #261 for the trigger split and the settings behind it,
 * #262 for the snippet source.
 *
 * Everything here drives the real editor wiring: the extension array
 * `createEditorExtensions` builds, with the completion compartment placed
 * after the language one. The assertions are on offered labels and their
 * order, never on source internals.
 */

let getLanguageExtensions: (desc: LanguageDescription | null) => Promise<Extension[]>;
let resolveActiveLanguage: (desc: LanguageDescription | null) => Promise<any>;

let installedDom = false;

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
	// The ranked-order assertion needs a mounted view (see `popoverOrder`), which
	// needs a DOM. This is the same minimal stub `html.test.ts` installs, kept
	// here because nothing else in this suite touches the DOM.
	if (typeof (globalThis as Record<string, unknown>).document === "undefined") {
		installMinimalDom();
		installedDom = true;
	}
	const mod = await import("./index");
	getLanguageExtensions = mod.getLanguageExtensions;
	resolveActiveLanguage = mod.resolveActiveLanguage;
});

afterAll(() => {
	delete (globalThis as Record<string, unknown>).window;
	if (installedDom) delete (globalThis as Record<string, unknown>).document;
});

/**
 * The smallest `document`/`window` an `EditorView` will mount against. Every
 * member here was added in response to a real throw from the view, the
 * tooltip, or the completion machinery.
 */
function installMinimalDom(): void {
	class MockElement {
		tagName: string;
		style: Record<string, any> = {};
		childNodes: any[] = [];
		attributes: any[] = [];
		dataset: Record<string, string> = {};
		classList = { add: () => {}, remove: () => {}, contains: () => false };
		ownerDocument: any;
		parentNode: any = null;
		offsetWidth = 100;
		offsetHeight = 20;
		clientWidth = 100;
		clientHeight = 20;
		textContent = "";
		constructor(tag = "DIV") {
			this.tagName = tag.toUpperCase();
			this.ownerDocument = (globalThis as any).document;
		}
		setAttribute() {}
		getAttribute() { return null; }
		removeAttribute() {}
		appendChild(child: any) {
			this.childNodes.push(child);
			child.parentNode = this;
			return child;
		}
		insertBefore(child: any) { return this.appendChild(child); }
		removeChild(child: any) { this.childNodes = this.childNodes.filter((c) => c !== child); }
		remove() { this.parentNode = null; }
		addEventListener() {}
		removeEventListener() {}
		contains() { return false; }
		getBoundingClientRect() {
			return { top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 20 };
		}
		querySelectorAll() { return []; }
	}

	const document = {
		head: new MockElement("HEAD"),
		body: new MockElement("BODY"),
		createElement: (tag: string) => new MockElement(tag),
		createDocumentFragment: () => new MockElement("FRAGMENT"),
		createTextNode: (text: string) => ({
			nodeValue: text,
			ownerDocument: (globalThis as any).document,
		}),
		createRange: () => ({
			setStart() {},
			setEnd() {},
			getBoundingClientRect: () => ({ top: 0, left: 0 }),
		}),
		hasFocus: () => false,
		defaultView: undefined as any,
		addEventListener: () => {},
		removeEventListener: () => {},
		getSelection: () => null,
		insertBefore: (child: any) => child,
		elementFromPoint: () => null,
	};
	const view = {
		getComputedStyle: () => ({ getPropertyValue: () => "", direction: "ltr" }),
		requestAnimationFrame: () => 0,
		cancelAnimationFrame: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
	};

	(globalThis as any).document = document;
	(globalThis as any).window = {
		...(globalThis as any).window,
		document,
		...view,
		matchMedia: () => ({
			matches: false,
			addListener: () => {},
			removeListener: () => {},
		}),
	};
	// The view resolves its window through `document.defaultView`, which has to
	// be the window above rather than whatever was there before.
	document.defaultView = (globalThis as any).window;
	(globalThis as any).MutationObserver = class {
		observe() {}
		disconnect() {}
		takeRecords() { return []; }
	};
	(globalThis as any).ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
	(globalThis as any).Range = class {};
	(globalThis as any).Window = class Window {};
	(globalThis as any).requestAnimationFrame = () => 0;
	(globalThis as any).cancelAnimationFrame = () => {};
	(globalThis as any).getComputedStyle = view.getComputedStyle;
}

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
		snippets?: readonly RegisteredSnippet[];
		settings?: Partial<BufferWordSettings>;
		automaticCompletions?: boolean;
		recorder?: QueryRecorder;
	} = {},
): Promise<Extension[]> {
	const languageCompartment = new Compartment();
	const completionCompartment = new Compartment();
	const language: Language = await resolveActiveLanguage(desc);
	const settings: BufferWordSettings = {
		...DEFAULT_BUFFER_WORD_SETTINGS,
		...opts.settings,
	};
	const host =
		opts.words === false
			? []
			: completionCompartmentExtensions({
					language,
					languageName: desc.name,
					snippets: opts.snippets ?? [],
					automaticCompletions: opts.automaticCompletions ?? true,
					readSettings: () => settings,
				});

	return [
		workspaceFacet.of(mockWorkspace),
		currentDocFacet.of(mockCurrentDoc),
		languageCompartment.of(await getLanguageExtensions(desc)),
		completionCompartment.of(
			opts.recorder
				? [...host, language.data.of({ autocomplete: opts.recorder.source })]
				: host,
		),
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
 * Records how CodeMirror queried every source, through the one place the
 * library tells a source what kind of trigger woke it: the `explicit` flag on
 * the public `CompletionContext`. A source that returns `null` contributes no
 * offers, so a recorder never disturbs the labels the other assertions read.
 */
interface QueryRecorder {
	readonly source: CompletionSource;
	/** The `explicit` flag of each query, in the order they arrived. */
	readonly flags: boolean[];
}

function queryRecorder(): QueryRecorder {
	const flags: boolean[] = [];
	return {
		flags,
		source: (context) => {
			flags.push(context.explicit);
			return null;
		},
	};
}

/**
 * Only the buffer-word offers. A code language brings its own completion
 * source (JavaScript offers its keywords) and the snippet pack offers its
 * triggers, so an exact list of everything on the chain would say more about
 * the other sources than about this ticket.
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

/** Which rank tier an offered option belongs to, by the type its source set. */
function tierOf(option: Completion): "note" | "snippet" | "word" {
	if (option.type === "keyword") return "snippet";
	if (option.type === "text") return "word";
	return "note";
}

/**
 * Mounts the state, wakes the chain the way a keystroke or the explicit
 * trigger would, and reports what the library settled on.
 *
 * A source is only ever *called* by the completion view plugin, so observing
 * how CodeMirror asks its sources — whether it asks at all, and whether it
 * marks the question explicit — needs a mounted view. `completionStatus` and
 * `currentCompletions` are the public readings of that; nothing here reaches
 * past them. This is the only place in the file that needs a view: every other
 * assertion reads offers through a `CompletionContext`, which needs no DOM.
 */
async function driveCompletion(
	state: EditorState,
	recorder: QueryRecorder,
	trigger: "typing" | "explicit",
): Promise<{
	status: "active" | "pending" | null;
	queries: boolean[];
	options: Completion[];
}> {
	const view = new EditorView({
		state,
		parent: (globalThis as any).document.createElement("div"),
	});
	try {
		if (trigger === "explicit") {
			expect(startCompletion(view)).toBe(true);
		} else {
			view.dispatch({ userEvent: "input.type" });
		}
		// The machinery debounces a wake-up and answers through a promise, so a
		// headless run has to let both queues drain. `completionStatus` is the
		// public "still asking" signal.
		for (let waited = 0; waited < 2_000; waited += 20) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			if (completionStatus(view.state) !== "pending") break;
		}
		return {
			status: completionStatus(view.state),
			queries: [...recorder.flags],
			options: [...currentCompletions(view.state)],
		};
	} finally {
		view.destroy();
	}
}

/** The ranked popover as `label:tier`, which is the order a reader would see. */
async function rankedPopover(state: EditorState): Promise<string[]> {
	const { options } = await driveCompletion(state, queryRecorder(), "explicit");
	return options.map((option) => `${option.label}:${tierOf(option)}`);
}

function markdownState(
	doc: string,
	opts: {
		words?: boolean;
		snippets?: readonly RegisteredSnippet[];
		settings?: Partial<BufferWordSettings>;
		automaticCompletions?: boolean;
		recorder?: QueryRecorder;
	} = {},
): Promise<EditorState> {
	return composedExtensions(description("Markdown"), opts).then((extensions) =>
		EditorState.create({ doc, selection: { anchor: doc.length }, extensions }),
	);
}

/** The state a single keystroke leaves behind. */
function afterTyping(state: EditorState): EditorState {
	return state.update({ userEvent: "input.type" }).state;
}

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
			wordsOverridden: false,
		});
	});

	it("lets an explicit per-language 'enabled' override make prose answer automatically", async () => {
		const read = scopedSettingReader({ Markdown: { words: "enabled" } });
		const doc = "Notes about widgets\n\nNot";
		const quiet = await markdownState(doc);
		const overridden = await markdownState(doc, {
			settings: readBufferWordSettings(read, "Markdown"),
		});

		// Prose silence is a default, not a rule: the settings UI offers this
		// exact edit, so it has to do what it says. 'Not' is three characters,
		// past the minimum, and the buffer holds "Notes".
		expect(offeredOptions(quiet, doc.length, false)).toEqual([]);
		expect(offeredWordLabels(overridden, doc.length, false)).toEqual(["Notes"]);
	});

	it("keeps prose quiet for an explicit 'disabled' override, as for no override", async () => {
		const read = scopedSettingReader({ Markdown: { words: "disabled" } });
		const doc = "Notes about widgets\n\nNot";
		const state = await markdownState(doc, {
			settings: readBufferWordSettings(read, "Markdown"),
		});

		expect(offeredOptions(state, doc.length, false)).toEqual([]);
		// Quiet, not unavailable: the explicit trigger still answers.
		expect(offeredLabels(state, doc.length, true)).toEqual(["Notes"]);
	});

	it("keeps prose quiet for an override that tuned only the threshold", async () => {
		// A Markdown entry that says nothing about `words` is not a vote on it,
		// however much of a Markdown entry it is.
		const read = scopedSettingReader({ Markdown: { min_word_length: 2 } });
		const doc = "Notes about widgets\n\nNot";
		const state = await markdownState(doc, {
			settings: readBufferWordSettings(read, "Markdown"),
		});

		expect(readBufferWordSettings(read, "Markdown").wordsOverridden).toBe(false);
		expect(offeredOptions(state, doc.length, false)).toEqual([]);
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

describe("completion composition — snippet source", () => {
	/** Applies an option to a fake view and returns the resulting document. */
	function appliedDoc(
		option: Completion,
		state: EditorState,
		from: number,
		to: number,
	): string {
		let spec: any = null;
		const view = { state, dispatch: (next: any) => (spec = next) };
		option.apply!(view as never, option, from, to);
		return state.update(spec).state.doc.toString();
	}

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
		// The match range is the trigger itself, so accepting replaces the typed
		// prefix rather than inserting in front of it: "ea" becomes the body.
		expect(appliedDoc(options[0], state, 0, doc.length)).toBe(body);
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

		// The note sources carry no boost at all. `toBeUndefined` rather than a
		// defaulting `?? 0`: the point is that nothing boosts them, so this fails
		// if a boost is ever added to the note tier.
		expect(note.boost).toBeUndefined();
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

		// And the order those boosts are supposed to produce, as the popover
		// actually renders it: note first, then the exact snippet trigger, then
		// the words.
		expect(await rankedPopover(state)).toEqual([
			"Note A:note",
			"Notebook:snippet",
			"Notebook:word",
			"notes:word",
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

	it("adds no snippet offer on a typing trigger while the popup toggle is off, and still answers the explicit one", async () => {
		const doc = "ea";
		const pack = [snippet("each", "each")];
		const onQueries = queryRecorder();
		const offQueries = queryRecorder();
		const on = await markdownState(doc, { snippets: pack, recorder: onQueries });
		const off = await markdownState(doc, {
			snippets: pack,
			automaticCompletions: false,
			recorder: offQueries,
		});

		// The toggle is the whole gate, so the snippet source itself is
		// unchanged — only whether CodeMirror wakes it on the keystroke. A woken
		// source is called, so the recorder shows it: one automatic query with
		// the toggle on, none at all with it off.
		const onRun = await driveCompletion(on, onQueries, "typing");
		expect(onRun.status).toBe("active");
		expect(onRun.queries).toEqual([false]);

		const offRun = await driveCompletion(off, offQueries, "typing");
		expect(offRun.status).toBeNull();
		expect(offRun.queries).toEqual([]);
		expect(offRun.options).toEqual([]);

		// And the trigger that asked for them still gets them, told explicitly.
		const triggered = await driveCompletion(off, offQueries, "explicit");
		expect(triggered.status).toBe("active");
		expect(triggered.queries).toEqual([true]);
		expect(triggered.options.map((option) => option.label)).toEqual(["each"]);
	});
});

describe("completion composition — modal editing", () => {
	/**
	 * The bindings CodeMirror will consult, read through the public `keymap`
	 * facet with the compartment's content installed. `autocompletion()`
	 * contributes its own keymap through `keymap.computeN`, so the bundled
	 * Enter binding shows up here exactly as it would in a real editor.
	 */
	function bindingsFor(vimEnabled: boolean): readonly KeyBinding[] {
		// `keymap.computeN` contributes its value as one array element, so the
		// facet reads one level nested.
		return EditorState.create({
			extensions: completionCompartmentExtensions({
				language: null,
				languageName: null,
				snippets: [],
				automaticCompletions: true,
				vimEnabled,
			}),
		}).facet(keymap).flat();
	}

	it("binds Enter to acceptCompletion when vim is off", () => {
		const keys = bindingsFor(false).map((binding) => binding.key);

		expect(keys).toContain("Enter");
		expect(keys).not.toContain("Ctrl-y");
		// The explicit trigger stays where it was either way.
		expect(keys).toContain("Ctrl-Space");
	});

	it("unbinds Enter and binds Ctrl-y when vim is on", () => {
		const keys = bindingsFor(true).map((binding) => binding.key);

		// Under vim, Enter belongs to the mode: a completion must never consume
		// the keystroke a vim insert-mode user means as a newline. Ctrl-y is
		// vim's canonical accept, and the trigger key is untouched.
		expect(keys).not.toContain("Enter");
		expect(keys).toContain("Ctrl-y");
		expect(keys).toContain("Ctrl-Space");
		// Everything else the bundled keymap had is kept, in order, so nothing
		// else moves. The mac-only bindings carry no `key`, which is why this
		// compares sequences rather than sets.
		const withoutVim = bindingsFor(false).map((binding) => binding.key);
		expect(keys.filter((key) => key !== "Ctrl-y")).toEqual(
			withoutVim.filter((key) => key !== "Enter"),
		);
	});
});

describe("completion composition — the global popup toggle", () => {
	it("stops every automatic offer when off, tables and wikilinks included", async () => {
		const queries = queryRecorder();
		const on = await markdownState("Intro\n| See [[Not", { recorder: queries });
		const off = await markdownState("Intro\n| See [[Not", {
			automaticCompletions: false,
		});

		// The note sources are the ones the toggle has to reach: they are
		// registered through the language-data facet, not through our chain. The
		// recorder answers "is any source being asked", which is the claim, and
		// the popover it produced is the effect.
		const onRun = await driveCompletion(on, queries, "typing");
		expect(onRun.status).toBe("active");
		expect(onRun.queries.length).toBeGreaterThan(0);
		expect(onRun.options.map((option) => option.label)).toEqual(["Note A"]);

		const offRun = await driveCompletion(off, queryRecorder(), "typing");
		expect(offRun.status).toBeNull();
		expect(offRun.options).toEqual([]);
	});

	it("still answers the explicit trigger when off", async () => {
		const doc = "Intro\n| See [[Not";
		const queries = queryRecorder();
		const state = await markdownState(doc, {
			automaticCompletions: false,
			recorder: queries,
		});

		// Every source the language registered wakes up on the explicit effect,
		// and each one is told through the public `CompletionContext` that it was
		// asked for explicitly rather than by typing.
		const run = await driveCompletion(state, queries, "explicit");
		expect(run.status).toBe("active");
		expect(run.queries.length).toBeGreaterThan(0);
		expect(run.queries.every((explicit) => explicit)).toBe(true);
		// And the offers themselves are unchanged by the toggle.
		expect(run.options.map((option) => option.label)).toEqual(
			(await driveCompletion(await markdownState(doc), queryRecorder(), "explicit")).options.map(
				(option) => option.label,
			),
		);
	});

	it("leaves the automatic trigger alone when on", async () => {
		const state = await markdownState("Notes about widgets\n\nNot");

		expect(completionStatus(afterTyping(state))).not.toBeNull();
	});
});
