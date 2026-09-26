/**
 * `getChanges` must report real line counts for every path, including names git
 * considers unusual.
 *
 * `getChanges` combines two git invocations. `status --porcelain=v1 -z` is
 * NUL-delimited and never quotes, so it yields the *raw* path. `diff --numstat`
 * was invoked *without* `-z`, and without `-z` git C-quotes any path holding a
 * character it considers unusual — a newline, tab, double quote, or a non-ASCII
 * byte. The two streams therefore disagreed about the same file: the status
 * side asked for `two\nlines.txt` while the counts side had only
 * `"two\\nlines.txt"`, the lookup missed, and the change rendered as `+0 -0`
 * for a file that really changed by three added and one deleted line.
 *
 * This is the same class of defect as #213 (commit file paths) and a direct
 * consequence of it: an audit that fixed `git log --name-only` and cleared
 * every `git status` call still had this one call to find, because it is the
 * only place the two quoting conventions meet.
 *
 * `core.quotepath=false` is already passed. It disables quoting for *non-ASCII
 * bytes only* — it does not touch newline, tab, or quote escaping, which is why
 * the flag is not the fix and the test below pins that distinction.
 */
import { expect } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileOrigin, GitChange } from '@np/core';
import { SpawnGitAdapter } from '../../apps/desktop/src/renderer/SpawnGitAdapter';
import { TestRepo, createTrackedRepo, describe, it, nodeFileAccess, runGit } from './harness';

function adapterFor(repo: TestRepo): SpawnGitAdapter {
	const origin: FileOrigin = { scheme: 'file', path: repo.path, name: 'repo' };
	return new SpawnGitAdapter(origin, (workingDir, args) => runGit(workingDir, repo.env, args), nodeFileAccess);
}

/** The change for `path`, or undefined when the change list omits it entirely. */
function changeFor(changes: GitChange[], path: string): GitChange | undefined {
	return changes.find((c) => c.filepath === path);
}

const ODD_NAMES = [
	'two\nlines.txt',
	'has\ttab.txt',
	'quo"te.txt',
	'arrow => name.txt',
	'uniécode.txt',
	'plain.txt'
];

