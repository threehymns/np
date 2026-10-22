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
		expect(SEARCH_TAB_SRC).toContain('placeholder="Search project..."');
		expect(SEARCH_TAB_SRC).not.toContain("(literal)");
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
		expect(MAIN_LAYOUT_SRC).toContain("<SplitTree");
	});

	it("the pane passes the search tab its id, so the tab reads its own session", () => {
		// A search tab can be the active tab of a pane that is not the
		// active one, so the tab id is what identifies its session.
		expect(PANE_SRC).toContain("<SearchTab tabId={tab.id} />");
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

describe("Search tab full query bar contract and template audit (Issue #335)", () => {
	it("renders case-sensitive, whole-word, and regex toggle buttons with accessible aria labels", () => {
		expect(SEARCH_TAB_SRC).toContain('aria-label="Match Case"');
		expect(SEARCH_TAB_SRC).toContain('aria-label="Match Whole Word"');
		expect(SEARCH_TAB_SRC).toContain('aria-label="Use Regular Expression"');
		expect(SEARCH_TAB_SRC).toContain("toggleCaseSensitive");
		expect(SEARCH_TAB_SRC).toContain("toggleWholeWord");
		expect(SEARCH_TAB_SRC).toContain("toggleRegex");
	});

	it("renders file include and exclude glob inputs", () => {
		expect(SEARCH_TAB_SRC).toContain('aria-label="Files to include"');
		expect(SEARCH_TAB_SRC).toContain('aria-label="Files to exclude"');
		expect(SEARCH_TAB_SRC).toContain("session.includePattern");
		expect(SEARCH_TAB_SRC).toContain("session.excludePattern");
	});

	it("renders inline error on invalid regex with role=alert", () => {
		expect(SEARCH_TAB_SRC).toContain("session.regexError");
		expect(SEARCH_TAB_SRC).toContain('role="alert"');
	});

	it("wires search tab state to workspace session for tab-open persistence", () => {
		expect(SEARCH_TAB_SRC).toContain("appState.workspace.getSearchSession");
		expect(SEARCH_TAB_SRC).toContain("session.query");
	});
});

describe("Editable multibuffer and replace-all contract audit (Issue #336)", () => {
	it("contains replace input and Replace All button in query bar", () => {
		expect(SEARCH_TAB_SRC).toContain('placeholder="Replace with..."');
		expect(SEARCH_TAB_SRC).toContain('aria-label="Replace query"');
		expect(SEARCH_TAB_SRC).toContain('aria-label="Replace all"');
		expect(SEARCH_TAB_SRC).toContain("Replace All");
	});

	it("wires editable multibuffer via setupExcerptEditor and FileExcerptMap", () => {
		expect(SEARCH_TAB_SRC).toContain("use:setupExcerptEditor");
		expect(SEARCH_TAB_SRC).toContain("new FileExcerptMap");
		expect(SEARCH_TAB_SRC).toContain("mapExcerptEditToFileEdit");
		expect(SEARCH_TAB_SRC).toContain("applyUserEditToFile");
	});

	it("wires replaceAll calling applyReplaceAll across results without modals or summary", () => {
		expect(SEARCH_TAB_SRC).toContain("applyReplaceAll");
		expect(SEARCH_TAB_SRC).toContain("replaceAll");
		// Ensure no confirmation modal or summary report is triggered
		expect(SEARCH_TAB_SRC).not.toContain("window.confirm");
		expect(SEARCH_TAB_SRC).not.toContain("window.alert");
	});

	it("never opens a tab for an edit made in the results", () => {
		// The results are the editor for the files they show: an edit in a
		// file that is not open changes a Document with no tab. Opening a
		// file is what a click on a match does, and it is not what an edit
		// does.
		const start = SEARCH_TAB_SRC.indexOf("async function applyUserEditToFile");
		const end = SEARCH_TAB_SRC.indexOf("async function ", start + 10);
		const editPath = SEARCH_TAB_SRC.slice(start, end);
		expect(editPath).toContain("getOrCreateBoundDocument");
		expect(editPath).not.toContain("openFile");
		// Nothing is written before the user saves: the file stays dirty in
		// memory, the way an editor leaves a changed file dirty.
		expect(editPath).not.toContain("saveFile");
	});

	it("marks unsaved work in the results on the file and on the tab", () => {
		// The tab strip shows the search tab as holding unsaved changes when
		// a file its results show is dirty, and each file's header shows its
		// own dot. Both read the same Document.isModified a document tab
		// reads.
		expect(SEARCH_TAB_SRC).toContain("isResultFileDirty");
		expect(SEARCH_TAB_SRC).toContain("session.resultUris");
		expect(PANE_SRC).toContain("hasDirtyResults");
		expect(PANE_SRC).toContain("searchSession.resultUris");
	});

	it("saves the file under the cursor from the results", () => {
		// A replace leaves the file unsaved, and the results have no save
		// button: Mod-s saves the file the user is working in.
		expect(SEARCH_TAB_SRC).toContain("key: 'Mod-s'");
		expect(SEARCH_TAB_SRC).toContain("saveExcerptFile");
		expect(SEARCH_TAB_SRC).toContain("saveDocument");
	});

	it("searches the text the results show, not the disk", () => {
		// A replace edits the file in memory, so the re-run after it has to
		// read the Document. Reading the disk would show the replaced text
		// as if the replace had not happened.
		expect(SEARCH_TAB_SRC).toContain("liveContent");
	});

	it("keeps the replace-all operation as one undo step in the search tab", () => {
		// A replace-all is one operation across every file it changed, so the
		// search tab keeps it and undoes it as one step. A tab per changed
		// file used to be the only place that undo could come from.
		expect(SEARCH_TAB_SRC).toContain("replaceAllUndos");
		expect(SEARCH_TAB_SRC).toContain("undoReplaceAll");
		expect(SEARCH_TAB_SRC).toContain("shouldUndoReplaceAllOperation");
		// The excerpt editors keep their own history, so a manual edit is
		// undone one edit at a time.
		expect(SEARCH_TAB_SRC).toContain("history()");
		expect(SEARCH_TAB_SRC).toContain("historyKeymap");
		expect(SEARCH_TAB_SRC).toContain("key: 'Mod-z'");
	});

	it("makes replace-all undo guard state-based rather than using manualEditCount", () => {
		expect(SEARCH_TAB_SRC).not.toContain("manualEditCount");
		expect(SEARCH_TAB_SRC).toContain("currentChange.after");
	});

	it("replaces across the session's query, not a component-local pattern", () => {
		// The query lives in the workspace session, so replace-all works on
		// the query the user typed, with the options that go with it.
		expect(SEARCH_TAB_SRC).toContain("session.query");
		expect(SEARCH_TAB_SRC).not.toContain("queryText");
	});

	it("keeps the excerpt map in sync after direct user edits", () => {
		expect(SEARCH_TAB_SRC).toContain("excerptMap.applyExcerptEdit(excerptEdit, fileEdit)");
		// Pre-transaction coordinates are handled latest-first so each edit
		// still refers to the map's current coordinate space.
		expect(SEARCH_TAB_SRC).toContain("changes.sort((a, b) => b.from - a.from)");
	});
});

describe("Editable results safety guards contract audit (Issue #336)", () => {
	it("rejects edits touching excerpt separators via a change filter", () => {
		expect(SEARCH_TAB_SRC).toContain("changeFilter");
		expect(SEARCH_TAB_SRC).toContain("rejectSeparatorEdits");
		// Separator bounds must be read live from the map, not snapshotted:
		// applyExcerptEdit shifts them after every edit.
		expect(SEARCH_TAB_SRC).toContain("excerptMap.excerpts[i].bufferEnd");
	});

	it("detects external document changes via revision tracking and rebuilds the view", () => {
		expect(SEARCH_TAB_SRC).toContain("mapRevision");
		expect(SEARCH_TAB_SRC).toContain("liveDoc.revision !== mapRevision");
		// Document writes are serialized per view so an in-flight edit of our
		// own never looks like an external change.
		expect(SEARCH_TAB_SRC).toContain("applyChain");
	});

	it("rebuilds a stale excerpt map when the document changes outside the view", () => {
		// The view watches the documents it mirrors and rebuilds the map
		// from the document's current content when they diverge.
		expect(SEARCH_TAB_SRC).toContain("isExcerptMapStale");
		expect(SEARCH_TAB_SRC).toContain("entry.rebuild()");
		expect(SEARCH_TAB_SRC).toContain("appState.workspace.documents");
		// The rebuilt map re-derives the file's matches from the session's
		// query, so its offsets describe the content the document holds.
		expect(SEARCH_TAB_SRC).toContain("buildExcerptMapForContent");
		expect(SEARCH_TAB_SRC).toContain("session.toQuery()");
	});
});
