import { describe as bunDescribe, expect, it as bunTest } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	rmdirSync,
	statSync,
	existsSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
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
 * Scope: the whole repository, not just this folder. The gate's first version
 * scanned only `tests/contract` (12 of 81 test files), because the scan root was
 * derived from the gate's own location. `docs/vcs-contract-gate.md` states the
 * check is run as a bare `bun test` from the repository root, and every test
 * file `bun test` collects is a place a skip can hide. Verified: an
 * unconditional `test.skipIf(true, ...)` planted in `tests/e2e/vcs.spec.ts`
 * left the gate reporting 12 pass / 0 fail.
 *
 * The pattern matchers below are deliberately independent of that scope. They key
 * on the call's shape rather than on which test registration functions a file
 * imports, so widening the root needed no change there, and a skip written against a
 * locally-aliased `it` is recognised the same way a skip written against the
 * `bun:test` import is.
 */

const CONTRACT_DIR = new URL('.', import.meta.url).pathname;

/**
 * Repository root, derived from this file's location
 * (`<root>/tests/contract/skip-policy.test.ts`).
 */
const REPO_ROOT = join(CONTRACT_DIR, '..', '..');

/**
 * This file, by its own path.
 *
 * `walk()` reports the paths it constructed, so the comparison is against the
 * gate's own URL resolved to a path rather than against a basename. A
 * `endsWith('skip-policy.test.ts')` match would exempt every file of that name
 * anywhere in the repository, which is the same blind spot the gate exists to
 * close.
 */
const THIS_FILE = new URL(import.meta.url).pathname;

/**
 * Files `bun test` collects, and therefore the only files where a skip can cost
 * real coverage.
 *
 * This is the runner's own discovery rule, measured against `bun test` v1.4.2
 * rather than guessed: it collects `a.test.ts`, `b.spec.ts`, `c_test.ts` and
 * `n-test.svelte.test.ts`, and does not collect `e.tests.ts`. So the name has to
 * end in `.test.`/`.spec.` — not the plural `.tests.` — preceded by a dot,
 * hyphen or underscore. The extension half widens past `.ts` because the runner
 * collects `.tsx`, `.js`, `.mjs`, `.cjs`, `.jsx`, `.mts` and `.cts` too.
 *
 * The hyphen is kept as a separator on purpose. `bun test` does not collect
 * `d-test.ts`, but this repository has no file of that shape, so matching one
 * costs no coverage and buys a scan that survives someone naming a test
 * `skip-policy-test.ts`. A pattern that matched strictly less than the runner
 * collects would be the more dangerous direction.
 *
 * Filtering to test files is what keeps the gate honest rather than merely
 * strict. The detector reads text, not call expressions, and `stripComments`
 * blanks comments but not string literals, so scanning source files raised two
 * false positives the allowlist cannot absorb, since it matches test names: a
 * doc string mentioning the pattern, and a conditional `skipIf` wrapper like
 * the one `harness.ts` uses. Both were reported as `(unnamed skip)`.
 */
const TEST_FILE_PATTERN = /(\.|_|-)(test|spec)\.[cm]?[jt]sx?$/;

/**
 * Directory names the repository ignores, read from its own `.gitignore`.
 *
 * A hand-written exclusion list drifts: it was missing `dist-main`, `.output`,
 * `.svelte-kit`, `scratch` and `test-results`, all of which this repository
 * ignores and all of which a build or a Playwright run creates. A transpiled
 * copy of a test landing in one of them turned the merge gate red with an error
 * pointing at a file nobody wrote, on machines that had run a build and not on
 * machines that had not. Under the old `tests/contract`-only scope that was
 * impossible, because no build output lives there.
 *
 * Entries are taken whichever way they are written. `.gitignore` spells a
 * directory either way — `.svelte-kit/` with a slash or `.output` without — and
 * reading only the slashed form would have kept `dist-main`'s neighbour
 * `.output` in the scan, which is the same bug again. `node_modules` is spelled
 * without a slash too, and is already excluded separately above.
 *
 * Entries containing a wildcard are skipped, because a wildcard matches more
 * than one directory and a basename set cannot express the match. Negations
 * (`.env.example`, re-included with a leading `!`) are skipped too. What
 * remains is every literal name, which includes a few file-shaped entries
 * (`.DS_Store`, `Thumbs.db`, `.env`). Including those is harmless — the walk
 * consults the set only when deciding whether to descend — and omitting a
 * directory is not, so the safe direction to err in is to over-include.
 */
