import "../../../../tests/contract/rune-setup";
import { describe, it, expect } from "bun:test";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { codeFolding, foldedRanges } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import {
	fold,
	unfold,
	toggleFold,
	foldAll,
	unfoldAll,
	foldSelectedRanges,
	foldAtLevel,
	foldRecursive,
	unfoldRecursive,
	foldFunctionBodies,
	getLineIndent,
} from "./folding";
import {
	SettingsManager,
	editorDocumentFoldingRangesEnabled,
	editorGutterFoldsEnabled,
	editorSettingsForLanguage,
	DOCUMENT_FOLDING_RANGES_SETTING,
} from "../plugins";


import { beforeAll } from "bun:test";

beforeAll(() => {
	if (typeof globalThis.document === "undefined") {
		class MockElement {
			tagName: string;
			style: Record<string, any> = {};
			childNodes: any[] = [];
			attributes: any[] = [];
			classList = { add: () => {}, remove: () => {}, contains: () => false };
			ownerDocument: any;
			parentNode: any = null;
			constructor(tag = "DIV") {
				this.tagName = tag.toUpperCase();
				this.ownerDocument = globalThis.document;
			}
			setAttribute() {}
			getAttribute() { return null; }
			appendChild(child: any) { child.parentNode = this; this.childNodes.push(child); return child; }
			insertBefore(child: any) { child.parentNode = this; this.childNodes.push(child); return child; }
			removeChild() {}
			remove() {
				if (this.parentNode) {
					this.parentNode = null;
				}
			}
			addEventListener() {}
			removeEventListener() {}
			contains() { return false; }
			querySelectorAll() { return []; }
			getBoundingClientRect() { return { top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 20 }; }
		}

		(globalThis as any).MutationObserver = class {
			observe() {}
			disconnect() {}
			takeRecords() { return []; }
		};
		(globalThis as any).Window = class Window {};
		const head = new MockElement("HEAD");
		(globalThis as any).requestAnimationFrame = () => 0;
		(globalThis as any).cancelAnimationFrame = () => {};
		(globalThis as any).document = {
			head,
			body: new MockElement("BODY"),
			createElement: (tag: string) => new MockElement(tag),
			createDocumentFragment: () => new MockElement("FRAGMENT"),
			createTextNode: (text: string) => ({ nodeValue: text, ownerDocument: globalThis.document }),
			hasFocus: () => false,
			defaultView: globalThis,
			addEventListener: () => {},
			removeEventListener: () => {},
			getSelection: () => null,
			insertBefore: (child: any) => child,
		};
		(globalThis as any).window = {
			...(globalThis as any).window,
			matchMedia: () => ({ matches: false, addListener: () => {}, removeListener: () => {} }),
		};
	}
});

let jsSupport: any;

async function getJsSupport() {
	if (!jsSupport) {
		const desc = languages.find((l) => l.name === "JavaScript")!;
		jsSupport = await desc.load();
	}
	return jsSupport;
}

