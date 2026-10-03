import { describe, it, expect } from "bun:test";
import pathlib from "node:path";

const SRC = pathlib.join(import.meta.dir, "DiffViewer.svelte");
const src: string = await Bun.file(SRC).text();

const BINDING = pathlib.join(import.meta.dir, "diff-split-binding.ts");
const binding: string = await Bun.file(BINDING).text();

// Structural coverage for refresh-safe edits plus staged and file-edge
// semantics (#272): the rules live in diff-split-binding.ts with thin wiring
// in the Svelte component, so these source invariants lock the seams;
// behavior is covered by diff-split-binding.test.ts (helpers),
// workspace-diff-tabless.test.ts (persistence, safety, switch), and the
// real-engine contract suite (Document content, file bytes, index bytes,
// status). Hunk Actions stay owned by #273: no splice or index-write seam
// may appear here.
describe("DiffViewer refresh-safe edits plus staged and file-edge semantics (#272)", () => {
	it("keeps driving the b-pane from Document content so refreshes cannot clobber typing", () => {
		expect(src).toContain("resolveSplitRightContent(splitDoc, diff.modifiedContent)");
	});

	it("re-derives navigation hunks around live Document content", () => {
		expect(src).toContain("computeLiveHunks(diff.originalContent, effectiveModified)");
		expect(src).toContain("const bound = findSplitDoc(change.filepath)");
		expect(src).toContain("const effectiveModified = bound ? bound.content : diff.modifiedContent");
	});

	it("renders deleted files as the Original pane only", () => {
		expect(src).toContain("isOriginalOnly(fileChange.status)");
		expect(src).toContain("registerAs: 'split'");
		// The MergeView (working-copy surface) lives in the else branch, so
		// deleted files never mount it.
		const gate = src.indexOf("isOriginalOnly(fileChange.status)");
		const merge = src.indexOf("use:setupMergeView");
		expect(gate).toBeGreaterThanOrEqual(0);
		expect(merge).toBeGreaterThan(gate);
	});

	it("still binds no Document for deleted files", () => {
		expect(binding).toContain('if (change.status === "D") return undefined;');
	});

	it("keeps save routing and dirty indication on the shared Document", () => {
		expect(src).toContain("appState.activeDiffDocument = target ? findSplitDoc(target) : undefined;");
		expect(src).toContain("isDiffHeaderDirty(headerDoc)");
	});

	it("leaves hunk-action splices to #273 (no index writes from typing)", () => {
		expect(binding).not.toContain("updateIndexContent");
		expect(binding).not.toContain("updateFileContent");
		expect(src).toContain("onDocChange: (text) => handleSplitDocChange(fileChange.filepath, text)");
		expect(src).toContain("appState.workspace.updateDocumentContent(doc, text)");
	});
});
