import "../../../../tests/contract/rune-setup";
import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import {
	CompletionContext,
	completionStatus,
	currentCompletions,
	startCompletion,
	type Completion,
	type CompletionResult,
} from "@codemirror/autocomplete";
import {
	LSP_LOG_STORE_SERVICE_KEY,
	LSP_RUNTIME_SERVICE_KEY,
	LSP_TRANSPORT_SERVICE_KEY,
	lspRegistration,
	PluginHost,
	type LspCompletionOutcome,
	type LspCompletionRequest,
	type LspLogStore,
	type LspRuntime,
} from "@np/core";
import {
	createRealProcessTransport,
	waitFor,
	type RealProcessTransport
} from "../../../../tests/fixtures/lsp-transport";
import { currentDocFacet, workspaceFacet } from "./extensions/wikilinks";
import {
	COMPLETION_RANK_TIERS,
	completionCompartmentExtensions,
} from "./extensions/completion-sources";
import {
	readBufferWordSettings,
	readServerCompletionSettings,
	type SettingReader,
} from "./extensions/completion-settings";
import {
	DEFAULT_SERVER_COMPLETION_SETTINGS,
	type ServerCompletionSettings,
} from "./extensions/server-completions";
import { resolveBufferWordPolicy } from "./extensions/buffer-words";

/**
 * Server completions in the composed chain, against the scripted stub (spec
 * #263, #265).
 *
 * Every server here is the stub spawned as a real process over the real
 * transport and driven by the real client, so the framing, the handshake and the
 * request are genuinely exercised — ADR 0004's argument for real `git`, applied
 * to the LSP plugin. Only the executable is swapped: a real vtsls would index a
 * project to answer one query, which is minutes of work and a machine-dependent
 * answer, where the stub answers in milliseconds and identically on every CI
 * runner, Windows included.
 *
 * The claims are #265's: server items arrive with documentation and in the
 * composed order above words; a server that fails or times out leaves words
 * answering rather than silence; and all five settings behave per language.
 */

let getLanguageExtensions: (desc: LanguageDescription | null) => Promise<Extension[]>;
let resolveActiveLanguage: (desc: LanguageDescription | null) => Promise<any>;

const cleanups: Array<() => Promise<void> | void> = [];
const projects: string[] = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()!();
	while (projects.length > 0) {
		rmSync(projects.pop()!, { recursive: true, force: true });
	}
});

beforeAll(async () => {
	mock.module("svelte/reactivity", () => ({ SvelteMap: Map, SvelteSet: Set }));
	// Only when nothing has installed one: several suites in this package share
	// this stub, and clobbering `window` out from under a suite that already
	// installed a DOM leaves the next mounted view with no `document` at all.
	if (typeof (globalThis as Record<string, unknown>).document === "undefined") {
		installMinimalDom();
	}
	const mod = await import("./index");
	getLanguageExtensions = mod.getLanguageExtensions;
	resolveActiveLanguage = mod.resolveActiveLanguage;
});

/**
 * The smallest `document`/`window` an `EditorView` will mount against. Same stub
 * `completion-composition.test.ts` and `html.test.ts` install; duplicated rather
 * than shared because it is a test-local crutch, not production surface.
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
		getAttribute() {
			return null;
		}
		removeAttribute() {}
		appendChild(child: any) {
			this.childNodes.push(child);
			child.parentNode = this;
			return child;
		}
		insertBefore(child: any) {
			return this.appendChild(child);
		}
		removeChild(child: any) {
			this.childNodes = this.childNodes.filter((c: any) => c !== child);
		}
		remove() {
			this.parentNode = null;
		}
		addEventListener() {}
		removeEventListener() {}
		contains() {
			return false;
		}
		getBoundingClientRect() {
			return { top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 20 };
		}
		querySelectorAll() {
			return [];
		}
	}

	const document = {
		head: new MockElement("HEAD"),
		body: new MockElement("BODY"),
		createElement: (tag: string) => new MockElement(tag),
		createDocumentFragment: () => new MockElement("FRAGMENT"),
		createTextNode: (text: string) => ({
			nodeValue: text,
			ownerDocument: (globalThis as any).document
		}),
		createRange: () => ({
			setStart() {},
			setEnd() {},
			getBoundingClientRect: () => ({ top: 0, left: 0 })
		}),
		hasFocus: () => false,
		defaultView: undefined as any,
		addEventListener: () => {},
		removeEventListener: () => {},
		getSelection: () => null,
		insertBefore: (child: any) => child,
		elementFromPoint: () => null
	};
	const view = {
		getComputedStyle: () => ({ getPropertyValue: () => "", direction: "ltr" }),
		requestAnimationFrame: () => 0,
		cancelAnimationFrame: () => {},
		addEventListener: () => {},
		removeEventListener: () => {}
	};

	(globalThis as any).document = document;
	(globalThis as any).window = {
		...(globalThis as any).window,
		document,
		...view,
		matchMedia: () => ({ matches: false, addListener: () => {}, removeListener: () => {} })
	};
	// The view resolves its window through `document.defaultView`.
	document.defaultView = (globalThis as any).window;
	(globalThis as any).MutationObserver = class {
		observe() {}
		disconnect() {}
		takeRecords() {
			return [];
		}
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

/**
 * A project on disk, so the root markers are real files and the server's working
 * directory is a directory that exists. A stub spawned into a path that does not
 * exists dies with ENOENT, which would test the wrong failure.
 */
