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
		// Per-file memoized: only the edited file recomputes, the rest reuse
		// cached chunks (typing lag must not scale with expanded-file count).
		expect(src).toContain("liveHunkMemo.getOrCompute(change.filepath, diff.originalContent, effectiveModified)");
		expect(src).toContain("const bound = findDiffDoc(change.filepath)");
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
		expect(src).toContain("appState.activeDiffDocument = target ? findDiffDoc(target) : undefined;");
		expect(src).toContain("isDiffHeaderDirty(headerDoc)");
	});

	it("leaves hunk-action splices to #273 (no index writes from typing)", () => {
		expect(binding).not.toContain("updateIndexContent");
		expect(binding).not.toContain("updateFileContent");
		expect(src).toContain("onDocChange: (text) => handleDiffDocChange(fileChange.filepath, text)");
		expect(src).toContain("appState.workspace.updateDocumentContent(doc, text)");
	});

	it("keeps the diff panes mounted across a repository refresh", () => {
		// A refresh replaces the repository's change list, which used to
		// clear the whole snapshot cache. The rendered snapshot then
		// vanished, the pane's `{#if diff}` branch flipped to false, and
		// the CodeMirror instances were destroyed and remounted (every
		// save triggers a refresh). The rendered snapshot now survives the
		// invalidation, so the fresh one swaps in place.
		expect(src).toContain("loadedDiffs[key] ?? renderDiffs[fileChange.filepath]");
		const invalidation = src.slice(
			src.indexOf("if (currentChanges !== lastChangesRef)"),
			src.indexOf("const files = activeChanges;")
		);
		expect(invalidation).toContain("loadedDiffs = {}");
		expect(invalidation).not.toContain("renderDiffs = {}");
	});

	it("keeps the diff panes mounted when a file's diff scope changes", () => {
		// A save can flip a file's diff scope: a staged file that also has
		// working-tree changes is reported as one combined change, so the
		// scope - and with it the `diffCacheKey` - changes under the file.
		// A scope-keyed fallback would miss on the new key, the pane's
		// diff would go missing for a moment, and the pane would be torn
		// down and rebuilt: the cursor jumps to the top of the file and
		// the focus is lost. The retained snapshot is therefore keyed by
		// filepath, and the multibuffer section identity is the filepath
		// too (re-keying the section rebuilds its CodeMirror instances).
		expect(src).toContain("renderDiffs[fileChange.filepath]");
		const renderResolver = src.slice(
			src.indexOf("function resolveFileDiff"),
			src.indexOf("function resolveFreshFileDiff")
		);
		expect(renderResolver).not.toContain("renderDiffs[key]");
		expect(src).toContain("key: c.filepath }");
		expect(src).not.toContain("c.filepath + '-' + c.staged");
	});

	it("binds Documents from the fresh snapshot only", () => {
		// The stale-snapshot revert stays fixed: the binding path must not
		// read the retained (pre-refresh) snapshot, or syncCleanSnapshot
		// would revert a just-saved Document to its pre-save content.
		expect(src).toContain("const detail = resolveFreshFileDiff(file);");
		const freshResolver = src.slice(
			src.indexOf("function resolveFreshFileDiff"),
			src.indexOf("/** Snapshot carried by the change itself")
		);
		expect(freshResolver).not.toContain("renderDiffs");
	});
});
