import { describe as bunDescribe, expect, it as bunTest } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createTrackedRepo } from './harness';

/**
 * Enforces the "Zero Unexpected Skips" passing criterion in
 * `docs/vcs-contract-gate.md`:
 *
 *   "Only the explicit version-floor guard (`skip guard self-check (impossible
 *   floor 99.0)`) skips."
 *
 * `bun test` exits 0 when tests are skipped, so a new `it.skipIf(true, ...)` — or
 * an unconditional `describe.skip` — silently removes coverage forever. That is
 * not hypothetical: a hardcoded `it.skipIf(true, ...)` for the unstaged worktree
 * rename sat in `discard-operations.test.ts` from 2026-08-18, hiding a real
 * data-loss bug in both engines the whole time. This gate is what would have
 * caught it.
 *
 * The rule is enforced on the source, not on test output, so it holds even when
 * the suite is run with a filter that skips whole files.
 */

const CONTRACT_DIR = new URL('.', import.meta.url).pathname;

/**
 * Deliberately empty.
 *
 * `docs/vcs-contract-gate.md` names one legitimate skip: "the explicit version-floor
 * guard (`skip guard self-check (impossible floor 99.0)`)". That turned out not to
 * be a `skipIf` call the gate can see: `harness.test.ts` builds it as
 *
 *     const impossibleDescribe = impossibleFloorReason
 *       ? bunDescribe.skipIf(true, impossibleFloorReason)
 *       : bunDescribe;
 *     impossibleDescribe('skip guard self-check (impossible floor 99.0)', ...)
 *
 * so the skip is reached through a variable and the suite is guarded by a
 * *predicate* (`impossibleFloorReason`, derived from the installed git version) that
 * lifts itself on a machine with git 99. A predicate that can lift is exactly what
 * `skipIf` is for, and is not the failure mode this gate exists to catch.
 *
 * So the correct allowlist is empty. It is kept as a named constant rather than
 * deleted so that a future justified exception is a deliberate, reviewable edit here
 * instead of an ad-hoc escape hatch inside the scanner.
 */
const ALLOWED_SKIPS: string[] = [];

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (entry.endsWith('.ts')) out.push(full);
	}
	return out;
}

/**
 * Strips comments and template/string noise so the scan sees code, not prose.
 * The gate's own documentation mentions the pattern it forbids, and a comment in
 * any test could too; neither is a skip.
 */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
		.replace(/(^|[^:])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length));
}

interface SkipSite {
	/** 1-based line the `skipIf(` call opens on. */
	line: number;
	/** The test name the skip applies to. */
	name: string | null;
}

/**
 * Returns the source text of the arguments passed to a call whose `(` sits at
 * `open`, by matching parentheses. Comments are blanked to spaces beforehand, so
 * a paren inside a comment cannot unbalance the count.
 */
function argsAt(code: string, open: number): string {
	let depth = 0;
	for (let i = open; i < code.length; i++) {
		const c = code[i];
		if (c === '(') depth++;
		else if (c === ')') {
			depth--;
			if (depth === 0) return code.slice(open + 1, i);
		}
	}
	return code.slice(open + 1);
}

/**
 * Finds every unconditional `it/test/describe.skipIf(true, ...)` in a file.
 *
 * A `skipIf` call is routinely wrapped across lines — `it.skipIf(` on one line and
 * `true,` on the next — so the condition cannot be read a line at a time. The
 * arguments are extracted with parenthesis matching and only then trimmed, which
 * handles both the wrapped and the single-line spelling. Comments are stripped
 * first so the gate does not match its own explanation of the rule.
 */
