import "../../../../tests/contract/rune-setup";
import { describe, it, expect, beforeAll } from "bun:test";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { codeFolding, foldEffect, foldedRanges, foldCode, unfoldCode } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import {
	createFoldMarkerDOM,
	themedFoldGutter,
	foldingStateExtension,
	setLspFoldingEffect,
	lspFoldingField,
	lspFoldService,
	lspFoldingExtension,
	OPEN_CARET_SVG,
	CLOSED_CARET_SVG,
} from "./extensions/fold";
import type { LspFoldingRange } from "@np/core";

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
			innerHTML = "";
			className = "";
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

describe("Themed fold gutter & marker DOM", () => {
	it("renders custom SVG carets for open and closed fold markers", () => {
		const openMarker = createFoldMarkerDOM(true);
		expect(openMarker.className).toContain("cm-foldMarker-open");
		expect(openMarker.innerHTML).toBe(OPEN_CARET_SVG);

		const closedMarker = createFoldMarkerDOM(false);
		expect(closedMarker.className).toContain("cm-foldMarker-closed");
		expect(closedMarker.innerHTML).toBe(CLOSED_CARET_SVG);
	});

	it("mounts themedFoldGutter without throwing errors", () => {
		const state = EditorState.create({
			doc: "line 1\nline 2\nline 3\n",
			extensions: [themedFoldGutter()],
		});
		expect(() => {
			const view = new EditorView({
				state,
				parent: (globalThis as any).document.createElement("div"),
			});
			view.destroy();
		}).not.toThrow();
	});

	it("keeps folding state when the gutter is hidden", () => {
		const gutterCompartment = new Compartment();
		const doc = "function hello() {\n  return 'world';\n}\n";
		let state = EditorState.create({
			doc,
			extensions: [
				foldingStateExtension,
				lspFoldingExtension,
				lspFoldingField.init(() => [
					{ startLine: 0, endLine: 2, kind: "region" as const },
				]),
				gutterCompartment.of(themedFoldGutter()),
			],
		});

		state = state.update({ effects: foldEffect.of({ from: 0, to: 18 }) }).state;
		expect(foldedRanges(state).size).toBe(1);

		state = state.update({ effects: gutterCompartment.reconfigure([]) }).state;
		expect(foldedRanges(state).size).toBe(1);
	});
});

describe("LSP folding service and fallback", () => {
	it("uses LSP folding ranges when available", () => {
		const doc = "function hello() {\n  return 'world';\n}\n";
		const lspRanges: LspFoldingRange[] = [
			{
				startLine: 0,
				endLine: 2,
				kind: "region",
			},
		];

		const state = EditorState.create({
			doc,
			selection: { anchor: 5 },
			extensions: [
				codeFolding(),
				lspFoldingExtension,
				lspFoldingField.init(() => lspRanges),
			],
		});
		const view = new EditorView({
			state,
			parent: (globalThis as any).document.createElement("div"),
		});

		expect(foldedRanges(view.state).size).toBe(0);

		foldCode(view);
		expect(foldedRanges(view.state).size).toBe(1);

		unfoldCode(view);
		expect(foldedRanges(view.state).size).toBe(0);

		view.destroy();
	});

	it("updates LSP folding ranges dynamically via setLspFoldingEffect", () => {
		const doc = "line 1\nline 2\nline 3\nline 4\n";
		let state = EditorState.create({
			doc,
			extensions: [codeFolding(), lspFoldingExtension],
		});
		const view = new EditorView({
			state,
			parent: (globalThis as any).document.createElement("div"),
		});

		expect(view.state.field(lspFoldingField)).toEqual([]);

		const newRanges: LspFoldingRange[] = [
			{ startLine: 0, endLine: 3, kind: "region" },
		];
		view.dispatch({ effects: setLspFoldingEffect.of(newRanges) });
		expect(view.state.field(lspFoldingField)).toEqual(newRanges);

		// Can fold via the newly delivered LSP range
		foldCode(view);
		expect(foldedRanges(view.state).size).toBe(1);

		view.destroy();
	});

	it("falls back to syntax tree folding when no LSP ranges match", async () => {
		const desc = languages.find((l) => l.name === "JavaScript")!;
		const jsLang = await desc.load();

		const doc = "function foo() {\n  return 42;\n}\n";
		const state = EditorState.create({
			doc,
			selection: { anchor: 5 },
			extensions: [
				jsLang,
				codeFolding(),
				lspFoldingExtension, // empty LSP ranges
			],
		});
		const view = new EditorView({
			state,
			parent: (globalThis as any).document.createElement("div"),
		});

		// Syntax tree folding should succeed even with empty LSP field
		foldCode(view);
		expect(foldedRanges(view.state).size).toBe(1);

		unfoldCode(view);
		expect(foldedRanges(view.state).size).toBe(0);

		view.destroy();
	});
});