function makeProject(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "lsp-completions-"));
	projects.push(root);
	for (const [relative, content] of Object.entries(files)) {
		const path = join(root, relative);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, content);
	}
	return root;
}

interface StubServer {
	readonly transport: RealProcessTransport;
	readonly requests: LspCompletionRequest[];
	/** The plugin's own per-server buffers, which the Logs tab (#266) reads. */
	readonly logs: LspLogStore;
	/** What the completion source is given; it drives the real client. */
	fetch(request: LspCompletionRequest): Promise<LspCompletionOutcome>;
}

/**
 * Activates the real LSP plugin against the scripted stub and returns a fetch
 * the source can be given.
 */
async function startStubServer(script: readonly string[]): Promise<StubServer> {
	const host = new PluginHost({ platform: "desktop" });
	const transport = createRealProcessTransport(
		script.length > 0 ? { script } : {}
	);
	host.provideService(LSP_TRANSPORT_SERVICE_KEY, transport);
	host.register(lspRegistration);
	await host.activate(lspRegistration.manifest.id);
	// The plugin's own disablement, which is the path that has to leave no
	// orphan process behind.
	cleanups.push(async () => {
		if (host.isPluginActive(lspRegistration.manifest.id)) {
			await host.deactivate(lspRegistration.manifest.id);
		}
	});
	const runtime = host.getService<LspRuntime>(LSP_RUNTIME_SERVICE_KEY)!;
	const logs = host.getService<LspLogStore>(LSP_LOG_STORE_SERVICE_KEY)!;
	const requests: LspCompletionRequest[] = [];
	return {
		transport,
		logs,
		requests,
		async fetch(request) {
			requests.push(request);
			return await runtime.fetchCompletions(request);
		}
	};
}

/** A settings reader over editor-level values plus one per-language map. */
function reader(
	languageOverrides: unknown,
	editorLevel: Record<string, unknown> = {}
): SettingReader {
	const stored: Record<string, unknown> = {
		words: "fallback",
		min_word_length: 3,
		lsp: true,
		lsp_fetch_timeout_ms: 0,
		lsp_insert_mode: "replace_suffix",
		show_completion_documentation: true,
		languages: languageOverrides,
		...editorLevel
	};
	return (namespace, key) => (namespace === "editor" ? stored[key] : undefined);
}

interface ChainOptions {
	readonly language?: string;
	readonly fetch?: StubServer["fetch"];
	readonly read?: SettingReader;
	/** Overrides applied after the settings are read, for the source-level cases. */
	readonly serverSettings?: Partial<ServerCompletionSettings>;
	readonly snippets?: readonly { id: string; language: string; trigger: string; body: string; description: string; owner: string }[];
	/** Absolute path of the open file, which is what a server is scoped to. */
	readonly filePath?: string;
}

/**
 * The editor's own extension array for a code file: the language compartment
 * first, then the completion compartment after it, which is the ordering the
 * chain appends into.
 */