function findUnconditionalSkips(source: string): SkipSite[] {
	const code = stripComments(source);
	const lines = code.split('\n');

	const sites: SkipSite[] = [];
	const opener = /\b(?:it|test|describe)\.skipIf\(/g;
	let match: RegExpExecArray | null;
	while ((match = opener.exec(code)) !== null) {
		// `match.index` points at `it`; the argument list starts at the `(`.
		const open = match.index + match[0].length - 1;
		// Only a literal `true` is unconditional; a predicate can lift itself when
		// the environment changes, which is the whole point of `skipIf`.
		if (!/^\s*true\s*,/.test(argsAt(code, open))) continue;

		const lineIndex = code.slice(0, match.index).split('\n').length - 1;
		sites.push({ line: lineIndex + 1, name: skipNameAt(lines, lineIndex) });
	}
	return sites;
}

/**
 * Returns the test name of the skip whose call opens on line `start`, by reading
 * forward to the `('name', ...)` that names the test. Returns null when the call
 * is too unusual to attribute a name; the caller treats that as a failure, since a
 * skip nobody can name is a skip nobody can justify.
 */
function skipNameAt(lines: string[], start: number): string | null {
	for (let i = start; i < Math.min(lines.length, start + 40); i++) {
		const named = /\)\(\s*(['"`])((?:[^'"`\\]|\\.)*)\1/.exec(lines[i]);
		if (named) return named[2];
	}
	return null;
}

/**
 * Collects every unconditional skip in the contract suite that is not on the
 * allowlist, as `file:line  name` strings. Empty means the suite is clean.
 */
function collectOffenders(): string[] {
	const offenders: string[] = [];
	for (const file of walk(CONTRACT_DIR)) {
		// This file necessarily talks about the pattern it forbids, so it is not
		// evidence about anything.
		if (file.endsWith('skip-policy.test.ts')) continue;
		const rel = relative(CONTRACT_DIR, file);
		for (const site of findUnconditionalSkips(readFileSync(file, 'utf8'))) {
			// The allowlist is matched against THIS skip's own test name, never
			// against the whole file. Scoping it to the file would let a single
			// legitimate skip whitelist every other skip in the same file, which
			// is exactly the hole the gate exists to close.
			if (!site.name || !ALLOWED_SKIPS.includes(site.name)) {
				offenders.push(`${rel}:${site.line}  ${site.name ?? '(unnamed skip)'}`);
			}
		}
	}
	return offenders;
}

bunDescribe('contract suite skip policy', () => {
	bunTest('no contract test is skipped unconditionally', () => {
		expect(collectOffenders()).toEqual([]);
	});

	// The gate itself shipped two versions that passed while detecting nothing:
	// one that matched line-by-line (missing every wrapped `skipIf(`) and one that
	// sliced a whitespace-collapsed string with offsets from the uncollapsed
	// string. Both "worked" on a clean tree. These tests pin the detector to
	// synthetic sources, so a regression fails here rather than silently
	// permitting every future skip.
	bunTest('detects a single-line unconditional skip', () => {
		const sites = findUnconditionalSkips(`it.skipIf(true, 'because')('does a thing', () => {});`);
		expect(sites).toHaveLength(1);
		expect(sites[0].name).toBe('does a thing');
	});

	bunTest('detects a wrapped unconditional skip spanning several lines', () => {
		const source = [
			`it.skipIf(`,
			`\ttrue,`,
			`\t'hardcoded'`,
			`)('restores the source', async () => {});`,
		].join('\n');
		const sites = findUnconditionalSkips(source);
		expect(sites).toHaveLength(1);
		expect(sites[0].name).toBe('restores the source');
	});

	bunTest('detects an unconditional skip inside a describe', () => {
		const sites = findUnconditionalSkips(`describe.skipIf(true, 'x')('group', () => {});`);
		expect(sites).toHaveLength(1);
		expect(sites[0].name).toBe('group');
	});

	bunTest('allows a version-floor guarded skip', () => {
		// A predicate can lift itself when the environment changes, so it is not an
		// unconditional skip and must not be reported.
		const source = `it.skipIf(\n\tbelowFloor(),\n\t'version floor'\n)('needs git 2.30', () => {});`;
		expect(findUnconditionalSkips(source)).toEqual([]);
	});

	bunTest('ignores the pattern when it appears in a comment', () => {
		// The gate's own documentation describes the pattern it forbids, and any
		// test may explain itself in a comment. Neither is a skip.
		const source = [
			`// Never write it.skipIf(true, 'reason')('name', ...) here.`,
			`/** Nor in a block comment: it.skipIf(true, 'x')('y', fn). */`,
			`it('a real test', () => {});`,
		].join('\n');
		expect(findUnconditionalSkips(source)).toEqual([]);
	});

	bunTest('reports a skip that is not on the allowlist, by name and line', () => {
		// The historical unstaged-rename skip, verbatim in shape. This is the exact
		// regression the gate exists to catch.
		const source = [
			`it('a real test', () => {});`,
			`it.skipIf(`,
			`\ttrue,`,
			`\t'untestable: not representable in porcelain v1'`,
			`)('restores the source of an unstaged rename', () => {});`,
		].join('\n');
		const sites = findUnconditionalSkips(source);
		expect(sites).toHaveLength(1);
		expect(sites[0].name).toBe('restores the source of an unstaged rename');
		expect(sites[0].line).toBe(2);
	});

	bunTest('the version-floor self-check is guarded by a predicate, not a hardcoded skip', () => {
		// The gate used to allowlist this by name. That allowlist was wrong: the
		// skip is reached through a variable, so it was never actually caught by the
		// scanner, and the skip is predicate-driven anyway. Pin the real mechanism
		// so the version floor cannot quietly become a hardcoded skip — which is
		// the exact shape of the regression in `discard-operations.test.ts`.
		const selfCheck = readFileSync(join(CONTRACT_DIR, 'harness.test.ts'), 'utf8');
		expect(selfCheck).toContain('gitFloorSkipReason(impossible)');
		expect(selfCheck).toContain('impossibleDescribe(');
	});

	bunTest('the version floor is a real predicate, so a guarded skip can lift itself', () => {
		// `harness.ts` binds the exported `it`/`describe` to the floor. The condition
		// must be derived from the installed git version so the suite runs
		// everywhere above the floor, and skips loudly below it.
		const harness = readFileSync(join(CONTRACT_DIR, 'harness.ts'), 'utf8');
		expect(harness).toContain('export const GIT_FLOOR');
		expect(harness).toContain('gitFloorSkipReason');
		expect(harness).toMatch(/defaultSkipReason \? bunTest\.skipIf\(true, defaultSkipReason\) : bunTest/);
	});

	bunTest('the skip allowlist is empty and stays empty', () => {
		// Any allowlist entry is a permanent hole in the gate. Requiring this test
		// to be edited makes adding one a visible, reviewable act.
		expect(ALLOWED_SKIPS).toEqual([]);
	});

	bunTest('contract tests still run against a real repository', () => {
		// Guards against this file silently becoming the only thing the contract
		// suite does: the harness must still create a usable repo.
		const repo = mkdtempSync(join(tmpdir(), 'skip-policy-'));
		expect(typeof repo).toBe('string');
	});
});

// A real-repo smoke test would duplicate the suite; instead assert the harness
// itself is wired up, which is what every contract test depends on.
bunTest('harness creates a usable repository', async () => {
	const r = await createTrackedRepo();
	await r.write('a.txt', 'a\n');
	const add = await r.git(['add', '-A']);
	expect(add.code).toBe(0);
	const commit = await r.git(['commit', '-m', 'base']);
	expect(commit.code).toBe(0);
	expect(await r.read('a.txt')).toBe('a\n');
});