describe("Code folding operations", () => {
	it("computes line indentation depth correctly", () => {
		expect(getLineIndent("function foo() {", 2)).toBe(0);
		expect(getLineIndent("  const a = 1;", 2)).toBe(1);
		expect(getLineIndent("    const b = 2;", 2)).toBe(2);
		expect(getLineIndent("\t\tconst c = 3;", 2)).toBe(2);
	});

	it("folds, unfolds, and toggles code blocks", async () => {
		const lang = await getJsSupport();
		const doc = "function foo() {\n  const a = 1;\n  const b = 2;\n}\n";
		const state = EditorState.create({
			doc,
			selection: { anchor: 10 },
			extensions: [lang, codeFolding()],
		});
		const view = new EditorView({
			state,
			parent: (globalThis as any).document.createElement("div"),
		});

		expect(foldedRanges(view.state).size).toBe(0);

		// Fold
		fold(view);
		expect(foldedRanges(view.state).size).toBe(1);

		// Unfold
		unfold(view);
		expect(foldedRanges(view.state).size).toBe(0);

		// Toggle fold
		toggleFold(view);
		expect(foldedRanges(view.state).size).toBe(1);

		toggleFold(view);
		expect(foldedRanges(view.state).size).toBe(0);

		view.destroy();
	});

	it("folds all and unfolds all regions in document", async () => {
		const lang = await getJsSupport();
		const doc = `function foo() {
  const a = 1;
  const b = 2;
}

function bar() {
  const c = 3;
  const d = 4;
}
`;
		const state = EditorState.create({
			doc,
			extensions: [lang, codeFolding()],
		});
		const view = new EditorView({
			state,
			parent: (globalThis as any).document.createElement("div"),
		});

		expect(foldedRanges(view.state).size).toBe(0);

		foldAll(view);
		expect(foldedRanges(view.state).size).toBe(2);

		unfoldAll(view);
		expect(foldedRanges(view.state).size).toBe(0);

		view.destroy();
	});

	it("folds selected ranges", () => {
		const doc = `line 1
line 2
line 3
line 4
line 5
`;
		const state = EditorState.create({
			doc,
			selection: { anchor: 7, head: 20 },
			extensions: [codeFolding()],
		});
		const view = new EditorView({
			state,
			parent: (globalThis as any).document.createElement("div"),
		});

		expect(foldedRanges(view.state).size).toBe(0);

		foldSelectedRanges(view);
		expect(foldedRanges(view.state).size).toBe(1);

		view.destroy();
	});

	it("folds at specified indentation level", async () => {
		const lang = await getJsSupport();
		const doc = `function outer() {
  const x = 1;
  function inner() {
    const y = 2;
  }
}
`;
		const state = EditorState.create({
			doc,
			extensions: [lang, codeFolding()],
		});
		const view = new EditorView({
			state,
			parent: (globalThis as any).document.createElement("div"),
		});

		// Fold at level 1 (top-level blocks at indent 0)
		foldAtLevel(view, 1, 2);
		expect(foldedRanges(view.state).size).toBe(1);

		unfoldAll(view);
		expect(foldedRanges(view.state).size).toBe(0);

		// Fold at level 2 (nested blocks at indent 1)
		foldAtLevel(view, 2, 2);
		expect(foldedRanges(view.state).size).toBe(1);

		view.destroy();
	});

	it("derives the indentation step from the document when tabSize is omitted", async () => {
		const lang = await getJsSupport();
		const doc = `function outer() {
    const x = 1;
    function inner() {
        const y = 2;
    }
}
`;
		const state = EditorState.create({
			doc,
			extensions: [lang, codeFolding()],
		});
		const view = new EditorView({
			state,
			parent: (globalThis as any).document.createElement("div"),
		});

		// The file indents in four spaces, so level 2 targets four spaces.
		// A fixed default of two would read that line as depth 2 and fold
		// nothing.
		foldAtLevel(view, 2);
		expect(foldedRanges(view.state).size).toBe(1);

		view.destroy();
	});

	it("folds and unfolds recursively", async () => {
		const lang = await getJsSupport();
		const doc = `function outer() {
  function inner() {
    return 1;
  }
}
`;
		const state = EditorState.create({
			doc,
			selection: { anchor: 5 },
			extensions: [lang, codeFolding()],
		});
		const view = new EditorView({
			state,
			parent: (globalThis as any).document.createElement("div"),
		});

		foldRecursive(view);
		expect(foldedRanges(view.state).size).toBeGreaterThanOrEqual(1);

		unfoldRecursive(view);
		expect(foldedRanges(view.state).size).toBe(0);

		view.destroy();
	});

	it("folds function bodies across AST", async () => {
		const lang = await getJsSupport();
		const doc = `function fn1() {
  const a = 1;
  const b = 2;
}

const fn2 = () => {
  const c = 3;
  const d = 4;
};
`;
		const state = EditorState.create({
			doc,
			extensions: [lang, codeFolding()],
		});
		const view = new EditorView({
			state,
			parent: (globalThis as any).document.createElement("div"),
		});

		foldFunctionBodies(view);
		expect(foldedRanges(view.state).size).toBeGreaterThanOrEqual(1);

		unfoldAll(view);
		expect(foldedRanges(view.state).size).toBe(0);

		view.destroy();
	});
});

describe("Folding settings & language scoping", () => {
	it("resolves gutter.folds default and user overrides", () => {
		const manager = new SettingsManager();
		manager.loadFromText(JSON.stringify({
			gutter: { folds: false },
		}));

		const resolved = manager.resolver.resolve("editor", "gutter");
		expect(resolved.value).toEqual({ folds: false });
		expect(editorGutterFoldsEnabled(resolved.value)).toBe(false);
	});

	it("resolves document_folding_ranges and per-language overrides", () => {
		const manager = new SettingsManager();
		manager.loadFromText(JSON.stringify({
			document_folding_ranges: "off",
			editor: {
				languages: {
					Rust: {
						document_folding_ranges: "on",
					},
					JavaScript: {
						document_folding_ranges: "off",
					},
				},
			},
		}));

		const reader = (ns: string, key: string) => manager.get(ns, key);

		const rustScoped = editorSettingsForLanguage(reader, "Rust", [DOCUMENT_FOLDING_RANGES_SETTING]);
		expect(editorDocumentFoldingRangesEnabled(rustScoped.value[DOCUMENT_FOLDING_RANGES_SETTING])).toBe(true);

		const jsScoped = editorSettingsForLanguage(reader, "JavaScript", [DOCUMENT_FOLDING_RANGES_SETTING]);
		expect(editorDocumentFoldingRangesEnabled(jsScoped.value[DOCUMENT_FOLDING_RANGES_SETTING])).toBe(false);

		const tsScoped = editorSettingsForLanguage(reader, "TypeScript", [DOCUMENT_FOLDING_RANGES_SETTING]);
		expect(editorDocumentFoldingRangesEnabled(tsScoped.value[DOCUMENT_FOLDING_RANGES_SETTING])).toBe(false);
	});
});