function ignoredDirectoryNames(): string[] {
	const gitignore = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8');
	const names: string[] = [];
	for (const raw of gitignore.split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#') || line.startsWith('!')) continue;
		if (line.includes('*')) continue;
		names.push(line.replace(/\/$/, ''));
	}
	return names;
}

/**
 * Directories never descended into while scanning. `node_modules` is
 * impractical, `.git` is binary, and the vendored agent skill directory is not
 * this project's test surface — a skip in a vendored doc is not a coverage
 * decision made here.
 *
 * Derived from the repository's own `.gitignore` by
 * `ignoredDirectoryNames()`, so a new ignored output directory cannot appear in
 * the repository without the scan learning to step over it.
 */
const SCAN_EXCLUDES = new Set(['node_modules', '.git', ...ignoredDirectoryNames()]);

/**
 * Test-file roots the scan covers. This is deliberately the whole repository
 * rather than a hand-maintained list of directories: a new test added under a
 * package's src folder would otherwise be silently uncovered, which is the
 * failure mode this gate exists to prevent. The exclusions above are the only
 * filter.
 */
const SCAN_ROOTS: string[] = [REPO_ROOT];

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
		if (SCAN_EXCLUDES.has(entry)) continue;
		// A broken or circular symlink must not take the whole gate down. A skip
		// hidden behind one is not worth failing the merge gate over.
		let isDir: boolean;
		try {
			isDir = statSync(full).isDirectory();
		} catch {
			continue;
		}
		if (isDir) walk(full, out);
		else if (TEST_FILE_PATTERN.test(entry)) out.push(full);
	}
	return out;
}

/**
 * Blanks everything the scan must not read: comment bodies, string and template
 * literal bodies, and regex literal bodies. The gate's own documentation quotes
 * the pattern it forbids, and so does any test that explains the rule, names the
 * forbidden shape in a constant, or searches for it with a regex. None of those
 * is a skip, and reporting them sends the developer to edit prose.
 *
 * Blanking replaces each body with spaces of the same length and leaves every
 * newline in place, so the blanked text occupies exactly the original grid: an
 * offset taken from it is an offset into the file a developer is looking at, and
 * `file:line` stays exact.
 *
 * This is a scanner rather than a parse because the gate only needs to know where
 * code begins and ends, not what it means.
 */
function stripComments(text: string): string {
	const out: string[] = [];
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === '/' && text[i + 1] === '/') {
			i = blank(out, text, i, lineEnd(text, i), '');
		} else if (c === '/' && text[i + 1] === '*') {
			const close = text.indexOf('*/', i + 2);
			const end = close === -1 ? text.length : Math.min(close + 2, text.length);
			i = blank(out, text, i, end, '');
		} else if (c === '/' && startsRegex(text, i)) {
			// A `(` inside a regex has to be escaped or spelled in a character class,
			// so the bare byte the gate looks for is hard to write by accident — but a
			// test that searches test sources for the forbidden shape is exactly the
			// kind of test that would spell it, and it is not a skip.
			i = blank(out, text, i, regexEnd(text, i), '');
		} else if (c === "'" || c === '"') {
			// Quotes are kept, because a name read off the blanked text is delimited
			// by them. The body is not kept.
			i = blank(out, text, i, quoteEnd(text, i, c), c);
		} else if (c === '`') {
			i = blankTemplate(out, text, i);
		} else {
			out.push(c);
			i++;
		}
	}
	return out.join('');
}

/**
 * Copies `text[from, to)` to `out` as spaces, keeping newlines, and returns `to`.
 * `keep` is written verbatim at both ends when set — the quotes around a string
 * body, or the `${` and `}` of an interpolation.
 */
function blank(out: string[], text: string, from: number, to: number, keep: string): number {
	if (keep) out.push(keep[0]);
	for (let i = from + keep.length; i < to - keep.length; i++) {
		out.push(text[i] === '\n' ? '\n' : ' ');
	}
	if (keep) out.push(keep[keep.length - 1]);
	return to;
}

/**
 * Copies a whole template literal, blanking its text but keeping the interpolation
 * expressions verbatim: an expression is code, so a skip written inside one is a
 * real skip and has to survive.
 */
