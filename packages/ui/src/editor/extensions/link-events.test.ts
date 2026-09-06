import { describe, it, expect } from "bun:test";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { Table, GFM } from "@lezer/markdown";
import { WikiLinkExtension } from "./wikilinks";
import { decideLinkClick, decideLinkMousedown } from "./link-events";

function mdState(doc: string): EditorState {
	const mdExt = markdown({ extensions: [Table, GFM, WikiLinkExtension] as any });
	return EditorState.create({ doc, extensions: [mdExt] });
}

/** Fake event target: only classList/closest matter to the verdicts. */
function fakeTarget(...classes: string[]) {
	return {
		classList: { contains: (c: string) => classes.includes(c) },
		closest: (sel: string) =>
			(sel === ".cm-link" && classes.includes("cm-link")) ||
			(sel === ".cm-link-expanded" && classes.includes("cm-link-expanded"))
				? {}
				: null,
	} as any;
}

const lineTarget = () => fakeTarget("cm-line");
const linkTarget = () => fakeTarget("cm-link");
const expandedTarget = () => fakeTarget("cm-link", "cm-link-expanded");

describe("collapsed wikilink at end of line", () => {
	// "See [[Note Target]]": label spans 6..17, hidden "]]" spans 17..19.
	// A click in trailing empty space snaps to pos 17 (the label edge).
	const doc = "See [[Note Target]]";
	const state = mdState(doc);

	it("does not open on a snapped trailing-space click", () => {
		expect(decideLinkMousedown(state, 17, lineTarget(), false)).toBe(false);
		expect(decideLinkClick(state, 17, lineTarget(), false)).toEqual({
			kind: null,
			raw: "",
		});
	});

	it("still opens on a genuine label click", () => {
		expect(decideLinkMousedown(state, 8, linkTarget(), false)).toBe(true);
		expect(decideLinkClick(state, 8, linkTarget(), false)).toEqual({
			kind: "wikilink",
			raw: "[[Note Target]]",
		});
	});

	it("still opens on the last glyph (label edge with link target)", () => {
		expect(decideLinkClick(state, 17, linkTarget(), false)).toEqual({
			kind: "wikilink",
			raw: "[[Note Target]]",
		});
	});

	it("does not claim when expanded", () => {
		expect(decideLinkMousedown(state, 8, expandedTarget(), false)).toBe(false);
		expect(decideLinkClick(state, 8, expandedTarget(), false)).toEqual({
			kind: null,
			raw: "",
		});
	});
});

describe("standard link at end of line", () => {
	const doc = "click [ext label](https://example.com)";
	const state = mdState(doc);
	const labelStart = doc.indexOf("ext label");
	const labelEnd = labelStart + "ext label".length;

	it("does not open on a snapped trailing-space click", () => {
		expect(decideLinkMousedown(state, labelEnd, lineTarget(), false)).toBe(
			false
		);
		expect(decideLinkClick(state, labelEnd, lineTarget(), false)).toEqual({
			kind: null,
			raw: "",
		});
	});

	it("still opens on a genuine label click", () => {
		expect(
			decideLinkClick(state, labelStart + 1, linkTarget(), false)
		).toEqual({ kind: "link", raw: "https://example.com" });
	});
});

describe("bare external URL", () => {
	const doc = "visit https://example.com";
	const state = mdState(doc);
	const urlStart = doc.indexOf("https:");
	const urlEnd = doc.length;

	it("does not claim a snapped trailing-edge click (stays inert)", () => {
		expect(decideLinkMousedown(state, urlEnd, lineTarget(), false)).toBe(
			false
		);
		expect(decideLinkClick(state, urlEnd, lineTarget(), false)).toEqual({
			kind: null,
			raw: "",
		});
	});

	it("opens a bare https:// URL when clicked on its body", () => {
		expect(
			decideLinkClick(state, urlStart, lineTarget(), false)
		).toEqual({ kind: "link", raw: "https://example.com" });
	});

	it("normalizes a bare www. URL to https:// when clicked", () => {
		const www = "visit www.example.com";
		const wState = mdState(www);
		const wStart = www.indexOf("www.");
		expect(
			decideLinkClick(wState, wStart, lineTarget(), false)
		).toEqual({ kind: "link", raw: "https://www.example.com" });
	});
});