async function codeState(doc: string, options: ChainOptions = {}): Promise<EditorState> {
	const desc = languages.find((l) => l.name === (options.language ?? "TypeScript"));
	expect(desc).toBeDefined();
	const languageName = desc!.name;
	const read = options.read ?? reader(undefined);
	const serverSettings: ServerCompletionSettings = {
		...DEFAULT_SERVER_COMPLETION_SETTINGS,
		...readServerCompletionSettings(read, languageName),
		...options.serverSettings
	};
	const language = (await resolveActiveLanguage(desc)) as any;
	const document = {
		fileName: options.filePath ? options.filePath.split("/").pop() : "a.ts",
		content: doc,
		origin: { scheme: "file", path: options.filePath ?? "/project/a.ts", name: "a.ts" }
	};
	return EditorState.create({
		doc,
		selection: { anchor: doc.length },
		extensions: [
			workspaceFacet.of(null),
			currentDocFacet.of(document as any),
			new Compartment().of(await getLanguageExtensions(desc)),
			new Compartment().of(
				completionCompartmentExtensions({
					language,
					languageName,
					snippets: options.snippets ?? [],
					automaticCompletions: true,
					readSettings: () => readBufferWordSettings(read, languageName),
					server: options.fetch
						? {
								fetch: options.fetch,
								readSettings: () => serverSettings
							}
						: null
				})
			)
		]
	});
}

/** Runs every source CodeMirror would run, awaiting each one's result. */
async function offeredOptions(
	state: EditorState,
	pos: number,
	explicit: boolean
): Promise<Completion[]> {
	const context = new CompletionContext(state, pos, explicit);
	const options: Completion[] = [];
	for (const source of state.languageDataAt("autocomplete", pos) as any[]) {
		const result = (await source(context as any)) as CompletionResult | null;
		if (result) options.push(...result.options);
	}
	return options;
}

async function offeredLabels(
	state: EditorState,
	pos: number,
	explicit: boolean
): Promise<string[]> {
	return (await offeredOptions(state, pos, explicit)).map((option) => option.label);
}

/** Only the buffer-word offers, which are the only ones typed as `text`. */
async function offeredWordLabels(
	state: EditorState,
	pos: number,
	explicit: boolean
): Promise<string[]> {
	return (await offeredOptions(state, pos, explicit))
		.filter((option) => option.type === "text")
		.map((option) => option.label);
}

/** Applies an option through a real transaction and returns the new document. */
function appliedDoc(
	option: Completion,
	state: EditorState,
	from: number,
	to: number
): string {
	let spec: any = null;
	const view = { state, dispatch: (next: any) => (spec = next) };
	option.apply!(view as never, option, from, to);
	return state.update(spec).state.doc.toString();
}

/**
 * Mounts the state, wakes the chain explicitly, and reports the labels in the
 * order the popover would render them.
 *
 * A source is only ever called by the completion view plugin, and the state only
 * builds a dialog once it has run, so this needs a view. `currentCompletions`
 * and `completionStatus` are the public readings of that; `sortOptions` is not
 * exported, which is why the order is asserted here rather than computed.
 */
async function popoverOptions(state: EditorState): Promise<Completion[]> {
	const view = new EditorView({
		state,
		parent: (globalThis as any).document.createElement("div")
	});
	try {
		expect(startCompletion(view)).toBe(true);
		for (let waited = 0; waited < 4_000; waited += 20) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			if (completionStatus(view.state) !== "pending") break;
		}
		return [...currentCompletions(view.state)];
	} finally {
		view.destroy();
	}
}

/**
 * The document under test. Two lines, so the request has a line offset to
 * carry, and a buffer that holds `widgetId` so the words tier has something to
 * offer behind the server.
 */
const DOC = "const totalCount = computeTotals(rows);\nconst widgetId = wid";
const TYPED = DOC.lastIndexOf("wid");

function projectState(doc: string, options: ChainOptions = {}): Promise<EditorState> {
	const root = makeProject({ "tsconfig.json": "{}", "a.ts": doc });
	return codeState(doc, { ...options, filePath: join(root, "a.ts") });
}