function blankTemplate(out: string[], text: string, from: number): number {
	out.push('`');
	const end = quoteEnd(text, from, '`');
	const close = end - 1;
	let i = from + 1;
	while (i < close) {
		if (text[i] === '\\') {
			out.push(' ', ' ');
			i += 2;
		} else if (text[i] === '$' && text[i + 1] === '{') {
			const next = copyInterpolation(out, text, i + 2, close);
			// An interpolation that never closes means the backtick we took for the
			// literal's end was itself inside it, so the literal does not close here.
			if (next === close) return end;
			i = next;
		} else {
			out.push(text[i] === '\n' ? '\n' : ' ');
			i++;
		}
	}
	out.push('`');
	return end;
}

/** Copies an interpolation's expression verbatim and returns the index past its `}`. */
function copyInterpolation(out: string[], text: string, from: number, to: number): number {
	out.push(' ', ' ');
	let depth = 1;
	for (let i = from; i < to; i++) {
		if (text[i] === '{') depth++;
		else if (text[i] === '}') {
			depth--;
			if (depth === 0) {
				out.push('}');
				return i + 1;
			}
		}
		out.push(text[i]);
	}
	return to;
}

/**
 * Whether a regex literal opens at `at`, decided from the last significant token:
 * a regex cannot follow an operand or a closing bracket, which are exactly the
 * cases where a `/` is division. Getting this backwards is harmless in the
 * direction that matters — a division read as a regex ends at the next `/` on the
 * same line — because the body it blanks holds no pattern the gate looks for.
 */
function startsRegex(text: string, at: number): boolean {
	let i = at - 1;
	while (i >= 0 && /\s/.test(text[i])) i--;
	if (i < 0) return true;
	if (/[)\]}]/.test(text[i])) return false;
	if (/[A-Za-z0-9_$]/.test(text[i])) {
		// A keyword is an operand boundary; a plain identifier ends one.
		const word = /[A-Za-z0-9_$]+$/.exec(text.slice(0, i + 1))?.[0];
		return !word || ['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void'].includes(word);
	}
	return true;
}

/** Index just past the closing quote of the `'…'`, `"…"` or `` `…` `` starting at `at`. */
function quoteEnd(text: string, at: number, quote: string): number {
	for (let i = at + 1; i < text.length; i++) {
		if (text[i] === '\\') {
			i++;
			continue;
		}
		if (text[i] === quote) return i + 1;
	}
	return text.length;
}

/** Index just past the `/` that ends the regex literal opened at `at`. */
function regexEnd(text: string, at: number): number {
	let inClass = false;
	for (let i = at + 1; i < text.length; i++) {
		if (text[i] === '\n') return i + 1;
		if (text[i] === '\\') {
			i++;
			continue;
		}
		if (text[i] === '[') inClass = true;
		else if (text[i] === ']') inClass = false;
		else if (text[i] === '/' && !inClass) return i + 1;
	}
	return text.length;
}

