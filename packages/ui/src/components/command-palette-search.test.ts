import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The palette matches a query against each entry's search text, which is the
 * entry's label plus its keywords. The rule itself lives in the core and is
 * covered by the core's search-text test; what is checked here is that the
 * palette matches against that text and not against the bare label, which is
 * what made the split commands unreachable by the word "pane".
 *
 * The unit suite has no DOM, so the palette cannot be mounted here; the
 * wiring is checked at the source instead.
 */
describe("command palette search wiring", () => {
	const source = readFileSync(join(__dirname, "CommandPalette.svelte"), "utf-8");

	it("matches registry commands against their search text", () => {
		expect(source).toMatch(/value=\{commandSearchText\(command\)\}/);
	});

	it("matches nested palette entries against their search text", () => {
		expect(source).toMatch(/value=\{commandSearchText\(item\)\}/);
	});
});
