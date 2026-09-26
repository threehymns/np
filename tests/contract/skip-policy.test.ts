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
 * `bun test` exits 0 when tests are skipped, so `it.skipIf(true, ...)` — or any
 * other spelling that drops a test from the run without a condition that could
 * ever lift — silently removes coverage forever. That is not hypothetical: a
 * hardcoded `it.skipIf(true, ...)` for the unstaged worktree rename sat in
 * `discard-operations.test.ts` from 2026-08-18, hiding a real data-loss bug in
 * both engines the whole time. This gate is what would have caught it.
 *
 * The rule is enforced on the source, not on test output, so it holds even when
 * the suite is run with a filter that skips whole files.
 *
 * Scope: the gate scans `tests/contract/**.ts`, which is the directory the
 * criterion in `docs/vcs-contract-gate.md` is about. `docs/vcs-contract-gate.md`
 * says so too. The pattern matchers below do not depend on that scope: they key
 * on the call's shape, not on which test registration functions a file imports,
 * so a skip written against a locally-aliased `it` is recognised the same way a
 * skip written against the `bun:test` import is.
 */

const CONTRACT_DIR = new URL('.', import.meta.url).pathname;

/**
 * The version-floor guard, and the only thing the allowlist covers.
 *
 * `docs/vcs-contract-gate.md` names one legitimate skip: "the explicit version-floor
 * guard (`skip guard self-check (impossible floor 99.0)`)". The version floor is
 * built by binding the guard as a value before any test is registered —
 *
 *     export const describe = defaultSkipReason ? bunDescribe.skipIf(true, defaultSkipReason) : bunDescribe;
 *     export const it = defaultSkipReason ? bunTest.skipIf(true, defaultSkipReason) : bunTest;
 *
 * — and registering tests through the binding. A test registered that way reads as
 * an ordinary `it('name', fn)`, so the skip is only visible as the `skipIf(true, …)`
 * at the binding, with no test name attached to it.
 *
 * So the one skip the doc permits is *invisible to the scan*, not exempt from it.
 * The distinction matters: an exemption is a hole someone can widen, and an
 * invisible site is a fact about how the guard is written. It is listed here
 * anyway, so that the fact is stated in a reviewable place instead of being
 * something a future reader has to rediscover from a comment, and so that a test
 * can pin it — see "the sanctioned version-floor skip is the only thing the
 * exemption covers".
 *
 * A test NAME is deliberately not listed. A skip that carries a name is a skip of a
 * specific test, which is exactly what a version floor does not do: it guards the
 * whole suite, so there is no one test whose skip a floor can explain. Any offender
 * that has a name is therefore a bug and is reported.
 */
const ALLOWED_SKIPS: string[] = [];

/**
 * `file:line` sites exempt from the skip rule: the version-floor guard bindings, in
 * `harness.ts` and the version-floor self-check in `harness.test.ts`. Filtered out
 * only when the scan attaches no test name to them — see ALLOWED_SKIPS.
 */
const SANCTIONED_SITES = new Set(['harness.ts:232', 'harness.ts:235', 'harness.test.ts:122']);

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

/**
 * Records the call that a pattern match opened on: its 1-based line and its first
 * string-literal argument, which is the test or suite name.
 */
interface SkipSite {
	/** 1-based line the call opens on. */
	line: number;
	/** The test name the call applies to. */
	name: string | null;
}

/**
 * The two shapes a test call can take:
 *
 *   it.skip('name', fn)                  — the name is the FIRST argument
 *   it.skipIf(cond, 'reason')('name', …) — the name is in the call that the result
 *                                         of `skipIf` is immediately invoked with
 *
 * Both are matched by the same walk, so one spelling cannot be added without the
 * other. `cond` is only inspected for the conditional shape; a plain `skip`/`todo`
 * has no condition to lift, so it is reported without one.
 */
interface SiteShape {
	/** The member being matched after the call target. */
	member: string;
	/** Whether the matched call takes a condition as its first argument. */
	conditional: boolean;
}

const SKIP_SHAPES: SiteShape[] = [
	{ member: 'skipIf', conditional: true },
	{ member: 'skip', conditional: false },
	{ member: 'todo', conditional: false }
];

/**
 * Same shape rule, for `.only`. A `.only` is not a skip — its test runs — but a
 * stray one silently disables every other test in the file, which is the same
 * silent loss of coverage this gate exists to prevent, under a different name.
 */
const ONLY_SHAPES: SiteShape[] = [{ member: 'only', conditional: false }];

