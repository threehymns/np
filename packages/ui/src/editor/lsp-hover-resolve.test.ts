import "../../../../tests/contract/rune-setup";
import { beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { CompletionContext, type Completion } from "@codemirror/autocomplete";
import {
	LSP_LOG_STORE_SERVICE_KEY,
	LSP_RUNTIME_SERVICE_KEY,
	LSP_PLATFORM_SERVICE_KEY,
	lspRegistration,
	PluginHost,
	type LspLogStore,
	type LspRuntime,
} from "@np/core";
import {
	createRealProcessPlatform,
	waitFor,
} from "../../../../tests/fixtures/lsp-platform";
import { currentDocFacet, workspaceFacet } from "./extensions/wikilinks";
import { completionCompartmentExtensions } from "./extensions/completion-sources";
import { readBufferWordSettings, readServerCompletionSettings } from "./extensions/completion-settings";
import {
	DEFAULT_SERVER_COMPLETION_SETTINGS,
	type ServerCompletionSettings,
} from "./extensions/server-completions";
import { createHoverSource } from "./extensions/server-hover";

/**
 * Hover tooltips and lazy resolve in the editor (spec #280).
 *
 * Hover is its own `textDocument/hover` request sharing one Markdown pipeline
 * with resolve; resolve fills what the first completion reply withheld via the
 * popover's `info` hook. Both degrade to nothing — never to an error — so
 * diagnostics, completions and note hovers keep their current behaviour.
 */

let getLanguageExtensions: (desc: LanguageDescription | null) => Promise<Extension[]>;
let resolveActiveLanguage: (desc: LanguageDescription | null) => Promise<any>;

const cleanups: Array<() => Promise<void> | void> = [];
const projects: string[] = [];

async function cleanup() {
	while (cleanups.length > 0) await cleanups.pop()!();
	while (projects.length > 0) rmSync(projects.pop()!, { recursive: true, force: true });
}

beforeAll(async () => {
	mock.module("svelte/reactivity", () => ({ SvelteMap: Map, SvelteSet: Set }));
	// Same minimal DOM stub `lsp-completions.test.ts` installs; duplicated rather
	// than shared because it is a test-local crutch, not production surface.
	// Only when nothing has installed one: clobbering `window` out from under a
	// suite that already installed a DOM leaves the next mounted view with no
	// `document` at all.
	if (typeof (globalThis as Record<string, unknown>).document === "undefined") {
		installMinimalDom();
	}
	const mod = await import("./index");
	getLanguageExtensions = mod.getLanguageExtensions;
	resolveActiveLanguage = mod.resolveActiveLanguage;
});

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
		className = "";
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

function makeProject(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "lsp-hover-ui-"));
	projects.push(root);
	for (const [relative, content] of Object.entries(files)) {
		const path = join(root, relative);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, content);
	}
	return root;
}

async function startStubServer(script: readonly string[]) {
	const host = new PluginHost({ platform: "desktop" });
	const platform = createRealProcessPlatform(script.length > 0 ? { script } : {});
	host.provideService(LSP_PLATFORM_SERVICE_KEY, platform);
	host.register(lspRegistration);
	await host.activate(lspRegistration.manifest.id);
	cleanups.push(async () => {
		if (host.isPluginActive(lspRegistration.manifest.id)) {
			await host.deactivate(lspRegistration.manifest.id);
		}
	});
	const runtime = host.getService<LspRuntime>(LSP_RUNTIME_SERVICE_KEY)!;
	return { host, platform, runtime };
}

function reader(languageOverrides: unknown, editorLevel: Record<string, unknown> = {}) {
	const stored: Record<string, unknown> = {
		words: "fallback",
		min_word_length: 3,
		lsp: true,
		lsp_fetch_timeout_ms: 0,
		lsp_insert_mode: "replace_suffix",
		show_completion_documentation: true,
		languages: languageOverrides,
		...editorLevel,
	};
	return (namespace: string, key: string) => (namespace === "editor" ? stored[key] : undefined);
}

async function codeState(
	doc: string,
	options: {
		language?: string;
		fetch?: any;
		resolve?: any;
		runCommand?: any;
		fetchHover?: any;
		read?: any;
		filePath?: string;
	} = {}
): Promise<EditorState> {
	const desc = languages.find((l) => l.name === (options.language ?? "TypeScript"));
	const languageName = desc!.name;
	const read = options.read ?? reader(undefined);
	const serverSettings: ServerCompletionSettings = {
		...DEFAULT_SERVER_COMPLETION_SETTINGS,
		...readServerCompletionSettings(read, languageName),
	};
	const language = (await resolveActiveLanguage(desc)) as any;
	const document = {
		fileName: options.filePath ? options.filePath.split("/").pop() : "a.ts",
		content: doc,
		origin: { scheme: "file", path: options.filePath ?? "/project/a.ts", name: "a.ts" },
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
					snippets: [],
					automaticCompletions: true,
					readSettings: () => readBufferWordSettings(read, languageName),
					server: options.fetch
						? {
								fetch: options.fetch,
								resolve: options.resolve,
								runCommand: options.runCommand,
								readSettings: () => serverSettings,
							}
						: null,
					hover: options.fetchHover
						? { fetchHover: options.fetchHover, readSettings: () => ({ lsp: serverSettings.lsp }) }
						: null,
				})
			),
		],
	});
}

