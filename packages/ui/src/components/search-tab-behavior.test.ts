import { describe, it, expect } from "bun:test";
import { SEARCH_TAB_ID } from "../../../core/src/tab-ids";
import {
	hasDirtyResults,
	isResultFileDirty,
	shouldFocusSearchInput,
	shouldRunSearchOnKeydown,
	shouldUndoReplaceAllOperation,
	searchStatusText,
	truncationCapText,
	countText
} from "./search-tab-behavior";


describe("Search tab undo decision (Issue #336)", () => {
	it("undoes the whole replace-all operation when it is the newest action", () => {
		expect(
			shouldUndoReplaceAllOperation({
				hasPendingReplaceAll: true,
				manualEditAfterReplaceAll: false
			})
		).toBe(true);
	});

	it("leaves a manual edit to the editor's own history", () => {
		// A manual edit made after the replace-all is newer, so the editor
		// undoes that one first.
		expect(
			shouldUndoReplaceAllOperation({
				hasPendingReplaceAll: true,
				manualEditAfterReplaceAll: true
			})
		).toBe(false);
	});

	it("leaves the editor's own history alone when there is no replace-all to undo", () => {
		expect(
			shouldUndoReplaceAllOperation({
				hasPendingReplaceAll: false,
				manualEditAfterReplaceAll: false
			})
		).toBe(false);
	});
});

describe("Search tab dirty markers (Issue #336)", () => {
	const documents = [
		{ uri: "file:///p/a.ts", isModified: true },
		{ uri: "file:///p/b.ts", isModified: false },
		{ uri: null, isModified: true }
	];

	it("marks the file whose document holds unsaved edits", () => {
		expect(isResultFileDirty("file:///p/a.ts", documents)).toBe(true);
		expect(isResultFileDirty("file:///p/b.ts", documents)).toBe(false);
		expect(isResultFileDirty("file:///p/c.ts", documents)).toBe(false);
	});

	it("marks the tab when any file it shows holds unsaved edits", () => {
		expect(hasDirtyResults(["file:///p/b.ts"], documents)).toBe(false);
		expect(hasDirtyResults(["file:///p/b.ts", "file:///p/a.ts"], documents)).toBe(true);
		// A file the results no longer show does not mark the tab.
		expect(hasDirtyResults(["file:///p/b.ts"], documents)).toBe(false);
		// No results, no marker.
		expect(hasDirtyResults([], documents)).toBe(false);
	});
});

describe("Search tab keyboard decisions (Issue #337)", () => {
	it("runs the search on Enter", () => {
		expect(shouldRunSearchOnKeydown({ key: "Enter" })).toBe(true);
		expect(shouldRunSearchOnKeydown({ key: "Enter", isComposing: false })).toBe(true);
	});

	it("does not run the search while an IME composition is active", () => {
		// Enter confirms the composition candidate, not the query.
		expect(shouldRunSearchOnKeydown({ key: "Enter", isComposing: true })).toBe(false);
	});

	it("ignores keys that do not ask for a search", () => {
		expect(shouldRunSearchOnKeydown({ key: "a" })).toBe(false);
		expect(shouldRunSearchOnKeydown({ key: "Escape" })).toBe(false);
		expect(shouldRunSearchOnKeydown({ key: "Tab" })).toBe(false);
	});
});

describe("Search tab focus decision (Issue #337)", () => {
	it("focuses the query input when the search tab was opened", () => {
		expect(
			shouldFocusSearchInput({
				focusNonce: 1,
				activeTabId: "doc-1",
				searchTabId: SEARCH_TAB_ID
			})
		).toBe(true);
	});

	it("focuses the query input while the project search tab is active", () => {
		expect(
			shouldFocusSearchInput({
				focusNonce: 0,
				activeTabId: SEARCH_TAB_ID,
				searchTabId: SEARCH_TAB_ID
			})
		).toBe(true);
	});

	it("leaves the focus alone for another tab", () => {
		expect(
			shouldFocusSearchInput({
				focusNonce: 0,
				activeTabId: "doc-1",
				searchTabId: SEARCH_TAB_ID
			})
		).toBe(false);
	});
});

describe("Search tab status line (Issue #337)", () => {
	it("reports the live counts while the search runs", () => {
		expect(
			searchStatusText({
				isSearching: true,
				totalMatches: 0,
				fileCount: 0,
				isQueryEmpty: false
			})
		).toBe("Searching...");

		expect(
			searchStatusText({
				isSearching: true,
				totalMatches: 3,
				fileCount: 2,
				isQueryEmpty: false
			})
		).toBe("Searching... 3 matches across 2 files");
	});

	it("reports the final counts when the search is done", () => {
		expect(
			searchStatusText({
				isSearching: false,
				totalMatches: 1,
				fileCount: 1,
				isQueryEmpty: false
			})
		).toBe("1 match across 1 file");

		expect(
			searchStatusText({
				isSearching: false,
				totalMatches: 4,
				fileCount: 2,
				isQueryEmpty: false
			})
		).toBe("4 matches across 2 files");
	});

	it("asks for a query when there is none", () => {
		expect(
			searchStatusText({
				isSearching: false,
				totalMatches: 0,
				fileCount: 0,
				isQueryEmpty: true
			})
		).toBe("Type a query to search");
	});

	it("reports an empty result", () => {
		expect(
			searchStatusText({
				isSearching: false,
				totalMatches: 0,
				fileCount: 0,
				isQueryEmpty: false
			})
		).toBe("No results found");
	});
});

describe("Search tab truncation notice (Issue #337)", () => {
	it("names the cap that was hit", () => {
		expect(truncationCapText("files")).toBe("5,000 files");
		expect(truncationCapText("matches")).toBe("10,000 matches");
	});
});

describe("Count text (Issue #337)", () => {
	it("uses the singular for one and the plural for the rest", () => {
		expect(countText(0, "match", "matches")).toBe("0 matches");
		expect(countText(1, "match", "matches")).toBe("1 match");
		expect(countText(2, "match", "matches")).toBe("2 matches");
		expect(countText(1, "file", "files")).toBe("1 file");
		expect(countText(3, "file", "files")).toBe("3 files");
	});
});

describe("Search tab undo decision (Issue #336)", () => {
	it("undoes the whole replace-all operation when it is the newest action", () => {
		expect(
			shouldUndoReplaceAllOperation({
				hasPendingReplaceAll: true,
				manualEditAfterReplaceAll: false
			})
		).toBe(true);
	});

	it("leaves a manual edit to the editor's own history", () => {
		// A manual edit made after the replace-all is newer, so the editor
		// undoes that one first.
		expect(
			shouldUndoReplaceAllOperation({
				hasPendingReplaceAll: true,
				manualEditAfterReplaceAll: true
			})
		).toBe(false);
	});

	it("leaves the editor's own history alone when there is no replace-all to undo", () => {
		expect(
			shouldUndoReplaceAllOperation({
				hasPendingReplaceAll: false,
				manualEditAfterReplaceAll: false
			})
		).toBe(false);
	});
});
