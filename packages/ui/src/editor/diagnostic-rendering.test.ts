import "../../../../tests/contract/rune-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
	composeEditorContributions,
	PluginHost,
	lspRegistration,
	reconfigureEditorContributions,
	WORKSPACE_SERVICE_KEY,
	type WorkspaceLike,
} from "@np/core";
import {
	createRealProcessTransport,
	waitFor,
} from "../../../../tests/fixtures/lsp-transport";

/**
 * Server diagnostics as drawn on screen (spec #263, ticket #266, ADR 0016).
 *
 * A decoration set is the plugin's contract with the editor; this file checks the
 * last step the plugin does not control itself — that the marks reach the DOM as
 * the squiggle spans the theme styles. It runs a real stub server over real
 * pipes, so the marks come from an actual `publishDiagnostics` notification, and
 * reads the rendered elements rather than any internal.
 *
 * Nothing here needs the plugin's own modules: the extension comes out of the
 * host's decoration compartment, which is the seam a plugin contributes through.
 */

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()!();
	view?.destroy();
	view = undefined;
});

let view: EditorView | undefined;
let installedDom = false;

/**
 * The smallest `document`/`window` an `EditorView` will mount against, plus the
 * attribute recording this file needs and the other two DOM stubs in this
 * package do not keep: `Decoration.mark` writes its class with `setAttribute`,
 * so a stub that drops attributes renders marks with no way to see them.
 */
function installDom(): void {
	class MockElement {
		tagName: string;
		style: Record<string, unknown> = {};
		childNodes: unknown[] = [];
		/** Live attribute list, as CodeMirror's `setAttrs` walks it. */
		attributes: Array<{ name: string }> = [];
		attrs: Record<string, string> = {};
		dataset: Record<string, string> = {};
		classList = { add: () => {}, remove: () => {}, contains: () => false };
		ownerDocument: unknown;
		parentNode: unknown = null;
		offsetWidth = 100;
		offsetHeight = 20;
		clientWidth = 100;
		clientHeight = 20;
		textContent = "";
		constructor(tag = "DIV") {
			this.tagName = tag.toUpperCase();
			this.ownerDocument = (globalThis as any).document;
		}
		setAttribute(name: string, value: string) {
			if (this.attrs[name] === undefined) this.attributes.push({ name });
			this.attrs[name] = String(value);
		}
		getAttribute(name: string) {
			return this.attrs[name] ?? null;
		}
		removeAttribute(name: string) {
			delete this.attrs[name];
			this.attributes = this.attributes.filter((attribute) => attribute.name !== name);
		}
		appendChild(child: unknown) {
			(this.childNodes as any[]).push(child);
			(child as any).parentNode = this;
			return child;
		}
		insertBefore(child: unknown) {
			return this.appendChild(child);
		}
		removeChild(child: unknown) {
			this.childNodes = this.childNodes.filter((c) => c !== child);
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
			ownerDocument: (globalThis as any).document,
		}),
		createRange: () => ({
			setStart() {},
			setEnd() {},
			getBoundingClientRect: () => ({ top: 0, left: 0 }),
		}),
		hasFocus: () => false,
		defaultView: undefined as unknown,
		addEventListener: () => {},
		removeEventListener: () => {},
		getSelection: () => null,
		insertBefore: (child: unknown) => child,
		elementFromPoint: () => null,
	};
	const viewHelpers = {
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
		...viewHelpers,
		matchMedia: () => ({ matches: false, addListener: () => {}, removeListener: () => {} }),
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
	(globalThis as any).getComputedStyle = viewHelpers.getComputedStyle;
	installedDom = true;
}

function uninstallDom(): void {
	if (!installedDom) return;
	delete (globalThis as any).document;
	installedDom = false;
}

/** Every rendered element the plugin's diagnostics produced, with its tooltip. */
function diagnosticSpans(): Array<{ className: string; title: string }> {
	const found: Array<{ className: string; title: string }> = [];
	const walk = (node: any) => {
		const className = node?.attrs?.class;
		if (typeof className === "string" && className.includes("cm-lsp-diagnostic")) {
			found.push({ className, title: node.attrs.title ?? "" });
		}
		for (const child of node?.childNodes ?? []) walk(child);
	};
	if (view) walk(view.dom);
	return found;
}

