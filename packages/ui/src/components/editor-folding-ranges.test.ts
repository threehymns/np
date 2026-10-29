import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The folding-range request lives inside Editor.svelte's async effect, so
 * these source invariants lock the ordering seams; the fold service itself is
 * covered by editor/fold.test.ts.
 */
const EDITOR_SRC = path.join(import.meta.dir, "Editor.svelte");
const src = readFileSync(EDITOR_SRC, "utf-8");

function foldingEffectBody(): string {
	const start = src.indexOf("const generation = ++foldingRangesGeneration;");
	expect(start).toBeGreaterThan(-1);
	const end = src.indexOf("// Sync vim setting", start);
	expect(end).toBeGreaterThan(start);
	return src.slice(start, end);
}

describe("Editor document folding range requests", () => {
	it("discards responses from a superseded request", () => {
		expect(src).toContain("let foldingRangesGeneration = 0;");
		expect(foldingEffectBody()).toContain(
			"const generation = ++foldingRangesGeneration;"
		);
		// Both the success and error handlers check the captured generation.
		expect(
			foldingEffectBody().match(/generation !== foldingRangesGeneration/g)?.length
		).toBe(2);
	});

	it("clears cached ranges when the current view is not served", () => {
		const body = foldingEffectBody();
		expect(body).toContain("targetView !== view");
		expect(body).toContain('ans.state === "serving" ? ans.ranges : []');
	});
});
