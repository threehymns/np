import { describe, it, expect } from "bun:test";
import pathlib from "node:path";

const SRC = pathlib.join(import.meta.dir, "DiffViewer.svelte");
const src: string = await Bun.file(SRC).text();

// Regression test for manual-scroll autoscroll bug:
// with focus in a CodeMirror editor, wheel-scrolling past files used to
// snap to the top of each entering file and uncollapse it, because
// handleContainerScroll -> syncActiveFile -> activeDiffFile $effect
// (expand + block:start scroll) ran on every scroll tick, gated only on
// contains(activeElement) — which is exactly true when the cursor is in an
// editor. Correct seam note: the logic lives inside the Svelte component,
// so this source-invariant test locks the fix; full behavior is covered by
// the Playwright diff-viewer spec.
describe("DiffViewer manual-scroll autoscroll", () => {
	it("scroll-past syncs silently (never triggers reveal expand/scroll)", () => {
		expect(src).toContain("syncActiveFileSilent(fileChange.filepath)");
		expect(src).not.toContain("syncActiveFile(fileChange.filepath)");
	});

	it("cursor-focus and header-focus syncs are silent", () => {
		expect(src).toContain("syncActiveFileSilent(filepath)");
		expect(src).toContain("onfocusin={() => syncActiveFileSilent(fileChange.filepath)}");
	});

	it("reveal effect skips silent syncs", () => {
		expect(src).toContain("silentSyncFor === targetFile");
		// Silent path must ack without expanding or scrolling.
		const idx = src.indexOf("if (silentSyncFor === targetFile)");
		expect(idx).toBeGreaterThan(-1);
		const window = src.slice(idx, idx + 400);
		expect(window).not.toContain("collapsedFiles[targetFile] = false");
		expect(window).not.toContain("scrollIntoView");
	});

	it("collapse state is materialized once (silent active changes don't flip it)", () => {
		expect(src).toContain("collapseInitialized");
	});
});