/**
 * The two ways a suite is wrapped: `it.skip('name', …)` and, for the `each`
 * builders, `it.skip.each(rows)('name', …)`. The extra `.each` is optional and is
 * not part of the member token, so `it.skip(`, `it.skipIf(` and `it.skip.each(`
 * are all matched by the member `skip`.
 */
const CALL_OPENERS = '(?:\\.(?:skip|skipIf|todo|only|each)\\b)*\\s*\\(';

/** How far ahead of a matched call the gate reads looking for the `('name', …)` that names it. */
const MAX_NAME_SEARCH = 2000;

/**
 * Returns the source text of the arguments passed to a call whose `(` sits at
 * `open`, by matching parentheses. Comments are blanked to spaces beforehand, so
 * a paren inside a comment cannot unbalance the count.
 */
function argsAt(code: string, open: number): string {
	const end = afterCall(code, open);
	return end > open ? code.slice(open + 1, end) : code.slice(open + 1);
}

/**
 * Finds every test call in `source` whose target is a member in `shapes`, as
 * `{ line, name }` sites.
 *
 * A `skipIf` call is routinely wrapped across lines — `it.skipIf(` on one line and
 * `true,` on the next — so the condition cannot be read a line at a time. Arguments
 * are extracted with parenthesis matching and only then trimmed, which handles both
 * the wrapped and the single-line spelling. Comments are stripped first so the gate
 * does not match its own explanation of the rule.
 *
 * The call's target is not matched by name. `it`, `test` and `describe` are just
 * the identifiers this repo happens to use, and matching them is what makes a gate
 * trivially bypassable by aliasing the import — the one shape a careless developer
 * is most likely to reach for while debugging. What matters is the call's shape:
 * `X.skipIf(…)`, `X.skip(…)`, `X.todo(…)`, `X.only(…)`, optionally wrapped in
 * `.each(…)` for the table builders, optionally followed by the call that supplies
 * the test name. `.only.each(...)` is deliberately not accepted: Bun implements
 * `test.only` and does not implement `test.only.each`, so no suite can contain one.
 */
function findSites(source: string, shapes: SiteShape[]): SkipSite[] {
	const code = stripComments(source);
	const members = shapes.map(shape => shape.member).join('|');

	const sites: SkipSite[] = [];
	const opener = new RegExp(`\\b\\w+\\.(?:${members})${CALL_OPENERS}`, 'g');
	let match: RegExpExecArray | null;
	while ((match = opener.exec(code)) !== null) {
		// The match ends at the `(` the member was called with, which for a
		// conditional shape is the condition's own paren.
		const open = match.index + match[0].length - 1;
		const isConditional = /\.skipIf\b/.test(match[0]);

		// Only a literal `true` is unconditional; a predicate can lift itself when
		// the environment changes, which is the whole point of `skipIf`. A plain
		// `skip`/`todo`/`only` has no condition to inspect, so it always qualifies.
		if (isConditional && !isUnconditionalCondition(argsAt(code, open))) continue;

		// A plain `skip`/`todo`/`only` names its test in its own first argument. A
		// conditional one names it in the call that the result of `skipIf(...)` is
		// immediately invoked with, so the read has to start past the condition.
		const name = isConditional
			? invocationNameAt(code, match.index + match[0].length)
			: firstArgumentName(argsAt(code, open));
		const lineIndex = code.slice(0, match.index).split('\n').length - 1;
		sites.push({ line: lineIndex + 1, name });
	}
	return sites;
}

/** Every unconditional skip in a file: the spellings that drop a test with no condition. */
function findUnconditionalSkips(source: string): SkipSite[] {
	return findSites(source, SKIP_SHAPES);
}

/** Every stray `.only` in a file. See ONLY_SHAPES for why it is reported separately. */
function findFocusOnly(source: string): SkipSite[] {
	return findSites(source, ONLY_SHAPES);
}

/** Whether a conditional shape's first argument is a condition that can never lift. */
function isUnconditionalCondition(args: string): boolean {
	return /^\s*true\s*,/.test(args);
}

/**
 * Returns the index of the `)` that closes the call opened at `open`, or the end of
 * the text when the call is unbalanced.
 */
function afterCall(code: string, open: number): number {
	let depth = 0;
	for (let i = open; i < code.length; i++) {
		if (code[i] === '(') depth++;
		else if (code[i] === ')') {
			depth--;
			if (depth === 0) return i;
		}
	}
	return code.length;
}

/**
 * The test name a plain `skip`/`todo`/`only` gives itself, read from the first
 * argument of `args`. Stops at the end of that argument rather than reading on:
 * `it.skip.each(rows)('name', fn)` has a row array first, and a scan that keeps
 * going would report the offender under an arbitrary later literal.
 */
