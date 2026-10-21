import "../../../../tests/contract/rune-setup";
import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultKeymap } from "../../../core/src/keymap.svelte";

const SEARCH_TAB_SRC = fs.readFileSync(path.join(__dirname, "SearchTab.svelte"), "utf-8");
const PANE_SRC = fs.readFileSync(path.join(__dirname, "Pane.svelte"), "utf-8");
const MAIN_LAYOUT_SRC = fs.readFileSync(path.join(__dirname, "MainLayout.svelte"), "utf-8");

describe("Search tab UI contract and template audit (Issue #334)", () => {
	it("SearchTab contains query bar on top and MultiBuffer grouped results below", () => {
		expect(SEARCH_TAB_SRC).toContain('placeholder="Search project (literal)..."');
		expect(SEARCH_TAB_SRC).toContain("<MultiBuffer");
		expect(SEARCH_TAB_SRC).toContain("jumpToMatch");
		expect(SEARCH_TAB_SRC).toContain("openFile");
	});

	it("renders visible truncation notice when results hit caps", () => {
		expect(SEARCH_TAB_SRC).toContain("isTruncated");
		expect(SEARCH_TAB_SRC).toContain("Results truncated: capped at");
		expect(SEARCH_TAB_SRC).toContain("5,000 files");
		expect(SEARCH_TAB_SRC).toContain("10,000 matches");
	});

	it("renders context lines before and after matches", () => {
		expect(SEARCH_TAB_SRC).toContain("match.contextBefore");
		expect(SEARCH_TAB_SRC).toContain("match.contextAfter");
		expect(SEARCH_TAB_SRC).toContain("<mark");
	});

	it("clicking a match sets pendingLineToScroll, pendingColumn, and pendingMatchLength", () => {
		expect(SEARCH_TAB_SRC).toContain("doc.pendingLineToScroll = match.line;");
		expect(SEARCH_TAB_SRC).toContain("doc.pendingColumn = match.column;");
		expect(SEARCH_TAB_SRC).toContain("doc.pendingMatchLength = match.matchLength;");
	});

	it("the pane shell renders SearchTab when tab.type is 'search'", () => {
		// The pane shell owns tab rendering (MainLayout only hosts the split
		// tree), so the search tab is rendered per pane.
		expect(PANE_SRC).toContain("tab.type === 'search'");
		expect(PANE_SRC).toContain("<SearchTab />");
		expect(MAIN_LAYOUT_SRC).toContain("<SplitTree");
	});

	it("defaultKeymap binds cmd+shift+f and space / to edit.findInFiles", () => {
		const vimBlock = defaultKeymap.find((b) => b.context === "editor && vim_mode == normal");
		expect(vimBlock).toBeDefined();
		expect(vimBlock!.bindings["space /"]).toBe("edit.findInFiles");

		const editorBlock = defaultKeymap.find((b) => b.context === "editor");
		expect(editorBlock).toBeDefined();
		expect(editorBlock!.bindings["cmd+shift+f"]).toBe("edit.findInFiles");

		const globalBlock = defaultKeymap.find((b) => !b.context);
		expect(globalBlock).toBeDefined();
		expect(globalBlock!.bindings["cmd+shift+f"]).toBe("edit.findInFiles");
	});
});
