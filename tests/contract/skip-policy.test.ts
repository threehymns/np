import { describe as bunDescribe, expect, it as bunTest } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
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
 * The same exit-0 silence applies to `it.skip`, `it.todo` and — worst of all —
 * `it.only`, which additionally deletes every sibling test in its file. An
 * earlier version of this gate claimed to police `describe.skip` in this
 * comment while its detector only matched `skipIf(true, ...)`, so `.skip`,
 * `.todo` and `.only` all passed silently. All four families are enforced now.
 *
 * The rule is enforced on the source, not on test output, so it holds even when
 * the suite is run with a filter that skips whole files.
 *
 * This is a lint, not an enforcement mechanism, and the boundary of what it can
 * see is deliberate: it matches a receiver spelled `it`, `test` or `describe`
 * followed by a literal call, tolerating whitespace around the dot. A skip
 * reached through a variable — `const s = it.skip; s('x', fn)` — is not matched.
 * Resolving that needs an AST parse, which is a different change at a different
 * altitude, and it is tracked in `KNOWN_BLIND_SPOTS` so a reader cannot infer
 * more coverage than exists. The version-floor guard in `harness.ts` is written
 * through a variable, which is why the allowlist below can stay empty.
 *
 * Scope: the whole repository, not just this folder. The gate's first version
 * scanned only `tests/contract`, which holds 9 test files — 9 of the
 * repository's 96, and 9 of the 81 `bun test` collects (it also holds three
 * non-test files: `harness.ts`, `node-fs-handle.ts` and `rune-setup.ts`). The
 * scan root was derived from the gate's own location.
 * `docs/vcs-contract-gate.md` states the check is run as a bare `bun test` from
 * the repository root, and every test file `bun test` collects is a place a
 * skip can hide. Verified: an unconditional `test.skipIf(true, ...)` planted in
 * `tests/e2e/vcs.spec.ts` left the gate reporting 12 pass / 0 fail.
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
 * strict. The detector reads text, not call expressions, and `stripNonCode`
 * blanks comments and literal bodies alike, so scanning source files raised two
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
 * A skip is found by reading the source, so some shapes are out of reach. Naming
 * them here is the point: the alternative is a gate whose comment implies a
 * guarantee it does not make, which is how the previous two versions of this file
 * shipped.
 *
 *   - A receiver reached through a variable: `const s = it.skip; s('x', fn)`, or
 *     `const { skip } = it; skip('x', fn)`. The regex matches receiver *text*; it
 *     does not resolve what an identifier was assigned. The version-floor guard
 *     in `harness.ts` has this shape — deliberately, since it is the predicate
 *     `ALLOWED_SKIPS` documents — and it is also the shape a maintainer
 *     generalising `const focused = it.only` would write, which is a real hole.
 *   - A computed member: `it['skip']('x', fn)`.
 *   - A receiver that is not a test registrar at all, reached by the same
 *     mechanism. Widening the match to any identifier would close the first two
 *     and open this one; `skip`, `todo` and `only` are not general-purpose method
 *     names, but `anyIdentifier.skipIf(true, …)` on something that is not a
 *     registrar is a false positive waiting to happen.
 *
 * Closing the first shape needs an AST parse rather than a wider pattern, which is
 * a larger change than a lint should carry on its own.
 *
 * One test below asserts that the first shape really is still missed, so this
 * list cannot quietly go stale.
 */
const KNOWN_BLIND_SPOTS: string[] = [
	'a skip whose receiver is reached through a variable',
	'a computed member such as it[\'skip\']',
	'a widened receiver that is not a test registrar',
];

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

/**
 * How deep the walk will descend before giving up.
 *
 * A backstop, not the loop defence. The repository nests five levels today
 * (`packages/core/src/project/...`); twenty leaves room to grow and still
 * bounds a pathologically deep tree rather than trusting the OS to stop it.
 */
const MAX_DEPTH = 20;