describe("server completions in the composed chain", () => {
	it(
		"answers with server items carrying documentation, and stands words down",
		async () => {
			const server = await startStubServer([]);
			const state = await projectState(DOC, { fetch: server.fetch });

			const options = await offeredOptions(state, DOC.length, true);
			const labels = options.map((option) => option.label);
			expect(labels).toContain("Widget");
			expect(labels).toContain("WidgetFactory");
			expect(labels).toContain("widgetId");

			// The signature is `detail` and the JSDoc is `info`, which is the pair
			// `show_completion_documentation` maps to.
			const widget = options.find((option) => option.label === "Widget")!;
			expect(widget.detail).toBe("(class) Widget");
			expect(widget.info).toBe("A thing with an id and a label.");
			const factory = options.find((option) => option.label === "WidgetFactory")!;
			expect(factory.info).toBe("Builds widgets.");

			// Fallback is a fallback: a server that answered owns the popover, so the
			// buffer word that extends the same prefix is not offered alongside it.
			// The words source was asked and answered nothing, rather than never
			// having been reached.
			expect(await offeredWordLabels(state, DOC.length, true)).toEqual([]);
		},
		30_000
	);

	it(
		"ranks server items in the composed order: alongside notes, above snippets and words",
		async () => {
			const server = await startStubServer([]);
			// Words are put back to `enabled` so every tier is on the chain at once:
			// under the `fallback` default a serving server stands them down, and
			// there would be nothing left to rank below the snippets.
			const state = await projectState(DOC, {
				fetch: server.fetch,
				read: reader({ TypeScript: { words: "enabled" } }),
				snippets: [
					{
						id: "wide",
						language: "TypeScript",
						trigger: "widle",
						body: "snippet body",
						description: "a snippet",
						owner: "fixture"
					}
				]
			});

			// The tiers themselves, so the popover assertion is not the only thing
			// holding the ordering down. Server items tie the note tier: they are
			// "alongside" the notes, which are frozen at 0 and carry no boost.
			expect(COMPLETION_RANK_TIERS.server).toBe(COMPLETION_RANK_TIERS.noteSources);
			expect(COMPLETION_RANK_TIERS.server).toBeGreaterThan(COMPLETION_RANK_TIERS.snippets);
			expect(COMPLETION_RANK_TIERS.snippets).toBeGreaterThan(COMPLETION_RANK_TIERS.words);

			const options = await offeredOptions(state, DOC.length, true);
			expect(options.find((o) => o.label === "Widget")!.boost).toBe(
				COMPLETION_RANK_TIERS.server
			);

			// And the order those boosts are supposed to produce, read off the real
			// popover rather than off a hand-rolled sort. Positions, not a list: a
			// code language brings its own keyword and local-variable sources, and
			// the claim is about where the four tiers sit relative to each other.
			const ranked = await popoverOptions(state);
			const at = (label: string) => ranked.findIndex((option) => option.label === label);
			const wordAt = ranked.findIndex((option) => option.type === "text");
			const snippetAt = at("widle");

			// The language's own local-variable source is unboosted too — it is the
			// same kind of frozen, un-sectioned source the note sources are — so it
			// sits in the server tier alongside them rather than below it.
			const localAt = ranked.findIndex(
				(option) => option.label === "widgetId" && option.type === "variable"
			);
			expect(localAt).toBeGreaterThanOrEqual(0);
			for (const label of ["Widget", "WidgetFactory", "widgetId"]) {
				expect(at(label)).toBeGreaterThanOrEqual(0);
				expect(at(label)).toBeLessThan(snippetAt);
			}
			expect(snippetAt).toBeGreaterThan(localAt);
			// Our own words are last, and last because of their boost.
			expect(wordAt).toBeGreaterThan(snippetAt);
			expect(wordAt).toBe(ranked.length - 1);
		},
		30_000
	);

	it(
		"falls back to words when the server is slower than the fetch timeout",
		async () => {
			// The stub answers everything, just late. `initialize` still lands inside
			// its own handshake bound, so the server *is* running and the only thing
			// that can produce words here is the completion request timing out.
			const server = await startStubServer(["--delay-ms", "400"]);
			const read = reader(undefined, { lsp_fetch_timeout_ms: 120 });
			const state = await projectState(DOC, { fetch: server.fetch, read });

			// The first query pays for the start — a spawn plus a 400ms handshake —
			// which the fetch setting does not bound: it bounds one completion round
			// trip, not a server's whole life.
			await offeredLabels(state, DOC.length, true);
			await waitFor(() => server.requests.length === 1, { label: "the first request" });
			expect(server.transport.spawned).toHaveLength(1);

			const started = Date.now();
			const labels = await offeredLabels(state, DOC.length, true);
			const elapsed = Date.now() - started;

			await waitFor(() => server.requests.length === 2, { label: "the second request" });
			// The bound was honoured rather than merely reached: the same running
			// server would have replied with items at 400ms had the query waited.
			expect(elapsed).toBeGreaterThanOrEqual(120);
			expect(elapsed).toBeLessThan(400);
			// Words, and not the items the stub was holding.
			expect(await offeredWordLabels(state, DOC.length, true)).toEqual(["widgetId"]);
			expect(labels).toContain("widgetId");
			expect(labels).not.toContain("Widget");
		},
		30_000
	);

	it(
		"waits for a slow server when the fetch timeout is the documented default of 0",
		async () => {
			// The same stub and the same 400ms delay, with no bound: `0` means "as
			// long as it takes", not "instantly", so the items arrive rather than the
			// words replacing them.
			const server = await startStubServer(["--delay-ms", "400"]);
			const state = await projectState(DOC, { fetch: server.fetch });

			await offeredLabels(state, DOC.length, true);
			await waitFor(() => server.requests.length === 1, { label: "the first request" });
			const started = Date.now();
			const labels = await offeredLabels(state, DOC.length, true);

			expect(Date.now() - started).toBeGreaterThanOrEqual(400);
			expect(labels).toContain("Widget");
			expect(await offeredWordLabels(state, DOC.length, true)).toEqual([]);
		},
		30_000
	);

	it(
		"falls back to words when the server fails the request",
		async () => {
			const server = await startStubServer(["--mode", "fail-completion"]);
			const state = await projectState(DOC, { fetch: server.fetch });

			expect(await offeredWordLabels(state, DOC.length, true)).toEqual(["widgetId"]);
			// The handshake came back and the process is running; only the method
			// refused. The query really did go out.
			expect(server.transport.spawned).toHaveLength(1);
			expect(server.requests.length).toBeGreaterThan(0);
			// And the reason reached the server's log, because from the outside
			// words answering is indistinguishable from words working.
			await waitFor(
				() =>
					server.logs
						.read({ kind: "server" })
						.some((entry) => entry.message.includes("words answer instead")),
				{ label: "the failure to be logged" }
			);
		},
		30_000
	);

	it(
		"falls back to words when the server cannot start at all",
		async () => {
			const server = await startStubServer(["--mode", "fail"]);
			const state = await projectState(DOC, { fetch: server.fetch });

			expect(await offeredWordLabels(state, DOC.length, true)).toEqual(["widgetId"]);
		},
		30_000
	);

	it(
		"sends the cursor position, the document path and the timeout it was given",
		async () => {
			const server = await startStubServer([]);
			const read = reader(undefined, { lsp_fetch_timeout_ms: 750 });
			const root = makeProject({ "tsconfig.json": "{}", "a.ts": DOC });
			const state = await codeState(DOC, {
				fetch: server.fetch,
				read,
				filePath: join(root, "a.ts")
			});
			await offeredLabels(state, DOC.length, true);

			await waitFor(() => server.requests.length > 0, { label: "a completion request" });
			const request = server.requests[0];
			expect(request.path).toBe(join(root, "a.ts"));
			expect(request.fileName).toBe("a.ts");
			expect(request.content).toBe(DOC);
			expect(request.language).toBe("TypeScript");
			// Line 2 in CodeMirror's terms, the second line on the wire.
			expect(request.line).toBe(1);
			expect(request.character).toBe(DOC.length - (DOC.lastIndexOf("\n") + 1));
			expect(request.timeoutMs).toBe(750);
			// And the server ran against the marker in that project, not the
			// document's directory: the root the descriptor's marker order chose.
			expect(server.transport.spawned[0].cwd).toBe(root);
		},
		30_000
	);

	it(
		"passes no bound at all when the timeout is the documented default of 0",
		async () => {
			const server = await startStubServer([]);
			const state = await projectState(DOC, { fetch: server.fetch });
			await offeredLabels(state, DOC.length, true);

			await waitFor(() => server.requests.length > 0, { label: "a completion request" });
			// `undefined` is the client's own "no bound"; a zero timer would make
			// the default an instant failure, which is the opposite of what it says.
			expect(server.requests[0].timeoutMs).toBeUndefined();
		},
		30_000
	);
});

