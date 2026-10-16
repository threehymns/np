import "../../../../tests/contract/rune-setup";
import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultKeymap } from "../../../core/src/keymap.svelte";

const SEARCH_TAB_SRC = fs.readFileSync(path.join(__dirname, "SearchTab.svelte"), "utf-8");
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

	it("MainLayout renders SearchTab when tab.type is 'search'", () => {
		expect(MAIN_LAYOUT_SRC).toContain("tab.type === 'search'");
		expect(MAIN_LAYOUT_SRC).toContain("<SearchTab />");
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

describe("Project search 6: keybinding, streaming, counts, and truncation polish (Issue #337)", () => {
	it("focuses search input when opened or activated", () => {
		expect(SEARCH_TAB_SRC).toContain("inputRef");
		expect(SEARCH_TAB_SRC).toContain("bind:this={inputRef}");
		expect(SEARCH_TAB_SRC).toContain("appState.workspace.searchTabFocusNonce");
		expect(SEARCH_TAB_SRC).toContain("inputRef.focus();");
		expect(SEARCH_TAB_SRC).toContain("inputRef.select();");
	});

	it("in-progress searches show streaming state and live match/file counts", () => {
		expect(SEARCH_TAB_SRC).toContain("isSearching");
		expect(SEARCH_TAB_SRC).toContain("CircleNotchIcon");
		expect(SEARCH_TAB_SRC).toContain("animate-spin");
		expect(SEARCH_TAB_SRC).toContain("role=\"progressbar\"");
		expect(SEARCH_TAB_SRC).toContain("Searching... {totalMatches}");
	});

	it("completed searches display final match and file counts", () => {
		expect(SEARCH_TAB_SRC).toContain("{totalMatches} {totalMatches === 1 ? 'match' : 'matches'} across {fileResults.length}");
		expect(SEARCH_TAB_SRC).toContain("No results found");
		expect(SEARCH_TAB_SRC).toContain("Type a query to search");
	});

	it("truncation notice is unmissable when caps are hit", () => {
		expect(SEARCH_TAB_SRC).toContain('role="alert"');
		expect(SEARCH_TAB_SRC).toContain('aria-live="assertive"');
		expect(SEARCH_TAB_SRC).toContain("WarningIcon");
		expect(SEARCH_TAB_SRC).toContain("<strong>Results truncated:</strong> capped at");
		expect(SEARCH_TAB_SRC).toContain("5,000 files");
		expect(SEARCH_TAB_SRC).toContain("10,000 matches");
		expect(SEARCH_TAB_SRC).toContain("Refine your query");
	});

	it("keybinding cmd+shift+f is registered without duplication and maps to edit.findInFiles", () => {
		const editorBindings = defaultKeymap.find((b) => b.context === "editor")?.bindings ?? {};
		const globalBindings = defaultKeymap.find((b) => !b.context)?.bindings ?? {};

		expect(editorBindings["cmd+shift+f"]).toBe("edit.findInFiles");
		expect(globalBindings["cmd+shift+f"]).toBe("edit.findInFiles");

		// Ensure no accidental duplicate or conflicting find-in-files commands
		const allFindInFiles = Object.entries(globalBindings).filter(([_, cmd]) => cmd === "edit.findInFiles");
		expect(allFindInFiles.length).toBe(1);
		expect(allFindInFiles[0][0]).toBe("cmd+shift+f");
	});
});