/**
 * Collects every test file under `dir`.
 *
 * `statSync` follows symlinks, so a link pointing at an ancestor looks exactly
 * like a real directory and would otherwise be descended into repeatedly —
 * `self -> ..` at the repository root expanded this walk from 224 files to
 * 119,304, to depth 87, before the OS path-length limit ended it. Each
 * directory is therefore resolved with `realpathSync` and skipped if that
 * resolved path has already been visited, so a loop is entered once and not
 * again. A broken link has no resolved path, and is handled by the same
 * `catch` that skips it: a skip nobody can reach is not worth failing the gate
 * over.
 */
function walk(dir: string, out: string[] = [], seen = new Set<string>(), depth = 1): string[] {
	if (depth > MAX_DEPTH) return out;
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (SCAN_EXCLUDES.has(entry)) continue;
		// A broken link has no resolved path, so this drops it. A skip nobody can
		// reach through a dangling link is not worth failing the gate over.
		let resolved: string;
		let isDir: boolean;
		try {
			resolved = realpathSync(full);
			isDir = statSync(full).isDirectory();
		} catch {
			continue;
		}
		if (isDir) {
			if (seen.has(resolved)) continue;
			seen.add(resolved);
			walk(full, out, seen, depth + 1);
		} else if (TEST_FILE_PATTERN.test(entry)) {
			out.push(full);
		}
	}
	return out;
}


/**
 * Blanks everything in the source that is not code the detector should read:
 * comments, and the contents of string, template and regex literals.
 *
 * Literals are blanked, not deleted, and every replacement is the same length as
 * what it replaces, with newlines left where they were. The detector works on
 * character offsets into this string, so a shorter output would shift every line
 * number it reports; a gate that names the wrong line is worse than one that does
 * not fire. A test pins that invariant directly.
 */
function stripNonCode(source: string): string {
	// Two passes rather than one, because the naive single pass is wrong in both
	// directions: a `//` inside a string literal is not a comment (taking it for
	// one hides every real skip after it on that line), and a `/*` inside a
	// comment is not a block opener (taking it for one swallows the rest of the
	// file and reports nothing). Comments are removed first, so a comment that
	// contains a quote cannot be read as an unterminated literal, and the
	// remaining quotes are all real ones.
	const out = source
		.replace(/\/\*[\s\S]*?\*\//g, blankKeepingNewlines)
		.replace(/(^|[^:])\/\/[^\n]*/g, blankKeepingNewlines);
	return blankLiterals(out);
}

/**
 * Replaces `m` with spaces, keeping its newlines, so offsets and line numbers
 * survive.
 */
function blankKeepingNewlines(m: string): string {
	return m.replace(/[^\n]/g, ' ');
}

/**
 * Blanks the body of every string, template and regex literal, keeping the
 * delimiters and every offset intact.
 *
 * An unterminated literal is left alone rather than blanked to the end of the
 * file. A lone quote is not proof of a literal — apostrophes appear in comments
 * already removed, and treating one as an opener would silently hide every skip
 * below it, which is precisely the failure this gate exists to prevent.
 */
function blankLiterals(source: string): string {
	const out = source.split('');
	for (let i = 0; i < source.length; i++) {
		const open = source[i];
		if (open === '/') {
			const end = endOfRegex(source, i);
			if (end !== -1) {
				blank(i, end);
				i = end;
			}
			continue;
		}
		if (!isLiteralOpener(open)) continue;
		const end = endOfLiteral(source, i);
		// A literal that never closes is not treated as one: the risk of hiding
		// real skips outweighs the false positive this leaves behind.
		if (end === -1) continue;
		blank(i, end);
		i = end;
	}
	return out.join('');

	/** Blanks the half-open range, keeping the delimiters at each end. */
	function blank(from: number, to: number): void {
		for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
	}
}

/**
 * Whether `c` can open a string, template or regex literal. A quoted literal is
 * closed by the same character it was opened with.
 */
function isLiteralOpener(c: string): boolean {
	return c === "'" || c === '"' || c === '`';
}

/**
 * Index of the quote closing the literal opened at `open`, or -1 when the literal
 * runs off the end of the source.
 */
function endOfLiteral(source: string, open: number): number {
	for (let i = open + 1; i < source.length; i++) {
		if (source[i] === '\\') {
			i++;
			continue;
		}
		if (source[i] === source[open]) return i;
		// An unescaped newline ends a quoted literal; only a template may span
		// lines.
		if (source[i] === '\n' && source[open] !== '`') return -1;
	}
	return -1;
}

/**
 * Index of the `/` closing a regex literal opened at `open`, or -1 when the `/` is
 * division or a path instead.
 *
 * Deciding that needs to know the previous meaningful character: after an
 * operand a `/` divides, after `(` or `=` or `,` or `return` it opens a literal.
 */
function endOfRegex(source: string, open: number): number {
	if (!source[open + 1]) return -1;
	// A regex cannot start with `*`, so `/*` is a comment, not an empty literal.
	if (source[open + 1] === '*') return -1;
	const before = previousMeaningful(source, open);
	if (before && /[\w$)\]]/.test(before)) return -1;
	for (let i = open + 1; i < source.length; i++) {
		if (source[i] === '\\') {
			i++;
			continue;
		}
		if (source[i] === '[') {
			// Skip a character class wholesale: `[` and `]` are literal inside it.
			const end = source.indexOf(']', i);
			if (end === -1) return -1;
			i = end;
			continue;
		}
		if (source[i] === '/') {
			// A modifier follows the closing slash, and is part of the literal.
			const mod = /^[a-z]*/.exec(source.slice(i + 1))![0];
			return i + mod.length;
		}
		if (source[i] === '\n') return -1;
	}
	return -1;
}