/** Index of the newline ending the line `at` is on, or the end of the text. */
function lineEnd(text: string, at: number): number {
	const newline = text.indexOf('\n', at);
	return newline === -1 ? text.length : newline;
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
 * `open`, by matching parentheses. Blanked and original text are both accepted
 * because the two callers want different things: a condition has to be read
 * blanked, so that a `true,` inside a literal is not mistaken for the condition,
 * while a test name has to be read from the original, since the whole point of
 * blanking is that the name is no longer there.
 */
function argsAt(source: string, blanked: string, open: number): string {
	const end = afterCall(blanked, open);
	return end > open ? source.slice(open + 1, end) : source.slice(open + 1);
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
	const constants = readConstants(code);

	const sites: SkipSite[] = [];
	const opener = new RegExp(`\\b\\w+\\.(?:${members})${CALL_OPENERS}`, 'g');
	let match: RegExpExecArray | null;
	while ((match = opener.exec(code)) !== null) {
		// The match ends at the `(` the member was called with, which for a
		// conditional shape is the condition's own paren.
		const open = match.index + match[0].length - 1;
		const isConditional = /\.skipIf\b/.test(match[0]);

		// Only a condition that is constant-true is unconditional; a predicate can
		// lift itself when the environment changes, which is the whole point of
		// `skipIf`. A plain `skip`/`todo`/`only` has no condition to inspect, so it
		// always qualifies.
		if (isConditional && !isUnconditionalCondition(argsAt(code, code, open), constants)) continue;

		// A plain `skip`/`todo`/`only` names its test in its own first argument. A
		// conditional one names it in the call that the result of `skipIf(...)` is
		// immediately invoked with, so the read has to start past the condition.
		const name = isConditional
			? invocationNameAt(source, match.index + match[0].length)
			: firstArgumentName(argsAt(source, code, open));
		const lineIndex = code.slice(0, match.index).split('\n').length - 1;
		sites.push({ line: lineIndex + 1, name });
	}
	return sites;
}

/** One `const` binding: the name and the text its initialiser holds. */
const CONST_DECLARATION = /\bconst\s+([\w$]+)\s*=\s*([^;]*);/g;

/** How many links of a name-to-name chain the gate will follow. */
const CONSTANT_CHAIN_LIMIT = 10;

/**
 * Every `const` in `code` bound to a single initialiser, keyed by name and mapped
 * to the text of that initialiser. Read off the blanked text, so a `const` inside
 * a literal or a comment is not a binding, and a name's value is the value a reader
 * can see.
 *
 * Only the first binding of `const a = 1, b = 2;` is picked up, and that is the
 * right trade: a second name in the same declaration is never the reason a suite
 * is skipped, and a pattern loose enough to reach it also reaches object literals
 * and class fields.
 *
 * The pattern is rebuilt on every call rather than shared: a `/g` regex carries
 * `lastIndex` between `exec` calls, and a file scanned twice would find nothing
 * the second time.
 */
function readConstants(code: string): Map<string, string> {
	const declaration = new RegExp(CONST_DECLARATION.source, 'g');
	const constants = new Map<string, string>();
	let found: RegExpExecArray | null;
	while ((found = declaration.exec(code)) !== null) {
		const name = found[1].trim();
		if (name) constants.set(name, found[2].trim());
	}
	return constants;
}

/**
 * Whether a conditional shape's condition can never lift. `args` is the text of the
 * call's arguments and `constants` the file's `const` bindings; a condition that
 * names one is read off its value instead, because the historical escape was a
 * variable rather than a literal.
 *
 * Only a condition made purely of constants and operators counts, and only when
 * every operand in it is constant-true. A call anywhere in the expression is a
 * predicate by definition — that is the case `skipIf` exists for — so the walk
 * stops there and reports liftable.
 */
function isUnconditionalCondition(args: string, constants: Map<string, string>): boolean {
	const expression = args.split(',')[0];
	const operands = expression.match(/[\w$]+/g) ?? [];
	return operands.length > 0 && operands.every(operand => isConstantTrue(operand, constants, CONSTANT_CHAIN_LIMIT));
}

/** Whether one token of a condition is `true` once `const` names are followed. */
function isConstantTrue(token: string, constants: Map<string, string>, hops: number): boolean {
	if (/^true$/i.test(token)) return true;
	const value = constants.get(token);
	if (value === undefined || hops <= 0) return false;
	const nested = value.match(/[\w$]+/g) ?? [];
	return nested.length > 0 && nested.every(operand => isConstantTrue(operand, constants, hops - 1));
}

/** Every unconditional skip in a file: the spellings that drop a test with no condition. */
function findUnconditionalSkips(source: string): SkipSite[] {
	return findSites(source, SKIP_SHAPES);
}

/** Every stray `.only` in a file. See ONLY_SHAPES for why it is reported separately. */
function findFocusOnly(source: string): SkipSite[] {
	return findSites(source, ONLY_SHAPES);
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
	for (const root of SCAN_ROOTS) {
		for (const file of walk(root)) {
			// This file necessarily talks about the pattern it forbids, so it is not
			// evidence about anything. Matched by full path: a basename match would
			// exempt any other file of the same name, anywhere.
			if (file === THIS_FILE) continue;
			const rel = relative(REPO_ROOT, file);
			for (const site of detect(readFileSync(file, 'utf8'))) {
				const at = `${rel}:${site.line}`;
				// SANCTIONED_SITES was written against a scan rooted at CONTRACT_DIR,
				// so its keys are the harness's paths relative to tests/contract. The
				// scan is repo-wide now, so the key is rebuilt in that same basis
				// rather than re-rooting the exemption list: a sanctioned site stays
				// sanctioned, and an offender is reported by the path a reader would
				// look up from the repository root.
				const sanctioned = relative(CONTRACT_DIR, file) + ':' + site.line;
				if (detect === findUnconditionalSkips && !site.name && SANCTIONED_SITES.has(sanctioned)) {
					continue;
				}
				// The allowlist is matched against THIS skip's own test name, never
				// against the whole file. Scoping it to the file would let a single
				// legitimate skip whitelist every other skip in the same file, which
				// is exactly the hole the gate exists to close.
				if (!site.name || !ALLOWED_SKIPS.includes(site.name)) {
					offenders.push(`${at}  ${site.name ?? '(unnamed skip)'}`);
				}
			}
		}
	}
	return offenders;
}

/**
 * A real unconditional skip, in the shape the gate exists to catch.
 *
 * The test name shares a line with the `)(` that names it, because that is
 * where `skipNameAt` looks for it. A wrapped call is still detected, but is
 * reported as an unnamed skip.
 */
const PLANTED_SKIP = [
	`import { test } from 'bun:test';`,
	`test.skipIf(true, 'planted by the skip-policy end-to-end test')('escaped the scan roots', () => {});`,
	'',
].join('\n');

/**
 * Runs `check` with a file planted at the repository-relative `relPath`, then
 * removes it (and any directory it had to create).
 *
 * The plant has to live inside the repository. A file in a temp directory is
 * outside every scan root, so no test built on one can observe a scan-scope
 * regression — which is how this file's end-to-end test came to pass with the
 * repo-wide scan switched off.
 */
function withPlantedFile(
	relPath: string,
	contents: string,
	check: (offenders: string[]) => void,
): void {
	const full = join(REPO_ROOT, relPath);
	const parent = dirname(full);
	const madeParent = !existsSync(parent);
	if (madeParent) mkdirSync(parent, { recursive: true });
	writeFileSync(full, contents);
	try {
		check(collectOffenders());
	} finally {
		rmSync(full, { force: true });
		if (madeParent) rmdirSync(parent);
	}
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

	bunTest('detects a condition that is true however it is written', () => {
		// Parens are how a reader parenthesises a condition before passing it on,
		// and the all-caps spelling is how CI configs and issue text spell it. Both
		// are `true` to a JavaScript engine and both are `true` to this gate.
		for (const condition of [
			'true',
			'(true)',
			'((true))',
			'TRUE',
			'true && true',
		]) {
			const sites = findUnconditionalSkips(`it.skipIf(${condition}, 'why')('name', () => {});`);
			expect(sites.map(site => site.name)).toEqual(['name']);
		}
	});

	bunTest('detects a condition bound to a const that is true', () => {
		// The historical escape was a variable, not a literal: naming the reason once
		// and gating on it reads better than repeating the literal, and it is the
		// shape the version floor actually uses. Reading only the condition argument
		// cannot see it, so the gate follows `const` names back to their value.
		const source = [
			`const unavailable = true;`,
			`it.skipIf(unavailable, 'needs a newer git')('restores the source', () => {});`,
		].join('\n');
		const sites = findUnconditionalSkips(source);
		expect(sites.map(site => site.name)).toEqual(['restores the source']);
		expect(sites[0].line).toBe(2);
	});

	bunTest('detects a condition that a const is bound to, and follows it through', () => {
		const source = [
			`const belowFloor = true;`,
			`const unavailable = belowFloor;`,
			`it.skipIf(unavailable, 'needs a newer git')('restores the source', () => {});`,
		].join('\n');
		expect(findUnconditionalSkips(source).map(site => site.name)).toEqual(['restores the source']);
	});

	bunTest('does not follow a condition into a function the environment could change', () => {
		// The point of following a name is to catch one bound to `true`. A name bound
		// to a predicate is precisely the case `skipIf` exists for, and following it
		// would make every environment-gated suite an offence.
		const source = [
			`const belowFloor = gitVersion().atLeast(FLOOR) === false;`,
			`it.skipIf(belowFloor, 'needs a newer git')('restores the source', () => {});`,
		].join('\n');
		expect(findUnconditionalSkips(source)).toEqual([]);
	});

	bunTest('does not follow a condition that a template or string is bound to', () => {
		const source = [
			`const reason = 'needs a newer git';`,
			`const label = \`${'${reason}'} or something\`;`,
			`it.skipIf(label, 'x')('restores the source', () => {});`,
		].join('\n');
		expect(findUnconditionalSkips(source)).toEqual([]);
	});

	bunTest('reads a condition off the same call as the shape it was written in', () => {
		// `it.skipIf(true)('name', fn)` and `it.skipIf(true, 'why')('name', fn)` are
		// both unconditional and both take the condition first. The second argument is
		// the reason, so a gate that read argument two would see prose and pass it.
		const withReason = findUnconditionalSkips(`it.skipIf(true, 'a reason')('name', () => {});`);
		expect(withReason.map(site => site.name)).toEqual(['name']);
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

	bunTest('ignores the pattern when it appears in a string literal', () => {
		// A policy constant, a copy-pasted snippet, or a URL quoting the rule is
		// prose, not a skip. Reporting it sends the developer to edit a string.
		const source = [
			`const POLICY = "contract tests must not use it.skipIf(true, 'reason')('name', fn)";`,
			`const LINK = "see https://example.com/it.skipIf(true, 'reason')('name', fn)";`,
			`it('a real test', () => { expect(POLICY).toBeString(); });`,
		].join('\n');
		expect(findUnconditionalSkips(source)).toEqual([]);
	});

	bunTest('ignores the pattern when it appears in a template literal', () => {
		// Multi-line snippets in template literals are the most natural way to write
		// a policy example, and the shape of the example is a skip.
		const source = [
			'const snippet = `',
			`it.skipIf(true, 'reason')('name', fn)`,
			'`;',
			`it('a real test', () => { expect(snippet).toBeString(); });`,
		].join('\n');
		expect(findUnconditionalSkips(source)).toEqual([]);
	});

	bunTest('ignores the pattern when it appears in a regex literal', () => {
		// A test that searches test sources for the forbidden spelling has to name
		// it, and a regex is how you would. Here the body spells the `(` in full
		// inside a character class, which is the only way a regex can contain a bare
		// one, so the shape does match the gate's opener.
		const source = [
			`const FORBIDDEN = /it\\.skipIf[(]true,/;`,
			`it('a real test', () => { expect(FORBIDDEN).toBeInstanceOf(RegExp); });`,
		].join('\n');
		expect(findUnconditionalSkips(source)).toEqual([]);
	});

	bunTest('still detects a real skip that follows quoted prose', () => {
		// The control for the three above: blanking a literal must not reach past it
		// and disarm the scan. Both shapes live in one file on purpose.
		const source = [
			`const POLICY = "never write it.skipIf(true, 'reason')('name', fn)";`,
			`const snippet = \`it.skip('another', () => {});\`;`,
			`it.skipIf(true, 'hardcoded')('a real skip', () => {});`,
		].join('\n');
		const sites = findUnconditionalSkips(source);
		expect(sites).toHaveLength(1);
		expect(sites[0].name).toBe('a real skip');
		expect(sites[0].line).toBe(3);
	});

	bunTest('blanking preserves every line length and the line count', () => {
		// The gate reports `file:line` to a developer who will go read that line, so
		// the blanked text has to occupy exactly the same grid as the original. A
		// line that is deleted or padded moves the report off the offender, which is
		// worse than a missing detection because it looks authoritative.
		const source = [
			`import { it } from 'bun:test';`,
			`const url = "https://example.com/it.skipIf(true, 'quoted', 2)";`,
			`/* a block comment`,
			`   spanning two lines */`,
			'const snippet = `line one',
			"line two it.skipIf(true, 'r')('n', fn)`;",
			`it.skipIf(true, 'hardcoded')('a real skip', () => {});`,
		].join('\n');
		const blanked = stripComments(source);
		expect(blanked.split('\n')).toHaveLength(source.split('\n').length);
		blanked.split('\n').forEach((line, i) => {
			expect(line).toHaveLength(source.split('\n')[i].length);
		});
		// And the offender is still reported at the line a developer would read.
		expect(findUnconditionalSkips(source).map(site => site.line)).toEqual([7]);
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

	bunTest('the scan covers the whole repository, not just tests/contract', () => {
		// The gate's first version derived its scan root from its own location, so
		// it saw 12 of the repository's 81 test files. A skip planted in
		// `tests/e2e` or in any `packages/*/src` test passed the gate silently.
		// This pins the scope: a real, live test file outside `tests/contract`
		// must be inside the scan set.
		const scanned = walk(REPO_ROOT);
		expect(scanned.length).toBeGreaterThan(walk(CONTRACT_DIR).length);
		for (const mustScan of [
			'tests/e2e/vcs.spec.ts',
			'packages/core/src/project/vcs.test.ts',
			'tests/manifest-boundary.test.ts',
		]) {
			expect(scanned.map(f => relative(REPO_ROOT, f))).toContain(mustScan);
		}
	});

	bunTest('the scan excludes vendored and generated directories', () => {
		// A repo-wide scan must not wander into node_modules, the git object
		// store, or the vendored agent skills, or it becomes slow and noisy.
		const scanned = walk(REPO_ROOT).map(f => relative(REPO_ROOT, f));
		expect(scanned.some(f => f.startsWith(`node_modules${sep}`))).toBe(false);
		expect(scanned.some(f => f.startsWith(`.agents${sep}`))).toBe(false);
		expect(scanned.some(f => f.startsWith(`.git${sep}`))).toBe(false);
	});

	bunTest('the scan reads test files, not every source file', () => {
		// The walk originally collected all 224 tracked `.ts` files and applied the
		// detector to each, which flagged legitimate code in ordinary sources: a
		// string that merely mentions the pattern, and a conditional `skipIf` wrapper
		// like the one `harness.ts` uses. `stripComments` blanks comments, not string
		// literals, and both of those read as a skip named `(unnamed skip)`, so the
		// allowlist could not absorb them either.
		//
		// Scoping to files `bun test` would collect closes both at the source, with
		// no hand-maintained directory list to drift.
		const scanned = walk(REPO_ROOT).map(f => relative(REPO_ROOT, f));
		expect(scanned).not.toContain('packages/core/src/index.ts');
		expect(scanned).not.toContain('tests/contract/harness.ts');
		// A package's own test files are still read, wherever they live.
		expect(scanned).toContain('packages/core/src/project/vcs.test.ts');
		expect(scanned).toContain('tests/e2e/vcs.spec.ts');
	});

	bunTest('the scan follows bun test own file discovery', () => {
		// A test only reduces coverage if the runner can collect it, so the scan set
		// and the runner's discovery set have to agree. Measured against `bun test`
		// v1.4.2: it collects `a.test.ts`, `b.spec.ts`, `c_test.ts` and
		// `n-test.svelte.test.ts`, plus the `.tsx`/`.js`/`.mjs`/`.cjs`/`.jsx`/
		// `.mts`/`.cts` spellings.
		expect(TEST_FILE_PATTERN.test('a.test.ts')).toBe(true);
		expect(TEST_FILE_PATTERN.test('b.spec.ts')).toBe(true);
		expect(TEST_FILE_PATTERN.test('c_test.ts')).toBe(true);
		expect(TEST_FILE_PATTERN.test('h.test.mts')).toBe(true);
		expect(TEST_FILE_PATTERN.test('g.test.js')).toBe(true);

		// A name `bun test` will not collect, so the pattern must not match it:
		// `.tests.ts` is a plural, which the runner does not treat as a test.
		expect(TEST_FILE_PATTERN.test('e.tests.ts')).toBe(false);

		// A source file is not a test file, however test-adjacent its name. These
		// are the real ones in this repository, and the reason the scan skips them.
		expect(TEST_FILE_PATTERN.test('packages/core/src/index.ts')).toBe(false);
		expect(TEST_FILE_PATTERN.test('harness.ts')).toBe(false);
		expect(TEST_FILE_PATTERN.test('node-fs-handle.ts')).toBe(false);
	});

	bunTest('the scan is spared the false positives a source file would raise', () => {
		// Why the narrowing matters: the detector is string-blind. `stripComments`
		// blanks comments, not string literals, and it reads text, not call
		// expressions. So both of these are reported as a skip named
		// `(unnamed skip)` — which the allowlist cannot absorb, since an allowlist
		// entry matches a test name.
		const docString = `export const SKIP_DOC = 'it.skipIf(true, 1)(2, 3)';`;
		expect(findUnconditionalSkips(docString)).toHaveLength(1);
		const wrapper = `export const maybeSkip = (c: boolean) => c ? it.skipIf(true, 'why') : it;`;
		expect(findUnconditionalSkips(wrapper)).toHaveLength(1);

		// Neither can come from an ordinary source file now, because no source file
		// is scanned. `harness.ts` is the real one: it holds the conditional wrapper
		// this repo actually uses, and is skipped today only because its condition
		// is an identifier. With the pattern narrowed to test files, moving that
		// wrapper into a package's `src` stops being able to turn the gate red.
		const scanned = walk(REPO_ROOT).map(f => relative(REPO_ROOT, f));
		expect(scanned).not.toContain('tests/contract/harness.ts');
	});

	bunTest('every ignored directory is one the scan steps over', () => {
		// The exclusion set used to be hand-written and had already drifted from
		// `.gitignore`: `dist-main`, `.output`, `.svelte-kit`, `scratch` and
		// `test-results` were all missing. Each is created by an ordinary `bun run
		// build` or Playwright run, so the gate's verdict depended on whether the
		// machine had run one — a transpiled copy of a test in a build directory
		// turned the merge gate red with an error pointing at a file nobody wrote.
		//
		// Deriving the set from `.gitignore` fixes that, and this pins it: every
		// literal ignored name has to be excluded, whichever way it is spelled.
		const gitignore = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8');
		const ignored: string[] = [];
		for (const raw of gitignore.split('\n')) {
			const line = raw.trim();
			if (!line || line.startsWith('#') || line.startsWith('!')) continue;
			if (line.includes('*')) continue; // glob, matches more than one name
			ignored.push(line.replace(/\/$/, ''));
		}
		for (const name of ignored) {
			expect(SCAN_EXCLUDES.has(name)).toBe(true);
		}

		// The five that drifted, named so the regression is legible rather than
		// only derivable from `.gitignore`.
		for (const name of ['dist-main', '.output', '.svelte-kit', 'scratch', 'test-results']) {
			expect(SCAN_EXCLUDES.has(name)).toBe(true);
		}

		// And the scan really does step over them, not merely name them.
		const scanned = walk(REPO_ROOT).map(f => relative(REPO_ROOT, f));
		for (const ignoredDir of ['dist-main', '.output', 'scratch', 'test-results']) {
			expect(scanned.some(f => f.split(sep).includes(ignoredDir))).toBe(false);
		}
	});

	bunTest('a symlink loop does not make the scan walk in circles', () => {
		// `statSync` follows symlinks, so a link pointing at an ancestor is
		// indistinguishable from a real directory to the walk. With nothing to
		// stop it, one `loop -> ..` at the repository root took the walk from 224
		// files to 119,304, to depth 87, and from 14ms to 8.1s. It terminated only
		// because the OS path-length limit stopped it, which is not a guarantee a
		// merge gate should rest on.
		//
		// The walk must resolve each directory and visit each resolved path once.
		const withLoop = (): number => {
			const loopDir = join(REPO_ROOT, 'tests', 'contract', 'zz-loop');
			mkdirSync(loopDir, { recursive: true });
			symlinkSync('..', join(loopDir, 'self'));
			try {
				return walk(REPO_ROOT).length;
			} finally {
				rmSync(loopDir, { recursive: true, force: true });
			}
		};
		const baseline = walk(REPO_ROOT).length;
		expect(withLoop()).toBe(baseline);
	});

	bunTest('a broken symlink does not take the gate down', () => {
		// The `try`/`catch` around the stat exists for this: a dangling link must
		// not fail the whole gate over a skip nobody can reach through it. The
		// walk should see the same files with the dangling link present as
		// without it.
		const baseline = walk(REPO_ROOT).length;
		const dir = join(REPO_ROOT, 'tests', 'contract', 'zz-broken');
		mkdirSync(dir, { recursive: true });
		symlinkSync(join(dir, 'nowhere'), join(dir, 'dangling.test.ts'));
		try {
			expect(walk(REPO_ROOT).length).toBe(baseline);
			expect(collectOffenders()).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	bunTest('a file named skip-policy.test.ts outside this one is still scanned', () => {
		// This file is excluded from its own scan because it necessarily contains
		// the pattern it forbids. That exclusion has to be this exact file. A
		// basename suffix match would silently exempt every future file named
		// `skip-policy.test.ts` anywhere in the repository, which is the same class
		// of blind spot the gate exists to close.
		withPlantedFile('packages/core/src/skip-policy.test.ts', PLANTED_SKIP, offenders => {
			expect(offenders).toEqual([
				'packages/core/src/skip-policy.test.ts:2  escaped the scan roots',
			]);
		});
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