function firstArgumentName(args: string): string | null {
	// The lookahead is what stops the read at the end of the first argument; `$`
	// covers the single-argument call, where `args` ends with the name itself
	// because `argsAt` hands back only what is between the parentheses.
	const literal = /^\s*(['"`])((?:[^'"`\\]|\\.)*)\1\s*(?=[,);]|$)/.exec(args.slice(0, MAX_NAME_SEARCH));
	return literal ? literal[2] : null;
}

/**
 * The test name of the call that a conditional shape is immediately invoked with —
 * the `('name', …)` of `it.skipIf(cond, 'reason')('name', fn)`. Read from the first
 * literal a `(` introduces after the condition, which is the name: the reason has
 * already been passed and sits behind the read.
 */
function invocationNameAt(code: string, from: number): string | null {
	const window = code.slice(from, from + MAX_NAME_SEARCH);
	// Stop at the end of the statement. A naming invocation that is not in the same
	// statement as the condition is not this skip's name, and reading past it would
	// attribute an arbitrary later literal to the skip — which for a condition
	// reached through a variable means inventing a name it never had.
	const end = window.indexOf(';');
	const literal = /\(\s*(['"`])((?:[^'"`\\]|\\.)*)\1\s*(?=[,);]|$)/.exec(end === -1 ? window : window.slice(0, end));
	return literal ? literal[2] : null;
}

/**
 * Collects every unconditional skip in the contract suite that is not on the
 * allowlist, as `file:line  name` strings. Empty means the suite is clean.
 */
function collectOffenders(): string[] {
	return collect(findUnconditionalSkips);
}

/** Every stray `.only` in the contract suite, as `file:line  name` strings. */
function collectFocusOnly(): string[] {
	return collect(findFocusOnly);
}

/**
 * Runs one detector over every scanned file and formats what it reports. The
 * allowlist applies to skip sites only: a `.only` is not a skip and has no
 * legitimate form in this suite, so it is always reported.
 */
function collect(detect: (source: string) => SkipSite[]): string[] {
	const offenders: string[] = [];
	for (const file of walk(CONTRACT_DIR)) {
		// This file necessarily talks about the pattern it forbids, so it is not
		// evidence about anything.
		if (file.endsWith('skip-policy.test.ts')) continue;
		const rel = relative(CONTRACT_DIR, file);
		for (const site of detect(readFileSync(file, 'utf8'))) {
			const at = `${rel}:${site.line}`;
			if (detect === findUnconditionalSkips && !site.name && SANCTIONED_SITES.has(at)) continue;
			// The allowlist is matched against THIS skip's own test name, never
			// against the whole file. Scoping it to the file would let a single
			// legitimate skip whitelist every other skip in the same file, which
			// is exactly the hole the gate exists to close.
			if (!site.name || !ALLOWED_SKIPS.includes(site.name)) {
				offenders.push(`${at}  ${site.name ?? '(no test name)'}`);
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

	bunTest('detects a plain it.skip, which takes no predicate and cannot lift itself', () => {
		// `it.skip(name, fn)` is unconditional by construction: there is no condition
		// argument that an environment could ever satisfy. It removes the test from
		// the run exactly the way the historical `it.skipIf(true, ...)` did.
		const sites = findUnconditionalSkips(`it.skip('restores the source of an unstaged rename', () => {});`);
		expect(sites).toHaveLength(1);
		expect(sites[0].name).toBe('restores the source of an unstaged rename');
		expect(sites[0].line).toBe(1);
	});

	bunTest('detects a plain describe.skip, which removes a whole block', () => {
		const source = [
			`describe.skip('copy detection', () => {`,
			`	it('a real test', () => {});`,
			`});`,
		].join('\n');
		const sites = findUnconditionalSkips(source);
		expect(sites).toHaveLength(1);
		expect(sites[0].name).toBe('copy detection');
		expect(sites[0].line).toBe(1);
	});

	bunTest('detects a test.skip under the alias the contract suite itself uses', () => {
		// The suite registers as `test` under Bun's `bun:test` re-export in some files,
		// so the `test` spelling has to be detected on the same terms as `it`.
		const sites = findUnconditionalSkips(`test.skip('a thing', () => {});`);
		expect(sites).toHaveLength(1);
		expect(sites[0].name).toBe('a thing');
	});

	bunTest('detects an it.todo, which registers a test that asserts nothing', () => {
		const sites = findUnconditionalSkips(`it.todo('handle an unborn branch');`);
		expect(sites).toHaveLength(1);
		expect(sites[0].name).toBe('handle an unborn branch');
		expect(sites[0].line).toBe(1);
	});

	bunTest('detects a describe.todo, and not only the `it.todo` spelling', () => {
		const sites = findUnconditionalSkips(`describe.todo('rename detection');`);
		expect(sites).toHaveLength(1);
		expect(sites[0].name).toBe('rename detection');
	});

	bunTest('detects the table-driven spellings of skip and todo', () => {
		// `it.each`/`describe.each` are ordinary Bun test builders, so the table forms
		// remove coverage on exactly the same terms as the direct spellings. Gating the
		// direct ones alone would leave the same hole one suffix away.
		for (const source of [
			`it.skip.each([1, 2])('case %i', () => {});`,
			`it.todo.each([1, 2])('case %i');`,
		]) {
			const sites = findUnconditionalSkips(source);
			expect(sites).toHaveLength(1);
		}
	});

	bunTest('reports a stray .only separately from a skip, because it is not a skip', () => {
		// `.only` is not a skip: the test runs. It is worse in one specific way — a
		// stray one silently disables every other test in its file, so the suite
		// reports green having run almost nothing. Same class of silent coverage loss,
		// different failure mode, so it gets its own check and its own wording.
		const sites = findFocusOnly(`it.only('restores the source of an unstaged rename', () => {});`);
		expect(sites).toHaveLength(1);
		expect(sites[0].name).toBe('restores the source of an unstaged rename');
		expect(sites[0].line).toBe(1);
	});

	bunTest('reports a nested stray .only, which is how they usually survive review', () => {
		// The direct form is caught on sight. A `.only` buried two describes deep is
		// the one that reaches `master`, so the check has to reach the whole file.
		const source = [
			`describe('outer', () => {`,
			`	describe('inner', () => {`,
			`		it.only('a real test', () => {});`,
			`	});`,
			`});`,
		].join('\n');
		const sites = findFocusOnly(source);
		expect(sites).toHaveLength(1);
		expect(sites[0].name).toBe('a real test');
		expect(sites[0].line).toBe(3);
	});

	bunTest('a `.only` is not reported as a skip, and a skip is not reported as a `.only`', () => {
		// Keeping the two checks disjoint is what makes each message accurate. A
		// developer told to remove an "unconditional skip" who actually wrote a `.only`
		// would be sent to fix the wrong thing.
		const only = `it.only('a real test', () => {});`;
		const skip = `it.skip('a real test', () => {});`;
		expect(findUnconditionalSkips(only)).toEqual([]);
		expect(findFocusOnly(skip)).toEqual([]);
		expect(findUnconditionalSkips(skip)).toHaveLength(1);
		expect(findFocusOnly(only)).toHaveLength(1);
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

	bunTest('the version-floor skip is reached through a variable, so the gate cannot see it', () => {
		// The version floor binds the guard as a *value* before any skip is registered:
		//
		//     export const it = defaultSkipReason ? bunTest.skipIf(true, defaultSkipReason) : bunTest;
		//
		// There is no test call here at all — a bare member of `bun:test` is called
		// with a condition and its result is assigned. The result is then invoked
		// through that binding, e.g. `it('name', fn)`, which is not a skip spelling
		// and is indistinguishable from an ordinary test. So the one skip the doc
		// permits is invisible to this scan, not exempt from it, and no allowlist
		// entry would change that. It is reported here deliberately, and
		// `collectOffenders` filters it, so the exemption is stated in one reviewable
		// place instead of being a hole hidden inside the scanner.
		const guards = findUnconditionalSkips(readFileSync(join(CONTRACT_DIR, 'harness.ts'), 'utf8'));
		expect(guards.map(site => site.line)).toEqual([232, 235]);
		expect(guards.every(site => site.name === null)).toBe(true);

		const selfCheck = findUnconditionalSkips(readFileSync(join(CONTRACT_DIR, 'harness.test.ts'), 'utf8'));
		expect(selfCheck.map(site => site.line)).toEqual([122]);
	});

	bunTest('every other version-floor call is reached through a variable, and is not a skip', () => {
		// Guards against the version floor quietly becoming a hardcoded skip written
		// in the direct spelling, which IS the exact shape of the regression in
		// `discard-operations.test.ts`.
		const harness = readFileSync(join(CONTRACT_DIR, 'harness.ts'), 'utf8');
		expect(harness).toMatch(/defaultSkipReason \? bunTest\.skipIf\(true, defaultSkipReason\) : bunTest/);
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

	bunTest('no contract test declares a stray .only', () => {
		// Checked separately from the skip rule, and reported separately from it,
		// because a `.only` is not a skip: its test runs, while every other test in
		// the file silently does not. See ONLY_SHAPES.
		expect(collectFocusOnly()).toEqual([]);
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