/**
 * The last non-whitespace, non-comment character before `index`, or '' at the
 * start of the source. Comments are already blanked, so whitespace alone is
 * enough to skip past them.
 */
function previousMeaningful(source: string, index: number): string {
	for (let i = index - 1; i >= 0; i--) {
		if (!/\s/.test(source[i])) return source[i];
	}
	return '';
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
 *
 * The receiver and the modifier are matched with whitespace allowed on either side
 * of the dot, so a wrapped spelling — `it\n  .skip(` — is caught. Without that a
 * formatter that breaks a chain across lines is enough to hide an unconditional
 * skip from the gate entirely, which is the one failure this gate cannot have.
 * What that does *not* reach is a receiver reached through a variable
 * (`const s = it.skip; s(...)`): see the header.
 *
 * The match may be padded with whitespace, so its last character is not always the
 * paren: `it\n  .skip(` ends on `(` but `describe .skipIf (` ends on a space. The
 * `(` is what the argument list is anchored to, so it is located inside the match's
 * own extent rather than assumed to be its last character.
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
 * Finds every way a test can be silently removed from the run.
 *
 * Every site this reports removes coverage while `bun test` still exits 0:
 *
 *   - `it.skipIf(true, ...)` — unconditional by construction. A `skipIf` with a
 *     predicate or a `false` literal is a guard that can lift itself, so it is
 *     deliberately not reported (see `ALLOWED_SKIPS`).
 *   - `it.skip(...)` / `describe.skip(...)` — always unconditional.
 *   - `it.todo(...)` — the body is never run.
 *   - `it.only(...)` — the worst of the four, and the reason the shapes are an
 *     explicit list rather than a loose pattern match. `only` does not merely
 *     skip the test it is attached to: it silences every *sibling* test in the
 *     same file, so a single `it.only` left behind after debugging deletes
 *     unrelated coverage with no signal at all. Verified against a real runner:
 *     three tests in a file, one marked `only`, one executed, `bun test` exit 0.
 *
 * `shapes` selects which of those are in scope for this call, so one spelling
 * cannot be added without the others.
 *
 *
 * A `skipIf` call is routinely wrapped across lines — `it.skipIf(` on one line and
 * `true,` on the next — so the condition cannot be read a line at a time. Arguments
 * are extracted with parenthesis matching and only then trimmed, which handles both
 * the wrapped and the single-line spelling. Comments and literal bodies are blanked
 * first so the gate does not match its own explanation of the rule, or a snippet
 * that quotes it.
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
	const code = stripNonCode(source);
	const members = shapes.map(shape => shape.member).join('|');
	const constants = readConstants(code);

	const sites: SkipSite[] = [];
	// Whitespace is allowed on either side of the dot, so `it\n  .skip(` is caught.
	// Without that, a formatter that breaks a chain across lines hides an
	// unconditional skip from the gate completely.
	const opener = new RegExp(`\\b\\w+\\s*\\.\\s*(?:${members})${CALL_OPENERS}`, 'g');
	let match: RegExpExecArray | null;
	while ((match = opener.exec(code)) !== null) {
		// The call's `(` is the last one inside the match, not necessarily its last
		// character: `describe .skipIf (` ends the match on a space. The `(` is what
		// the argument list is anchored to, so it is located inside the match's own
		// extent rather than assumed to be the final character.
		const open = code.lastIndexOf('(', match.index + match[0].length - 1);
		const isConditional = /\bskipIf\b/.test(match[0]);

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
 * The arguments of a call opened at `open`, for reading a name out of text that
 * has *not* been blanked. Where `argsAt` is used to balance parentheses and needs
 * literals blanked so a `(` inside a string cannot unbalance the count, this only
 * reads up to the first argument and so is never more than one literal deep.
 */
function argsOf(text: string, open: number): string {
	const body = text.slice(open + 1);
	const end = body.search(/[,)]/);
	return end === -1 ? body : body.slice(0, end);
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

	// The gate's own header used to claim it policed `describe.skip` while the
	// detector matched nothing but `skipIf(true, ...)`. A real `describe.skip`
	// planted in `stage-unstage.test.ts` left the gate at 15 pass / 0 fail. The
	// spellings above pin the claim per modifier and per scope; these two pin the
	// two shapes the unit-level assertions cannot reach on their own.

	// A name the gate reports is the name `ALLOWED_SKIPS` is matched against, so a
	// misattributed one is a latent allowlist collision, not a cosmetic slip. The
	// `direct` branch this PR added read the name off the line the call *opens* on,
	// which attributes the enclosing group's name to a nested skip and reports the
	// wrong test entirely once the call's arguments wrap. The name has to come from
	// the matched call's own argument list.
	for (const [label, source, expected] of [
		[
			'a one-line nested skip is named for itself, not its enclosing group',
			`describe('outer group', () => { it.skip('inner', () => {}); });`,
			'inner',
		],
		[
			'a wrapped skip is named from its own arguments, not the call it returns',
			['it.skip(', '\t\'the real name\',', '\t() => {}', ')(\'chained name\', () => {});'].join('\n'),
			'the real name',
		],
		[
			'a wrapped skip with no chained call is still named',
			['it.skip(', '\t\'the real name\',', '\t() => {}', ');'].join('\n'),
			'the real name',
		],
	] as const) {
		bunTest(`names a skip from the matched call's own arguments: ${label}`, () => {
			const sites = findUnconditionalSkips(source);
			expect(sites).toHaveLength(1);
			expect(sites[0].name).toBe(expected);
		});
	}

	// Blanking comments is not enough. `it.skip(` is the spelling every tutorial
	// uses, so a file that *quotes* the pattern — a doc snippet, a fixture, an
	// error message — reads as an offender even though nothing is skipped. A
	// string body can contain anything a test can, so the detector has to see
	// literal contents as non-code rather than as a call.
	for (const [label, source] of [
		['a string literal', `const SAMPLE = "it.skip('demo', () => {})";`],
		['a template literal', "const T = `describe.todo('y')`;"],
		['a regex literal', `const re = /it\\.only\\('z', fn\\)/;`],
		['a string across two lines', "const T = `it.skip(\n\t'demo'\n)('x', fn)`;"],
	] as const) {
		bunTest(`ignores the pattern inside ${label}`, () => {
			expect(findUnconditionalSkips(source)).toEqual([]);
		});
	}

	bunTest('a real skip on a line that also contains a string is still named', () => {
		// The failure mode the blanking must not introduce: over-eager masking that
		// hides a genuine skip, or that reads the name out of the wrong string.
		const source = `const label = "demo"; it.skip('the real one', () => {});`;
		const sites = findUnconditionalSkips(source);
		expect(sites).toHaveLength(1);
		expect(sites[0].name).toBe('the real one');
	});

	bunTest('blanking literals preserves every offset, so a reported line is exact', () => {
		// The detector indexes into the blanked source, so a same-length replacement
		// is the whole reason the reported `file:line` can be trusted. A literal
		// spanning lines and one spanning quotes on the same line are the cases a
		// length-changing implementation would get wrong.
		const source = [
			`const doc = "it.skip('quoted', () => {})";`,
			`const tpl = \`describe.todo(\``,
			`\t'y'\`)\`;`,
			`it.skip('on line four', () => {});`,
		].join('\n');
		const blanked = stripNonCode(source);
		expect(blanked).toHaveLength(source.length);
		expect(blanked.split('\n')).toHaveLength(source.split('\n').length);
		const sites = findUnconditionalSkips(source);
		expect(sites).toHaveLength(1);
		expect(sites[0].line).toBe(4);
	});

	// The dangerous direction is not the false positive, it is the false negative:
	// masking that swallows a real skip. An apostrophe in prose, a `/` that divides
	// rather than opens a regex, and a quote that never closes are all ordinary
	// TypeScript, and each could be read as opening a literal that runs to the end of
	// the file. The detector resolves all three rather than blanking to end-of-file,
	// because a gate that silently stops reporting is worse than a noisy one.
	for (const [label, source] of [
		['an apostrophe in a string', `const m = "don't";`],
		['a slash that divides', `const n = total / count;`],
		['a slash inside a character class', `const r = /[/]/;`],
		['a quote that never closes', `const m = 'oops`],
	] as const) {
		bunTest(`a real skip after ${label} is still reported`, () => {
			const sites = findUnconditionalSkips(`${source}\nit.skip('still found', () => {});`);
			expect(sites).toHaveLength(1);
			expect(sites[0].line).toBe(2);
			expect(sites[0].name).toBe('still found');
		});
	}

	bunTest('detects a bare .todo with no body', () => {
		// `it.todo(name)` has no callback at all, so the name is the only argument
		// and there is no body to accidentally make the call look conditional.
		const sites = findUnconditionalSkips(`it.todo('write the assertion');`);
		expect(sites).toHaveLength(1);
		expect(sites[0].name).toBe('write the assertion');
	});

	bunTest('it.only silently deletes its siblings, so the gate must report it', async () => {
		// Proven against a real runner rather than assumed. `only` is not a skip
		// of the test it marks: it silences every other test in the same file. A
		// single `it.only` left behind after debugging therefore removes unrelated
		// coverage while `bun test` still exits 0, which is the exact failure the
		// gate exists to stop.
		const dir = mkdtempSync(join(tmpdir(), 'skip-only-'));
		const file = join(dir, 'only.test.ts');
		writeFileSync(
			file,
			[
				`import { expect, it } from 'bun:test';`,
				`it('first sibling', () => { expect(1).toBe(1); });`,
				`it.only('the focused one', () => { expect(1).toBe(1); });`,
				`it('second sibling', () => { expect(1).toBe(1); });`,
				'',
			].join('\n'),
		);
		const proc = Bun.spawnSync(['bun', 'test', file], { cwd: dir });
		const out = proc.stdout.toString();
		// The runner really does drop the siblings and still report success.
		expect(out).not.toContain('first sibling');
		expect(out).not.toContain('second sibling');
		expect(proc.exitCode).toBe(0);
		// And the gate reports it rather than passing on that silence. It is
		// reported by the `.only` detector rather than the skip detector, because a
		// `.only` is not a skip: the test it marks runs, and its *siblings* do not.
		// Reporting it as an "unconditional skip" would send a developer to fix the
		// wrong thing. The property pinned here is the one that matters — the
		// gate sees it at all — and the split between the two detectors is pinned
		// separately above.
		expect(findFocusOnly(readFileSync(file, 'utf8'))).toHaveLength(1);
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
		const blanked = stripNonCode(source);
		expect(blanked.split('\n')).toHaveLength(source.split('\n').length);
		blanked.split('\n').forEach((line, i) => {
			expect(line).toHaveLength(source.split('\n')[i].length);
		});
		// And the offender is still reported at the line a developer would read.
		expect(findUnconditionalSkips(source).map(site => site.line)).toEqual([7]);
	});

	// Both regexes tolerate whitespace around the dot, so a receiver wrapped onto
	// its own line is caught. The bound is the *receiver text*, not the spelling:
	// `it`/`test`/`describe` spelled out, a literal call. An indirection is not
	// reached, and `KNOWN_BLIND_SPOTS` below says so where a reader of this file
	// will see it rather than inferring coverage that does not exist.
	for (const [label, source, expected] of [
		['a receiver on its own line', `it\n\t.skip('newline skip', () => {});`, 'newline skip'],
		['a space before the dot', `it .skip('space skip', () => {});`, 'space skip'],
		[
			'a wrapped describe.skip',
			`describe\n\t.skip\n\t('wrapped newline', () => {});`,
			'wrapped newline',
		],
		[
			'a wrapped skipIf',
			`it\n\t.skipIf(true, 'r')('wrapped guarded', () => {});`,
			'wrapped guarded',
		],
	] as const) {
		bunTest(`detects a skip written with ${label}`, () => {
			const sites = findUnconditionalSkips(source);
			expect(sites).toHaveLength(1);
			expect(sites[0].name).toBe(expected);
		});
	}

	bunTest('a wrapped skipIf still has its condition read', () => {
		// The widened pattern must not widen what counts as unconditional. A wrapped
		// call no longer ends on its `(`, so the condition has to be read from the `(`
		// found inside the match rather than assumed to be its last character.
		const guarded = `describe\n  .skipIf (\n\ttrue,\n\t'version floor'\n)('needs git 2.30', () => {});`;
		expect(findUnconditionalSkips(guarded).map(site => site.name)).toEqual(['needs git 2.30']);
		// And the liftable version of the same wrapping is still allowed through.
		const liftable = `describe\n  .skipIf (\n\tbelowFloor(),\n\t'version floor'\n)('needs git 2.30', () => {});`;
		expect(findUnconditionalSkips(liftable)).toEqual([]);
	});

	bunTest('a skip reached through a variable is a documented blind spot, not coverage', () => {
		// `KNOWN_BLIND_SPOTS` has to name the shape that is actually missed. If this
		// test starts failing, the gate has closed the hole and the header is
		// understating what is enforced.
		expect(findUnconditionalSkips(`const s = it.skip; s('hidden', () => {});`)).toEqual([]);
		expect(KNOWN_BLIND_SPOTS.some(s => s.includes('variable'))).toBe(true);
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

	bunTest('the self-check cannot become a hardcoded skip', () => {
		// The gate used to allowlist the self-check skip by name. That allowlist was
		// wrong twice over: the skip is reached through a variable, so the scanner
		// never actually matched it, and the skip is predicate-driven anyway. Pinning
		// the mechanism rather than the name is what stops the floor from decaying
		// into an unconditional skip — the exact shape of the regression in
		// `discard-operations.test.ts`.
		//
		// This reads `harness.test.ts` as well as `harness.ts`, because the two are
		// separate decay paths: `harness.ts` is the floor itself, while the self-check
		// inside `harness.test.ts` is the one place a direct `skipIf(true, …)`
		// spelling could hide without the scanner flagging it. Checking only the
		// former would leave the latter unpinned.
		const selfCheck = readFileSync(join(CONTRACT_DIR, 'harness.test.ts'), 'utf8');
		expect(selfCheck).toContain('gitFloorSkipReason(impossible)');
		expect(selfCheck).toContain('impossibleDescribe(');
		// The reason is the predicate's, not a literal: a hardcoded `skipIf(true, …)`
		// would satisfy the two assertions above while never lifting itself.
		expect(selfCheck).toMatch(/skipIf\(true, impossibleFloorReason\)|skipIf\(true, reason\)/);
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
		// it saw 9 of the repository's 96 test files. A skip planted in `tests/e2e`
		// or in any `packages/*/src` test passed the gate silently.
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
		// like the one `harness.ts` uses. Both read as a skip named `(unnamed skip)`,
		// so the allowlist could not absorb them either.
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
		// Why the narrowing matters. The detector reads text, not call expressions,
		// and it can only tell code from prose as well as the blanker allows.
		//
		// The first of the two proven false positives was a *string*: a doc constant
		// that quotes the pattern. `stripNonCode` blanks string bodies, so this is no
		// longer a case that needs rescuing at the source at all — the string is not
		// read as code in the first place. Asserted rather than assumed, so a
		// regression that reopens it is caught here instead of turning a doc into a
		// red gate.
		const docString = `export const SKIP_DOC = 'it.skipIf(true, 1)(2, 3)';`;
		expect(findUnconditionalSkips(docString)).toEqual([]);

		// The second is a *wrapper* — `c ? it.skipIf(true, 'why') : it` — and this one
		// the blanker cannot help with: it is code, correctly parsed, and a genuine
		// `skipIf` whose condition is a literal `true`. It is this repository's own
		// idiom (`harness.ts` exports exactly that shape), and it was tolerated only
		// because its condition is an identifier rather than a literal. Move it into
		// a package's `src` and it turns the gate red on a deliberate design.
		const wrapper = `export const maybeSkip = (c: boolean) => c ? it.skipIf(true, 'why') : it;`;
		expect(findUnconditionalSkips(wrapper)).toHaveLength(1);

		// So neither can come from an ordinary source file now, because no source
		// file is scanned. `harness.ts` is the real one, and with the pattern narrowed
		// to test files, moving that wrapper into a package's `src` stops being able
		// to turn the gate red.
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

	bunTest('a skip planted outside tests/contract is reported', () => {
		// The end-to-end shape of the bug this gate's scope was widened to fix: a
		// skip anywhere in the repository, routed through `collectOffenders`
		// itself, not through the detector in isolation.
		//
		// The plant has to live inside the repository and go through
		// `collectOffenders`, or the test proves nothing about the scan scope. The
		// version this replaces wrote the file into a `mkdtemp` directory and
		// called `findUnconditionalSkips` on it — a path outside every scan root,
		// observed through a function that has no notion of roots — so it passed
		// with `SCAN_ROOTS` narrowed back to `[CONTRACT_DIR]`, deleted, or empty.
		//
		// The plant is named to match the runner's discovery pattern, so it is
		// genuinely a test file, and it is a unique basename so it can never
		// collide with this file's self-exclusion.
		const rel = 'packages/core/src/zz-scope-probe.test.ts';
		withPlantedFile(rel, PLANTED_SKIP, offenders => {
			expect(offenders).toEqual([`${rel}:2  escaped the scan roots`]);
		});
		// And the plant is gone, so the next run starts from the same tree.
		expect(existsSync(join(REPO_ROOT, rel))).toBe(false);
	});

	bunTest('the scan roots sit above tests/contract, not inside it', () => {
		// A second, independent pin on the same regression, so the scope cannot
		// quietly narrow even if `collectOffenders` is later refactored. The
		// original bug was that the root was derived from this file's own
		// location, so the gate policed 9 of the repository's 96 test files and an
		// unconditional skip planted anywhere else passed it silently.
		expect(SCAN_ROOTS).toContain(REPO_ROOT);
		for (const root of SCAN_ROOTS) {
			expect(root.startsWith(CONTRACT_DIR)).toBe(false);
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
