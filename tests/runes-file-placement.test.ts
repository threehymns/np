import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

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
export const RUNE_RE = /(?:\$|\\u0024|\\u\{24\})(state|derived|effect|props|bindable|inspect|host)([^a-zA-Z0-9_]|$)/;
// Exact rune names for the AST check. RUNE_RE above stays as the loose
// fast path that decides whether a file is worth parsing at all.
// It also matches \u0024 / \u{24} escapes so an escaped "$" can't slip past.
const RUNE_NAMES = new Set([
	"$state", "$derived", "$effect", "$props", "$bindable", "$inspect", "$host",
]);
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

export interface RuneHit {
	line: number;
	name: string;
	snippet: string;
}

/**
 * Scans a source string for Svelte 5 runes appearing as real code identifiers,
 * ignoring rune names that appear strictly within comments, string literals,
 * template literal text, or regular expression literals.
 */
export function scanSourceForRunes(code: string, fileName = "source.ts"): RuneHit[] {
	if (!RUNE_RE.test(code)) return [];

	const kind = fileName.endsWith(".tsx")
		? ts.ScriptKind.TSX
		: fileName.endsWith(".jsx")
			? ts.ScriptKind.JSX
			: fileName.endsWith(".js") || fileName.endsWith(".mjs") || fileName.endsWith(".cjs")
				? ts.ScriptKind.JS
				: ts.ScriptKind.TS;

	const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, kind);
	const hits: RuneHit[] = [];
	const lines = code.split("\n");

	function visit(node: ts.Node) {
		if (ts.isIdentifier(node) && RUNE_NAMES.has(node.text)) {
			const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
			const lineText = lines[line]?.trim() ?? "";
			hits.push({
				line: line + 1,
				name: node.text,
				snippet: lineText.slice(0, 120),
			});
		}
		ts.forEachChild(node, visit);
	}

	visit(sf);
	return hits;
}

function formatHits(hits: RuneHit[]): string[] {
	const lineMap = new Map<number, string>();
	for (const hit of hits) {
		if (!lineMap.has(hit.line)) {
			lineMap.set(hit.line, `    L${hit.line}: ${hit.snippet}`);
		}
	}
	return Array.from(lineMap.values());
}

describe("Svelte runes only appear in compiler-processed files", () => {
	it("finds no rune usage in plain .ts/.js modules under packages/ and apps/", () => {
		const files = ROOTS.flatMap((root) => collect(root));
		// Guard against the scan silently covering nothing (e.g. moved roots).
		expect(files.length).toBeGreaterThan(50);

		const violations: string[] = [];
		for (const file of files) {
			const content = readFileSync(file, "utf-8");
			const hits = scanSourceForRunes(content, file);
			if (hits.length > 0) {
				violations.push(`${file}\n${formatHits(hits).join("\n")}`);
			}
		}

		expect(violations).toEqual([]);
	});

	describe("gate scan rules", () => {
		it("tolerates runes inside string literals, comments, and regular expressions", () => {
			const source = [
				"// Single-line comment mentioning $state(0) and $props()",
				"/* Multi-line comment",
				"   mentioning $derived(value) and $effect(() => {}) */",
				"/**",
				" * JSDoc comment: @see $bindable and $inspect",
				" */",
				'const singleQuoted = \'let { data } = $props();\';',
				'const doubleQuoted = "const count = $state(0);";',
				"const rawTemplate = `let { data } = $props();`;",
				"const templateWithSub = `prefix $derived ${1 + 1} suffix $inspect`;",
				'const nestedInTemplate = `${"$state in string literal"}`;',
				"const commentInTemplate = `${",
				"  // $props in template expression comment",
				"  42",
				"}`;",
				"const regexLiteral = /\\$state|\\$derived|\\$effect|\\$props|\\$bindable|\\$inspect|\\$host/;",
				"const regexConstructor = new RegExp(\"\\\\$state\");",
			].join("\n");

			expect(scanSourceForRunes(source)).toEqual([]);
		});

		it("rejects real runes across language constructs and file positions", () => {
			const rejectedCases: { code: string; rune: string }[] = [
				{ code: "let count = $state(0);", rune: "$state" },
				{ code: "const raw = $state.raw(0);", rune: "$state" },
				{ code: "const snap = $state.snapshot(x);", rune: "$state" },
				{ code: "const doubled = $derived(count * 2);", rune: "$derived" },
				{ code: "const by = $derived.by(() => count * 2);", rune: "$derived" },
				{ code: "$effect(() => { console.log(count); });", rune: "$effect" },
				{ code: "$effect.pre(() => {});", rune: "$effect" },
				{ code: "$effect.root(() => () => {});", rune: "$effect" },
				{ code: "let { data } = $props();", rune: "$props" },
				{ code: "let { value = $bindable() } = $props();", rune: "$bindable" },
				{ code: "$inspect(count);", rune: "$inspect" },
				{ code: "$inspect.trace();", rune: "$inspect" },
				{ code: "const host = $host();", rune: "$host" },
				{ code: "function init() { return $state(0); }", rune: "$state" },
				{ code: "const getVal = () => $derived(1);", rune: "$derived" },
				{ code: "class StateHolder { count = $state(0); }", rune: "$state" },
				{ code: "class Watcher { start() { $effect(() => {}); } }", rune: "$effect" },
				{ code: "export const globalCount = $state(0);", rune: "$state" },
				{ code: "export default $state(0);", rune: "$state" },
				{ code: "const msg = `count: ${$state(0)}`;", rune: "$state" },
				{ code: "const a = \"$state in string\"; const b = $state(0);", rune: "$state" },
				{ code: "const x = $state(0); // $state in comment", rune: "$state" },
				{ code: "let count = \\u0024state(0);", rune: "$state" },
				{ code: "let count = \\u{24}state(0);", rune: "$state" },
			];

			for (const { code, rune } of rejectedCases) {
				const hits = scanSourceForRunes(code);
				expect(hits.length).toBeGreaterThan(0);
				expect(hits.some((h) => h.name === rune)).toBe(true);
			}
		});

		it("tolerates a snippet pack body containing $props()", () => {
			const snippetModuleSource = [
				"export const SVELTE_SNIPPETS = [",
				"  {",
				"    id: 'svelte-props',",
				"    language: 'svelte',",
				"    trigger: 'props',",
				"    body: 'let { data } = $props();',",
				"    description: 'Component props ($props)'",
				"  }",
				"];",
			].join("\n");

			expect(scanSourceForRunes(snippetModuleSource)).toEqual([]);
		});

		it("tolerates identifiers that merely contain a rune name", () => {
			expect(scanSourceForRunes("const my$state = 1;")).toEqual([]);
			expect(scanSourceForRunes("const data$derived = 2;")).toEqual([]);
		});
	});
});
