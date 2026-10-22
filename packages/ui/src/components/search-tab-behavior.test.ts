import { describe, it, expect } from "bun:test";
import {
	hasDirtyResults,
	isResultFileDirty,
	shouldUndoReplaceAllOperation
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
