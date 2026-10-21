import { describe, it, expect } from "bun:test";
import { shouldUndoReplaceAllOperation } from "./search-tab-behavior";

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