/** A workspace whose active document the test can move between files. */
function movableWorkspace(): {
	readonly service: WorkspaceLike;
	show(path: string | null): void;
} {
	let shown: string | null = null;
	const service = {
		project: { rootOrigin: null },
		get activeDocument() {
			return shown === null ? null : { id: "doc", origin: { path: shown } };
		},
		tabs: [],
		activeTabId: "doc",
		closeTab: () => {},
		saveFolderState: async () => {},
	} as unknown as WorkspaceLike;
	return { service, show: (path: string | null) => (shown = path) };
}

function makeProject(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "lsp-render-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	for (const [relative, content] of Object.entries(files)) {
		const file = join(root, relative);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, content);
	}
	return root;
}

describe("Server diagnostics on screen (#266)", () => {
	it("draws a squiggle for what a real server published, and nothing elsewhere", async () => {
		installDom();
		cleanups.push(uninstallDom);
		const root = makeProject({ "tsconfig.json": "{}", "src/a.ts": "const a = 1;\nconst b = 2;\n" });
		const path = join(root, "src/a.ts");

		const host = new PluginHost({ platform: "desktop" });
		host.provideService(
			"lsp:transport",
			createRealProcessTransport({ script: ["--diagnostics"] }),
		);
		const workspace = movableWorkspace();
		workspace.show(path);
		host.provideService(WORKSPACE_SERVICE_KEY, workspace.service);
		host.register(lspRegistration);
		await host.activate("lsp");
		cleanups.push(async () => {
			if (host.isPluginActive("lsp")) await host.deactivate("lsp");
		});

		// The editor the shell builds: the host's compartments holding whatever the
		// plugin contributed, and nothing else.
		const compose = () =>
			composeEditorContributions(
				host.getEditorContributions(),
				host.editorCompartments,
				"TypeScript",
			);
		const parent = (globalThis as any).document.createElement("div");
		view = new EditorView({
			state: EditorState.create({
				doc: "const a = 1;\nconst b = 2;\n",
				extensions: compose(),
			}),
			parent,
		});
		expect(diagnosticSpans()).toEqual([]);

		host.emit("document:opened", {
			document: {
				origin: { scheme: "file", path, name: "a.ts" },
				fileName: "a.ts",
				content: "const a = 1;\nconst b = 2;\n",
				language: { name: "TypeScript" },
			},
		});
		await waitFor(
			() =>
				host
					.getService<{ read(): Array<{ message: string }> }>("lsp:log-store")
					?.read()
					.some((entry) => entry.message.includes("publishDiagnostics")) ?? false,
			{ label: "the server to publish diagnostics" },
		);

		// A publish is not a transaction. The editor re-applies its decoration
		// compartment when the contribution registry is rebuilt, which is the
		// request the plugin makes for exactly this.
		view.dispatch({
			effects: reconfigureEditorContributions(
				host.getEditorContributions(),
				host.editorCompartments,
				"TypeScript",
			),
		});

		expect(diagnosticSpans()).toEqual([
			{
				className: "cm-lsp-diagnostic cm-lsp-diagnostic-error",
				title: "stub: (2304) stub server: cannot find name",
			},
			{
				className: "cm-lsp-diagnostic cm-lsp-diagnostic-warning",
				title: "stub: stub server: unused variable",
			},
		]);

		// A different document in the same editor: the marks belong to the document
		// the server reported on, so an editor showing another file paints nothing.
		// The view is rebuilt rather than reconfigured, which is what the shell does
		// when the active tab changes.
		workspace.show(join(root, "src/b.ts"));
		view?.destroy();
		view = new EditorView({
			state: EditorState.create({
				doc: "const a = 1;\nconst b = 2;\n",
				extensions: compose(),
			}),
			parent,
		});

		expect(diagnosticSpans()).toEqual([]);
	});
});