describe('getChanges reports line counts for unusual pathnames', () => {
	it('premise: without -z, git C-quotes these paths; with -z it does not', async () => {
		// Without this, the assertions below could pass because git stopped
		// quoting, which would mean the bug vanished rather than being fixed.
		const repo = await createTrackedRepo();
		try {
			for (const name of ODD_NAMES) await repo.write(name, 'a\n');
			await repo.git(['add', '-A']);
			await repo.git(['commit', '-m', 'odd names']);
			for (const name of ODD_NAMES) await repo.write(name, 'b\nb\nb\n');
			await repo.git(['add', '-A']);

			const quoted = (await repo.git(['-c', 'core.quotepath=false', 'diff', '--cached', '--numstat'])).stdout;
			expect(quoted).toContain('"two\\nlines.txt"');
			expect(quoted).toContain('"has\\ttab.txt"');

			// core.quotepath=false does disable quoting for the non-ASCII name,
			// which is why that one name was never broken. The escape cases above
			// are what remain, and -z is what removes them.
			expect(quoted).toContain('uniécode.txt');
			expect(quoted).not.toContain('"uni\\303\\251code.txt"');

			const raw = (await repo.git(['-c', 'core.quotepath=false', 'diff', '--cached', '--numstat', '-z'])).stdout;
			expect(raw).toContain('two\nlines.txt');
			expect(raw).toContain('has\ttab.txt');
			expect(raw).not.toContain('"two\\nlines.txt"');
		} finally {
			await repo.cleanup();
		}
	});

	it('reports the true counts for a staged name containing a newline', async () => {
		const repo = await createTrackedRepo();
		try {
			await repo.write('two\nlines.txt', 'a\n');
			await repo.git(['add', '-A']);
			await repo.git(['commit', '-m', 'base']);
			await repo.write('two\nlines.txt', 'b\nb\nb\n');
			await repo.git(['add', '-A']);

			const change = changeFor(await adapterFor(repo).getChanges(), 'two\nlines.txt');
			expect(change).toBeDefined();
			expect(change!.status).toBe('M');
			expect(change!.staged).toBe(true);
			// One line became three: three added, one deleted.
			expect(change!.additions).toBe(3);
			expect(change!.deletions).toBe(1);
		} finally {
			await repo.cleanup();
		}
	});

	it('reports the true counts for names containing tab, quote, and non-ASCII bytes', async () => {
		const repo = await createTrackedRepo();
		try {
			const names = ['has\ttab.txt', 'quo"te.txt', 'uniécode.txt', 'plain.txt'];
			for (const name of names) await repo.write(name, 'a\n');
			await repo.git(['add', '-A']);
			await repo.git(['commit', '-m', 'base']);
			for (const name of names) await repo.write(name, 'b\nb\nb\n');
			await repo.git(['add', '-A']);

			const changes = await adapterFor(repo).getChanges();
			for (const name of names) {
				const change = changeFor(changes, name);
				expect(change).toBeDefined();
				expect(change!.additions).toBe(3);
				expect(change!.deletions).toBe(1);
			}
		} finally {
			await repo.cleanup();
		}
	});

	it('reports the true counts for an unstaged name containing a newline', async () => {
		// The unstaged side reads `diff --numstat` (worktree vs index), a
		// separate invocation from the staged side, so it needs its own proof.
		const repo = await createTrackedRepo();
		try {
			await repo.write('two\nlines.txt', 'a\n');
			await repo.git(['add', '-A']);
			await repo.git(['commit', '-m', 'base']);
			await repo.write('two\nlines.txt', 'b\nb\nb\nb\nb\n');

			const change = changeFor(await adapterFor(repo).getChanges(), 'two\nlines.txt');
			expect(change).toBeDefined();
			expect(change!.staged).toBe(false);
			expect(change!.additions).toBe(5);
			expect(change!.deletions).toBe(1);
		} finally {
			await repo.cleanup();
		}
	});

	it('does not mistake a name containing the rename arrow for a rename', async () => {
		// The old parser split any path containing " => " into a rename source and
		// target, in two branches: a brace form
		//
		//     targetPath.replace(/\{.*? => (.*?)\}/, '$1')
		//
		// for git's `dir/{a => b}/file` output, and a plain substring split for
		// everything else. Both mangled a path that legitimately contains the
		// arrow -- `dir{d => d2}/file.txt` collapsed to `dird2/file.txt`, and
		// `zzz => target.txt` collapsed to `target.txt`.
		//
		// A mangled key naming a file that does NOT exist is unobservable:
		// `getChanges` walks porcelain entries, so a phantom key is never read.
		// That is why the old version of this test -- which only asserted that no
		// phantom entry appeared -- could not fail. It passed with the heuristic
		// and without it, which is worth saying plainly: it was guarding nothing.
		//
		// The harm only lands on a *sibling* that really exists, because the two
		// records then share a key and the later one overwrites the earlier. git
		// emits numstat records in path order, so each sibling is named as the
		// exact string the heuristic mangles its arrow file down to, and each sorts
		// first (`d` 0x64 < `{` 0x7b, and `t` < `z`):
		//
		//     "dird2/file.txt"        +4
		//     "dir{d => d2}/file.txt" +8   -> mangles to "dird2/file.txt"
		//     "target.txt"            +3
		//     "zzz => target.txt"     +9   -> mangles to "target.txt"
		//
		// The premise assertion pins that emitted order, so a git that reorders
		// records fails here loudly rather than quietly stripping the teeth from
		// the two count assertions below.
		const repo = await createTrackedRepo();
		try {
			const SIBLING_BRACE = 'dird2/file.txt';
			const ARROW_BRACE = 'dir{d => d2}/file.txt';
			const SIBLING_ARROW = 'target.txt';
			const ARROW_PLAIN = 'zzz => target.txt';
			for (const name of [SIBLING_ARROW, SIBLING_BRACE, ARROW_PLAIN, ARROW_BRACE]) {
				await repo.write(name, 'a\n');
			}
			await repo.git(['add', '-A']);
			await repo.git(['commit', '-m', 'base']);

			// Distinct, non-overlapping line counts, so a clobber is unmistakable
			// rather than a coincidence: the arrow files carry counts no sibling
			// has.
			const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n') + '\n';
			await repo.write(SIBLING_ARROW, lines(3));
			await repo.write(SIBLING_BRACE, lines(4));
			await repo.write(ARROW_PLAIN, lines(9));
			await repo.write(ARROW_BRACE, lines(8));
			await repo.git(['add', '-A']);

			// Premise: git really does emit these four names, in this order.
			// Both arrow files sort after the sibling they mangle onto, so the
			// heuristic would overwrite both siblings' counts.
			const NUL = String.fromCharCode(0);
			const numstat = await repo.git(['diff', '--cached', '--numstat', '-z']);
			const paths = numstat.stdout
				.split(NUL)
				.map((field) => field.slice(field.indexOf('\t', field.indexOf('\t') + 1) + 1))
				.filter(Boolean);
			expect(paths).toEqual([SIBLING_BRACE, ARROW_BRACE, SIBLING_ARROW, ARROW_PLAIN]);

			const changes = await adapterFor(repo).getChanges();

			// Each arrow file keeps its own counts, under its own real name.
			expect(changeFor(changes, ARROW_PLAIN)!.additions).toBe(9);
			expect(changeFor(changes, ARROW_BRACE)!.additions).toBe(8);

			// The discriminating pair. Under the removed heuristic each sibling
			// reads the arrow file's count instead of its own: `target.txt` would
			// report +9 and `dird2/file.txt` would report +8. These two assertions
			// are what make the removal observable; everything above them passes
			// either way.
			expect(changeFor(changes, SIBLING_ARROW)!.additions).toBe(3);
			expect(changeFor(changes, SIBLING_BRACE)!.additions).toBe(4);
		} finally {
			await repo.cleanup();
		}
	});

	it('keeps a pure rename resolving to its destination, not a quoted or split path', async () => {
		// A pure `git mv` of an unmodified file is porcelain `R`, which `getChanges`
		// folds into a single entry for the destination. Content is unchanged, so
		// the counts are legitimately zero -- what matters here is that the entry
		// exists under the real destination name. The old arrow heuristic could
		// also produce this entry, so the fix must not regress it.
		const repo = await createTrackedRepo();
		try {
			await repo.write('old name.txt', 'a\n');
			await repo.git(['add', '-A']);
			await repo.git(['commit', '-m', 'base']);
			await repo.git(['mv', 'old name.txt', 'new name.txt']);

			const changes = await adapterFor(repo).getChanges();
			expect(changeFor(changes, 'new name.txt')).toBeDefined();
			expect(changeFor(changes, 'new name.txt')!.additions).toBe(0);
			expect(changeFor(changes, 'new name.txt')!.deletions).toBe(0);
		} finally {
			await repo.cleanup();
		}
	});

	it('reports zero counts for a binary file rather than NaN', async () => {
		// Git reports `-` for both count fields on a binary file, which is not a
		// number. The change must still carry a usable count, not NaN leaking into
		// the badge. `parseInt('-')` is NaN and `NaN || 0` is 0, so the numeric
		// path alone already yields zero.
		const repo = await createTrackedRepo();
		try {
			// NUL and high bytes are what make git treat the file as binary.
			const blob = (byte: number) => Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, byte]);
			await writeFile(join(repo.path, 'blob.bin'), blob(0x61));
			await repo.git(['add', '-A']);
			await repo.git(['commit', '-m', 'base']);
			await writeFile(join(repo.path, 'blob.bin'), blob(0x7a));
			await repo.git(['add', '-A']);

			const change = changeFor(await adapterFor(repo).getChanges(), 'blob.bin');
			expect(change).toBeDefined();
			expect(Number.isFinite(change!.additions)).toBe(true);
			expect(Number.isFinite(change!.deletions)).toBe(true);
			expect(change!.additions).toBe(0);
			expect(change!.deletions).toBe(0);
		} finally {
			await repo.cleanup();
		}
	});

	it('reports true counts for a paired rename, which is the framing a naive split drops', async () => {
		// A large file that is renamed and barely edited stays above git's
		// similarity threshold, so numstat emits the *paired* record
		// `<add>\t<del>\t\0<source>\0<dest>` with an empty name in the count
		// prefix. Porcelain then reports `RM <dest>`, so the change list asks for
		// the destination. A parser that only reads the rest of the first field
		// finds an empty path and the real counts are lost.
		const repo = await createTrackedRepo();
		try {
			const body = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n') + '\n';
			await repo.write('old.txt', body);
			await repo.write('other.txt', 'x\n');
			await repo.git(['add', '-A']);
			await repo.git(['commit', '-m', 'base']);

			await repo.git(['mv', 'old.txt', 'renamed.txt']);
			await repo.write('renamed.txt', body + 'extra\n');
			await repo.git(['add', '-A']);

			const changes = await adapterFor(repo).getChanges();
			const change = changeFor(changes, 'renamed.txt');
			expect(change).toBeDefined();
			// The paired record's counts attach to the destination, which is the
			// only name porcelain reports. Reading just the first field instead
			// would find an empty path and report +0.
			expect(change!.additions).toBe(1);
			expect(change!.deletions).toBe(0);
		} finally {
			await repo.cleanup();
		}
	});

	it('reports a staged copy through the same paired framing, under diff.renames=copies', async () => {
		// The second framing shape is not rename-only. Under `diff.renames=copies`
		// git emits a *copy* record whose bytes are identical to a rename's:
		// `<add>\t<del>\t\0<source>\0<dest>`. So "rename or copy" in the parser
		// comment is load-bearing, and this pins the claim that was previously
		// assumed.
		//
		// Reaching it is fiddlier than it looks, and three separate probes came
		// back negative first. Each looks like a different bug, so the reasons
		// are kept:
		//
		//  1. A plain `cp` plus `git add` reports `A`, never paired. The source is
		//     unchanged, so it is absent from the diff and there is nothing to
		//     copy from.
		//  2. A staged `git mv` of unchanged content reports `R` even under
		//     `diff.renames=copies` -- and so does `status.renamesCopies`. Copy
		//     detection is only tried after rename detection finds nothing.
		//  3. Editing only the copy still reports `A`. The source has to be in the
		//     diff *and* stay above the similarity threshold, so both sides are
		//     edited.
		const repo = await createTrackedRepo();
		try {
			const body = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n') + '\n';
			await repo.write('source.txt', body);
			await repo.git(['add', '-A']);
			await repo.git(['commit', '-m', 'base']);
			await repo.git(['config', 'diff.renames', 'copies']);
			await repo.write('copied.txt', body);
			await repo.write('source.txt', body + 'to source\n');
			await repo.write('copied.txt', body + 'to copy\n');
			await repo.git(['add', '-A']);

			// Premise: the paired framing really is emitted, source name first.
			// If git changes this, the test must fail rather than quietly stop
			// testing the thing it was written for.
			//
			// Built by joining rather than by writing `'\0'` escapes inline: `'\01'`
			// is parsed as an octal NUL followed by the character `1`, which
			// silently deletes the delimiter and produces a string that looks
			// right in a diff and compares unequal.
			const numstat = await repo.git(['diff', '--cached', '--numstat', '-z']);
			const NUL = String.fromCharCode(0);
			expect(numstat.stdout.split(NUL)).toEqual([
				'1\t0\t', 'source.txt', 'copied.txt', '1\t0\tsource.txt', ''
			]);

			// Porcelain reports the destination as an addition, so the change list
			// asks for `copied.txt` and its counts can only come off the paired
			// record. Under the default config the same destination reads 61
			// added, which is what makes this assertion meaningful.
			const change = changeFor(await adapterFor(repo).getChanges(), 'copied.txt');
			expect(change!.additions).toBe(1);
			expect(change!.deletions).toBe(0);

			// Git names the source twice -- once in the paired record, once as an
			// ordinary record -- with different counts. The destination's number
			// is only available from the paired form, so this is the sharpest
			// version of the same claim.
			await repo.write('source.txt', body + 's1\n');
			await repo.write('copied.txt', body + 'c1\nc2\nc3\n');
			await repo.git(['add', '-A']);

			const both = await adapterFor(repo).getChanges();
			expect(changeFor(both, 'copied.txt')!.additions).toBe(3);
			expect(changeFor(both, 'source.txt')!.additions).toBe(1);
		} finally {
			await repo.cleanup();
		}
	});

	it('reports true counts for a rename whose destination contains a newline', async () => {
		// A rename large enough that git can no longer pair it reports as an
		// addition plus a deletion, and the destination is C-quoted without `-z`
		// -- so the count for the added half was silently lost. With `-z` the
		// destination resolves and the real counts come through.
		const repo = await createTrackedRepo();
		try {
			await repo.write('old.txt', 'a\n');
			await repo.git(['add', '-A']);
			await repo.git(['commit', '-m', 'base']);
			await repo.git(['mv', 'old.txt', 'new\nline.txt']);
			// Renaming plus rewriting the content stops git detecting the pair.
			await repo.write('new\nline.txt', 'b\nb\nb\n');
			await repo.git(['add', '-A']);

			const changes = await adapterFor(repo).getChanges();
			const change = changeFor(changes, 'new\nline.txt');
			expect(change).toBeDefined();
			expect(change!.additions).toBe(3);
			expect(change!.deletions).toBe(0);
		} finally {
			await repo.cleanup();
		}
	});

	it('counts an untracked name with a newline, which numstat never reports', async () => {
		// A different mechanism in the same method: `git diff --numstat` cannot see
		// untracked files at all, so `getChanges` reads them off disk instead. That
		// path is joined into the change list through the same quoting-prone
		// pipeline, so it needs its own proof with an odd name.
		const repo = await createTrackedRepo();
		try {
			await repo.write('base.txt', 'a\n');
			await repo.git(['add', '-A']);
			await repo.git(['commit', '-m', 'base']);
			await repo.write('new\nfile.txt', 'one\ntwo\nthree\n');

			const change = changeFor(await adapterFor(repo).getChanges(), 'new\nfile.txt');
			expect(change).toBeDefined();
			expect(change!.status).toBe('U');
			expect(change!.staged).toBe(false);
			expect(change!.additions).toBe(3);
			expect(change!.deletions).toBe(0);
		} finally {
			await repo.cleanup();
		}
	});

	it('gives a partially staged name both a staged and an unstaged entry', async () => {
		// Porcelain reports `AM` as one record, and `getChanges` emits TWO changes
		// from it -- one counted from the staged numstat and one from the unstaged
		// one. Two independent lookups by the same odd name, which is where a
		// quoting mismatch would show up twice rather than once.
		const repo = await createTrackedRepo();
		try {
			await repo.write('two\nlines.txt', 'a\n');
			await repo.git(['add', '-A']);
			await repo.git(['commit', '-m', 'base']);

			await repo.write('two\nlines.txt', 'b\nb\nb\n');
			await repo.git(['add', '-A']);
			await repo.write('two\nlines.txt', 'b\nb\nb\nc\nd\n');

			const changes = await adapterFor(repo).getChanges();
			const entries = changes.filter((c) => c.filepath === 'two\nlines.txt');
			expect(entries.length).toBe(2);

			const staged = entries.find((c) => c.staged);
			const unstaged = entries.find((c) => !c.staged);
			expect(staged).toBeDefined();
			expect(unstaged).toBeDefined();
			// One line became three in the index...
			expect(staged!.additions).toBe(3);
			expect(staged!.deletions).toBe(1);
			// ...and two more lines were added to the worktree after staging.
			expect(unstaged!.additions).toBe(2);
			expect(unstaged!.deletions).toBe(0);
		} finally {
			await repo.cleanup();
		}
	});

	it('returns no changes for a clean tree, where numstat emits zero bytes', async () => {
		// The empty-output guard in `parseNumstat`. An empty string must not become
		// a key, and the whole method must return cleanly rather than throwing.
		const repo = await createTrackedRepo();
		try {
			await repo.write('two\nlines.txt', 'a\n');
			await repo.write('base.txt', 'a\n');
			await repo.git(['add', '-A']);
			await repo.git(['commit', '-m', 'base']);

			// Verified empirically: on a clean tree both numstat calls write zero
			// bytes and exit 0, so this really is the empty-input path.
			const staged = await repo.git(['diff', '--cached', '--numstat', '-z']);
			expect(staged.code).toBe(0);
			expect(staged.stdout).toBe('');
			const unstaged = await repo.git(['diff', '--numstat', '-z']);
			expect(unstaged.code).toBe(0);
			expect(unstaged.stdout).toBe('');

			expect(await adapterFor(repo).getChanges()).toEqual([]);
		} finally {
			await repo.cleanup();
		}
	});
});