describe("server completion settings", () => {
	it("applies lsp, the timeout, the insert mode and documentation display per language", () => {
		const read = reader({
			TypeScript: {
				lsp: false,
				lsp_fetch_timeout_ms: 250,
				lsp_insert_mode: "replace_range",
				show_completion_documentation: false
			}
		});

		expect(readServerCompletionSettings(read, "TypeScript")).toEqual({
			lsp: false,
			fetchTimeoutMs: 250,
			insertMode: "replace_range",
			showDocumentation: false
		});
		// Case-insensitively, like every other language join in the host.
		expect(readServerCompletionSettings(read, "typescript").lsp).toBe(false);
		// An unnamed language keeps every editor-level default.
		expect(readServerCompletionSettings(read, "Rust")).toEqual(
			DEFAULT_SERVER_COMPLETION_SETTINGS
		);
		expect(readServerCompletionSettings(read, "Markdown")).toEqual(
			DEFAULT_SERVER_COMPLETION_SETTINGS
		);
		expect(DEFAULT_SERVER_COMPLETION_SETTINGS).toEqual({
			lsp: true,
			fetchTimeoutMs: 0,
			insertMode: "replace_suffix",
			showDocumentation: true
		});
	});

	it("reads the editor-level value when a language entry says nothing about one key", () => {
		// The key list is why this matters: a `{ "TypeScript": { "lsp": false } }`
		// entry must not silently lift the other three back to their own defaults.
		const read = reader({ TypeScript: { lsp: false } }, {
			lsp_fetch_timeout_ms: 900,
			lsp_insert_mode: "replace_range",
			show_completion_documentation: false
		});

		expect(readServerCompletionSettings(read, "TypeScript")).toEqual({
			lsp: false,
			fetchTimeoutMs: 900,
			insertMode: "replace_range",
			showDocumentation: false
		});
	});

	it("treats a stored 0 as no bound, and a nonsense value as the same", () => {
		const at = (stored: unknown) =>
			readServerCompletionSettings(
				reader(undefined, { lsp_fetch_timeout_ms: stored }),
				"TypeScript"
			).fetchTimeoutMs;

		expect(at(0)).toBe(0);
		// A hand-edited value the schema would have refused costs the bound and
		// nothing else.
		expect(at("soon")).toBe(0);
		expect(at(-5)).toBe(0);
		expect(at(Number.NaN)).toBe(0);
	});

	it(
		"lets lsp: false put words back for that language only",
		async () => {
			const server = await startStubServer([]);
			const off = await projectState(DOC, {
				fetch: server.fetch,
				read: reader({ TypeScript: { lsp: false } })
			});
			const on = await projectState(DOC, { fetch: server.fetch });

			// Off: the source declines before asking anything, so the words are the
			// whole popover rather than a fallback to a failure — and the request
			// count is what proves nothing was asked.
			expect(server.requests).toHaveLength(0);
			expect(await offeredWordLabels(off, DOC.length, true)).toEqual(["widgetId"]);

			await offeredLabels(on, DOC.length, true);
			await waitFor(() => server.requests.length > 0, { label: "the enabled request" });
			expect(await offeredWordLabels(on, DOC.length, true)).toEqual([]);
		},
		30_000
	);

	it(
		"drops documentation but keeps the signature when display is off",
		async () => {
			const server = await startStubServer([]);
			const state = await projectState(DOC, {
				fetch: server.fetch,
				read: reader({ TypeScript: { show_completion_documentation: false } })
			});

			const options = await offeredOptions(state, DOC.length, true);
			const widget = options.find((option) => option.label === "Widget")!;
			expect(widget.info).toBeUndefined();
			expect(widget.detail).toBe("(class) Widget");
		},
		30_000
	);
});

