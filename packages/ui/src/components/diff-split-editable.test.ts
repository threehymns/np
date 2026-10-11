import { describe, it, expect } from "bun:test";
import pathlib from "node:path";

const SRC = pathlib.join(import.meta.dir, "DiffViewer.svelte");
const src: string = await Bun.file(SRC).text();

// Structural coverage for the split Working-copy pane binding (#269):
// the logic lives inside the Svelte component, so these source invariants
// lock the wiring seams; behavior is covered by diff-split-binding.test.ts
// (helpers), state-diff-save.test.ts (save routing), and the Playwright
// diff-viewer spec.
describe("DiffViewer split Working-copy pane binding", () => {
	it("keeps the Original (a) pane read-only in split mode", () => {
		// Exactly one unconditional readOnly remains: the a-pane. The
		// b-pane moved to a compartment driven by the editable flag, and
		// inline mode passes readOnly through its own option.
		const bare = src.match(/EditorState\.readOnly\.of\(true\)/g) ?? [];
		expect(bare.length).toBe(1);
		expect(src).toContain("readOnlyCompartmentB.of(EditorState.readOnly.of(!currentOptions.editable))");
	});

	it("wires the b-pane change seam to the shared Document", () => {
		expect(src).toContain("onDocChange: (text) => handleDiffDocChange(fileChange.filepath, text)");
		expect(src).toContain("appState.workspace.updateDocumentContent(doc, text)");
	});

	it("drives the b-pane from Document content instead of the git snapshot", () => {
		expect(src).toContain("resolveSplitRightContent(splitDoc, diff.modifiedContent)");
	});

	it("tags external Document syncs so they never echo back or pollute undo", () => {
		expect(src).toContain("tr.annotation(splitSyncAnnotation)");
		expect(src).toContain("Transaction.addToHistory.of(false)");
	});

	it("shows a dirty indicator in the diff file header from Document state", () => {
		expect(src).toContain("isDiffHeaderDirty(headerDoc)");
		expect(src).toContain('aria-label="Unsaved changes"');
	});

	it("no longer pins inline mode read-only (ticket #270 made it editable)", () => {
		expect(src).not.toContain("readOnly: true,");
		expect(src).not.toContain("EditorState.readOnly.of(currentOptions.readOnly)");
	});

	it("binds staged-only files too (typing creates an unstaged modification, #268 story 11)", () => {
		// Regression lock: the binding effect once skipped staged-only
		// entries, leaving their Working-copy panes permanently read-only
		// with no bound Document to type into.
		expect(src).not.toContain("if (file.staged && !file.combined) continue;");
	});
});
