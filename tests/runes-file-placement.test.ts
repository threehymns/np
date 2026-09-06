import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Svelte 5 runes ($state, $derived, $effect, ...) are compiled only in
 * `.svelte`, `.svelte.ts` and `.svelte.js` files. A rune in a plain
 * `.ts`/`.js` module throws `rune_outside_svelte` at runtime in the browser,
 * while unit tests keep passing because tests/contract/rune-setup.ts stubs
 * the runes globally. That exact gap broke the sidebar Explorer / Source
 * Control buttons on feat/git-init-button: `$state` in git-actions.ts
 * crashed GitPanel's lazy import, leaving MainLayout stuck rendering the
 * stale panel. Neither svelte-check nor the unit suite catches it, so this
 * scan locks the seam directly. If it goes red, rename the offending module
 * to `.svelte.ts` (see GitInitController in git-actions.svelte.ts).
 */

const ROOTS = [join(import.meta.dir, "..", "packages"), join(import.meta.dir, "..", "apps")];
const RUNE_RE = /\$(state|derived|effect|props|bindable|inspect|host)([^a-zA-Z0-9_]|$)/;
// Build output, generated clients and vendored code never ship as source.
const SKIP_DIRS = new Set(["node_modules", ".svelte-kit", "dist", "build", "coverage"]);
// Test doubles run under bun with stubbed runes and are never bundled.
const SKIP_TEST_FILES = /\.(test|spec)\.[a-z]+$/;
// Files the Svelte compiler processes: runes are legal here.
const COMPILED_FILE = /\.svelte(\.[a-z]+)?$/;
const SOURCE_FILE = /\.[mc]?[jt]sx?$/;

function collect(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (!SKIP_DIRS.has(entry)) collect(full, out);
		} else if (SOURCE_FILE.test(entry) && !COMPILED_FILE.test(entry) && !SKIP_TEST_FILES.test(entry)) {
			out.push(full);
		}
	}
	return out;
}

describe("Svelte runes only appear in compiler-processed files", () => {
	it("finds no rune usage in plain .ts/.js modules under packages/ and apps/", () => {
		const files = ROOTS.flatMap((root) => collect(root));
		// Guard against the scan silently covering nothing (e.g. moved roots).
		expect(files.length).toBeGreaterThan(50);

		const violations: string[] = [];
		for (const file of files) {
			const hits = readFileSync(file, "utf-8")
				.split("\n")
				.map((line, i) => ({ line: line.trim(), i: i + 1 }))
				.filter(({ line }) => RUNE_RE.test(line))
				.map(({ line, i }) => `    L${i}: ${line.slice(0, 120)}`);
			if (hits.length > 0) violations.push(`${file}\n${hits.join("\n")}`);
		}

		expect(violations).toEqual([]);
	});
});
