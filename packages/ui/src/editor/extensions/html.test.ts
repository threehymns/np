import { describe, it, expect, beforeAll } from "bun:test";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { HTMLBreakWidget, HTMLBlockWidget, htmlPassthroughPlugin } from "./html";
import { readFileSync } from "fs";
import { resolve } from "path";

// Setup minimal DOM mock so EditorView tests can run headless in bun test
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

function getPluginDecorations(doc: string, selection?: { anchor: number; head?: number }, hasFocus = false) {
	const state = EditorState.create({
		doc,
		selection,
		extensions: [markdown()],
	});
	const inst: any = htmlPassthroughPlugin.create(
		{
			state,
			hasFocus,
			visibleRanges: [{ from: 0, to: state.doc.length }],
		} as any,
		undefined as any,
	);
	return inst.decorations;
}

describe("Obsidian HTML Passthrough Live Preview", () => {
	it("loads EditorView when doc is only an HTML tag with content (inline and multiline)", () => {
		const singleLineDoc = "<div>stuff</div>";
		const stateSingle = EditorState.create({ doc: singleLineDoc, extensions: [markdown(), htmlPassthroughPlugin] });
		const viewSingle = new EditorView({ state: stateSingle });
		expect(viewSingle).toBeDefined();
		viewSingle.destroy();

		const multilineDoc = "<div>\nstuff\n</div>";
		const stateMulti = EditorState.create({ doc: multilineDoc, extensions: [markdown(), htmlPassthroughPlugin] });
		const viewMulti = new EditorView({ state: stateMulti });
		expect(viewMulti).toBeDefined();
		viewMulti.destroy();
	});

	it("never emits replacement decorations that cross line breaks", () => {
		const multilineDoc = "<div>\nstuff\n</div>\n<!--\nmultiline comment\n-->";
		const state = EditorState.create({ doc: multilineDoc, extensions: [markdown()] });
		const decos = getPluginDecorations(multilineDoc);

		decos.between(0, multilineDoc.length, (from: number, to: number, value: any) => {
			if (!value.spec?.class) {
				const fromLine = state.doc.lineAt(from).number;
				const toLine = state.doc.lineAt(to).number;
				expect(fromLine).toBe(toLine);
			}
		});
	});

	it("renders HTMLBlock with HTMLBlockWidget off-cursor", () => {
		const doc = "<table>\n  <tr><td>hello</td></tr>\n</table>";
		const decos = getPluginDecorations(doc);
		let foundBlockWidget = false;

		decos.between(0, doc.length, (from: number, to: number, value: any) => {
			if (value.spec?.widget instanceof HTMLBlockWidget) {
				foundBlockWidget = true;
			}
		});

		expect(foundBlockWidget).toBe(true);
	});

	it("renders HTMLBlock containing blank lines as a single HTMLBlockWidget off-cursor", () => {
		const doc = `<div class="border-2 p-2 rounded-xl bg-primary text-primary-foreground">\nThis is line 1\n\nThis is line 2 after blank line\n</div>`;
		const decos = getPluginDecorations(doc);
		let blockWidgetCount = 0;
		let widgetRawHtml = "";

		decos.between(0, doc.length, (from: number, to: number, value: any) => {
			if (value.spec?.widget instanceof HTMLBlockWidget) {
				blockWidgetCount++;
				widgetRawHtml = value.spec.widget.rawHtml;
			}
		});

		expect(blockWidgetCount).toBe(1);
		expect(widgetRawHtml).toContain("This is line 1");
		expect(widgetRawHtml).toContain("This is line 2 after blank line");
	});

	it("expands HTMLBlock with blank lines when cursor is inside", () => {
		const doc = `<div class="border-2 p-2 rounded-xl bg-primary text-primary-foreground">\nThis is line 1\n\nThis is line 2 after blank line\n</div>`;
		// Cursor placed on the blank line or inside line 2
		const decos = getPluginDecorations(doc, { anchor: 90 }, true);
		let blockWidgetCount = 0;

		decos.between(0, doc.length, (from: number, to: number, value: any) => {
			if (value.spec?.widget instanceof HTMLBlockWidget) {
				blockWidgetCount++;
			}
		});

		expect(blockWidgetCount).toBe(0);
	});

	it("renders iframes with HTMLBlockWidget off-cursor", () => {
		const doc = '<iframe src="https://example.com"></iframe>';
		const decos = getPluginDecorations(doc);
		let foundIframeWidget = false;

		decos.between(0, doc.length, (from: number, to: number, value: any) => {
			if (value.spec?.widget instanceof HTMLBlockWidget) {
				foundIframeWidget = true;
			}
		});

		expect(foundIframeWidget).toBe(true);
	});

	it("HTMLBlockWidget equality does not depend on document offsets so widgets are preserved during unrelated edits", () => {
		const html = '<iframe src="https://example.com"></iframe>';
		const widget1 = new HTMLBlockWidget(html, 10, 50);
		const widget2 = new HTMLBlockWidget(html, 20, 60);
		const widgetDifferentHtml = new HTMLBlockWidget('<iframe src="https://other.com"></iframe>', 10, 50);

		expect(widget1.eq(widget2)).toBe(true);
		expect(widget1.eq(widgetDifferentHtml)).toBe(false);
	});

	it("hides <u> tags and applies cm-html-u off-cursor", () => {
		const doc = "Some <u>underlined</u> text";
		const decos = getPluginDecorations(doc);
		let foundTagHiding = false;
		let foundClass = false;

		decos.between(0, doc.length, (from: number, to: number, value: any) => {
			if (from === 5 && to === 8 && !value.spec?.class) {
				foundTagHiding = true;
			}
			if (from === 8 && to === 18 && value.spec?.class?.includes("cm-html-u")) {
				foundClass = true;
			}
		});

		expect(foundTagHiding).toBe(true);
		expect(foundClass).toBe(true);
	});

	it("hides <sub> and <sup> tags and applies sub/sup styling off-cursor", () => {
		const doc = "H<sub>2</sub>O and E=mc<sup>2</sup>";
		const decos = getPluginDecorations(doc);
		let foundSubClass = false;
		let foundSupClass = false;

		decos.between(0, doc.length, (from: number, to: number, value: any) => {
			if (value.spec?.class?.includes("cm-html-sub")) {
				foundSubClass = true;
			}
			if (value.spec?.class?.includes("cm-html-sup")) {
				foundSupClass = true;
			}
		});

		expect(foundSubClass).toBe(true);
		expect(foundSupClass).toBe(true);
	});

	it("replaces <br> with HTMLBreakWidget off-cursor", () => {
		const doc = "Line 1<br>Line 2";
		const decos = getPluginDecorations(doc);
		let foundBrWidget = false;

		decos.between(0, doc.length, (from: number, to: number, value: any) => {
			if (value.spec?.widget instanceof HTMLBreakWidget) {
				foundBrWidget = true;
			}
		});

		expect(foundBrWidget).toBe(true);
	});

	it("hides inline span tags and applies styles off-cursor", () => {
		const doc = 'Some text <span style="color: red;">Hello world</span> more text';
		const openTag = '<span style="color: red;">';
		const openFrom = doc.indexOf(openTag);
		const openTo = openFrom + openTag.length;
		const contentFrom = openTo;
		const contentTo = contentFrom + "Hello world".length;

		const decos = getPluginDecorations(doc);
		let foundTagHiding = false;
		let foundStyle = false;

		decos.between(0, doc.length, (from: number, to: number, value: any) => {
			if (from === openFrom && to === openTo && !value.spec?.class) {
				foundTagHiding = true;
			}
			if (from === contentFrom && to === contentTo && value.spec?.attributes?.style?.includes("color: red;")) {
				foundStyle = true;
			}
		});

		expect(foundTagHiding).toBe(true);
		expect(foundStyle).toBe(true);
	});

	it("hides HTML comments off-cursor", () => {
		const doc = "Before <!-- hidden comment --> After";
		const decos = getPluginDecorations(doc);
		let foundCommentHidden = false;

		decos.between(0, doc.length, (from: number, to: number, value: any) => {
			if (from === 7 && to === 30) {
				foundCommentHidden = true;
			}
		});

		expect(foundCommentHidden).toBe(true);
	});

	it("expands raw tags and hides no markers when focused and cursor inside tag", () => {
		const doc = "Some <u>underlined</u> text";
		// Cursor placed inside the <u> tag at index 6
		const decos = getPluginDecorations(doc, { anchor: 6 }, true);
		let foundOpeningTagHiding = false;

		decos.between(0, doc.length, (from: number, to: number, value: any) => {
			if (from === 5 && to === 8 && !value.spec?.class) {
				foundOpeningTagHiding = true;
			}
		});

		expect(foundOpeningTagHiding).toBe(false);
	});

	it("expands HTMLBlock widget to raw source when focused", () => {
		const doc = "<table>\n  <tr><td>hello</td></tr>\n</table>";
		// Cursor placed inside the table at index 5
		const decos = getPluginDecorations(doc, { anchor: 5 }, true);
		let foundBlockWidget = false;

		decos.between(0, doc.length, (from: number, to: number, value: any) => {
			if (value.spec?.widget instanceof HTMLBlockWidget) {
				foundBlockWidget = true;
			}
		});

		expect(foundBlockWidget).toBe(false);
	});

	it("does not decorate inline HTML inside inline code or code blocks", () => {
		const doc = "Here is `<u>not underlined</u>` code";
		const decos = getPluginDecorations(doc);
		let foundInsideCode = false;

		decos.between(0, doc.length, (from: number, to: number, value: any) => {
			if (from >= 8 && to <= 31) {
				foundInsideCode = true;
			}
		});

		expect(foundInsideCode).toBe(false);
	});

	it("applies custom class on span off-cursor", () => {
		const doc = '<span class=\"custom-badge\">text</span>';
		const decos = getPluginDecorations(doc);
		let foundCustomClass = false;

		decos.between(0, doc.length, (from: number, to: number, value: any) => {
			if (value.spec?.class?.includes("custom-badge")) {
				foundCustomClass = true;
			}
		});

		expect(foundCustomClass).toBe(true);
	});

	it("preserves markdown.css styles for checkboxes, badges, embeds, footnotes, callouts, and html blocks", () => {
		const cssPath = resolve(__dirname, "../styles/markdown.css");
		const cssContent = readFileSync(cssPath, "utf-8");

		expect(cssContent).toContain(".cm-task-checkbox");
		expect(cssContent).toContain(".cm-size-badge");
		expect(cssContent).toContain(".cm-embed");
		expect(cssContent).toContain(".cm-footnote");
		expect(cssContent).toContain(".cm-callout");
		expect(cssContent).toContain(".cm-html-block-widget");
		expect(cssContent).toContain(".cm-html-block-hidden-line");
		expect(cssContent).toContain("white-space: normal;");
	});
});