async function offeredOptions(state: EditorState, pos: number): Promise<Completion[]> {
	const context = new CompletionContext(state, pos, true);
	const options: Completion[] = [];
	for (const source of state.languageDataAt("autocomplete", pos) as any[]) {
		const result = (await source(context as any)) as any;
		if (result) options.push(...result.options);
	}
	return options;
}

const DOC = "const w = wid";
function projectState(doc: string, options: any = {}) {
	const root = makeProject({ "tsconfig.json": "{}", "a.ts": doc });
	return codeState(doc, { ...options, filePath: join(root, "a.ts") });
}

describe("hover tooltips", () => {
	it("renders type, signature and documentation for a reported symbol", async () => {
		const server = await startStubServer([]);
		try {
			const fetchHover = (query: any) =>
				server.runtime.fetchHover({
					document: {
						path: query.document.path,
						fileName: query.document.fileName,
						content: query.document.content,
						language: query.document.language,
					},
					line: query.line,
					character: query.character,
				});
			const source = createHoverSource({ fetchHover, languageName: "TypeScript" });
			const root = makeProject({ "tsconfig.json": "{}", "a.ts": "const x = Widget;\n" });
			const state = await codeState("const x = Widget;\n", {
				filePath: join(root, "a.ts"),
			});
			const tooltip = await source({ state } as any, 10);
			expect(tooltip).not.toBeNull();
			const dom = (tooltip!.create as any)().dom as any;
			expect(dom.textContent).toContain("(class) Widget");
			expect(dom.textContent).toContain("A thing with an id");
		} finally {
			await cleanup();
		}
	}, 30_000);

	it("hovers to nothing when the server reports nothing, leaving other hovers alone", async () => {
		const server = await startStubServer(["--mode", "no-hover"]);
		try {
			const fetchHover = (query: any) => server.runtime.fetchHover(query as any);
			const source = createHoverSource({ fetchHover: fetchHover as any, languageName: "TypeScript" });
			const root = makeProject({ "tsconfig.json": "{}", "a.ts": "const x = 1;\n" });
			const state = await codeState("const x = 1;\n", { filePath: join(root, "a.ts") });
			expect(await source({ state } as any, 5)).toBeNull();
		} finally {
			await cleanup();
		}
	}, 30_000);

	it("hovers to nothing when lsp is off for the language", async () => {
		const source = createHoverSource({
			fetchHover: async () => {
				throw new Error("must not be called");
			},
			languageName: "TypeScript",
			readSettings: () => ({ lsp: false }),
		});
		const root = makeProject({ "tsconfig.json": "{}", "a.ts": "const x = 1;\n" });
		try {
			const state = await codeState("const x = 1;\n", { filePath: join(root, "a.ts") });
			expect(await source({ state } as any, 5)).toBeNull();
		} finally {
			await cleanup();
		}
	});
});

describe("completion resolve in the popover", () => {
	it("fills withheld docs through info, without changing ranking", async () => {
		const server = await startStubServer(["--mode", "lazy-docs"]);
		try {
			const fetch = (query: any) => server.runtime.fetch(query);
			const resolve = (item: any, document: any) => server.runtime.resolveCompletion(document, item);
			const state = await projectState(DOC, { fetch, resolve });
			const options = await offeredOptions(state, DOC.length);
			const widget = options.find((o) => o.label === "Widget")!;
			expect(widget.detail).toBeUndefined();
			// Withheld: info hangs the round trip rather than a string.
			expect(typeof widget.info).toBe("function");
			const dom = await (widget.info as any)(widget);
			expect((dom as any)?.textContent ?? dom).toContain("A thing with an id");
			// Ranking untouched: server items still tie the note tier.
			expect(widget.boost).toBe(0);
		} finally {
			await cleanup();
		}
	}, 30_000);

	it("keeps immediate docs as a string with no round trip", async () => {
		const server = await startStubServer([]);
		try {
			let resolves = 0;
			const fetch = (query: any) => server.runtime.fetch(query);
			const resolve = async (item: any, document: any) => {
				resolves++;
				return server.runtime.resolveCompletion(document, item);
			};
			const state = await projectState(DOC, { fetch, resolve });
			const options = await offeredOptions(state, DOC.length);
			const widget = options.find((o) => o.label === "Widget")!;
			expect(typeof widget.info).toBe("string");
			expect(widget.info).toContain("A thing with an id");
			expect(resolves).toBe(0);
		} finally {
			await cleanup();
		}
	}, 30_000);
});