describe("the server insert mode", () => {
	it(
		"replaces only the typed suffix under replace_suffix",
		async () => {
			const server = await startStubServer([]);
			const state = await projectState(DOC, { fetch: server.fetch });
			const options = await offeredOptions(state, DOC.length, true);
			const widget = options.find((option) => option.label === "Widget")!;

			expect(appliedDoc(widget, state, TYPED, DOC.length)).toBe(
				`${DOC.slice(0, TYPED)}Widget`
			);
		},
		30_000
	);

	it(
		"replaces the range the server named under replace_range",
		async () => {
			const server = await startStubServer([]);
			const state = await projectState(DOC, {
				fetch: server.fetch,
				read: reader({ TypeScript: { lsp_insert_mode: "replace_range" } })
			});
			const options = await offeredOptions(state, DOC.length, true);
			const widget = options.find((option) => option.label === "Widget")!;

			// The stub named a range reaching five characters back, so `= wid` goes
			// too — which is the whole difference between the two modes and the reason
			// `replace_suffix` cannot stand in for it.
			const applied = appliedDoc(widget, state, TYPED, DOC.length);
			expect(applied).toBe(
				"const totalCount = computeTotals(rows);\nconst widgetId Widget"
			);
			// And visibly not what `replace_suffix` did two tests ago.
			expect(applied).not.toBe(`${DOC.slice(0, TYPED)}Widget`);
		},
		30_000
	);

	it("degrades to the suffix when the server named no range", () => {
		// Nothing to replace: an item with no `replaceRange` leaves the mode nothing
		// to work with, and the documented default is the conservative one.
		expect(DEFAULT_SERVER_COMPLETION_SETTINGS.insertMode).toBe("replace_suffix");
		expect(readServerCompletionSettings(reader({ TypeScript: { lsp_insert_mode: "nonsense" } }), "TypeScript").insertMode).toBe(
			"replace_suffix"
		);
	});
});

describe("the words fallback decision", () => {
	const serving: LspCompletionOutcome = {
		state: "serving",
		list: { items: [], incomplete: false }
	};

	it("stands words down only while a server is answering", () => {
		const settings = readBufferWordSettings(reader(undefined), "TypeScript");
		expect(settings.words).toBe("fallback");

		expect(resolveBufferWordPolicy("TypeScript", settings, serving)).toEqual({
			automatic: false,
			minWordLength: 3,
			offered: false
		});
		// A failing server and no server are both reasons words answer; they differ
		// only in whether anyone was supposed to.
		expect(
			resolveBufferWordPolicy("TypeScript", settings, {
				state: "unavailable",
				server: "typescript@/project",
				reason: "timed out"
			}).offered
		).toBe(true);
		expect(
			resolveBufferWordPolicy("TypeScript", settings, { state: "inactive", reason: "none" }).offered
		).toBe(true);
		expect(resolveBufferWordPolicy("TypeScript", settings, null).offered).toBe(true);
	});

	it("leaves enabled and disabled meaning what they meant before a server existed", () => {
		const enabled = readBufferWordSettings(reader(undefined, { words: "enabled" }), "TypeScript");
		const disabled = readBufferWordSettings(reader(undefined, { words: "disabled" }), "TypeScript");

		// `enabled` is not the fallback: a serving server does not silence it.
		expect(resolveBufferWordPolicy("TypeScript", enabled, serving).offered).toBe(true);
		expect(resolveBufferWordPolicy("TypeScript", enabled, serving).automatic).toBe(true);
		// `disabled` stays quiet on a keystroke and still answers explicitly, which is
		// what it always meant.
		expect(resolveBufferWordPolicy("TypeScript", disabled, null).automatic).toBe(false);
		expect(resolveBufferWordPolicy("TypeScript", disabled, null).offered).toBe(true);
	});

	it(
		"answers a note's words even with a failing server, because no server claims Markdown",
		async () => {
			// The other half of the fallback rule: prose is unaffected by any of this,
			// because the bundled descriptor serves no Markdown and the words source
			// sees 'inactive' rather than a failure.
			const server = await startStubServer(["--mode", "fail"]);
			const markdown = await codeState("Notes about widgets\n\nwid", {
				language: "Markdown",
				fetch: server.fetch,
				filePath: "/project/note.md"
			});

			expect(await offeredWordLabels(markdown, markdown.doc.length, true)).toEqual(["widgets"]);
			// The query went out and came back unanswered, and the reason it came
			// back that way is that nothing claimed the file: no process, no log.
			expect(server.requests.length).toBeGreaterThan(0);
			expect(server.transport.spawned).toEqual([]);
		},
		30_000
	);
});