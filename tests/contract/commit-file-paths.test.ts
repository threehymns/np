/**
 * `getCommits` must return real pathnames, not git's C-quoted display form.
 *
 * `git log --name-only` was invoked *without* `-z`. Without `-z`, git C-quotes
 * any path containing a character it considers unusual — a newline, tab, double
 * quote, or a non-ASCII byte — escaping it as `"two\nlines.txt"`. That quoted
 * form is a display convention, not a path, and the adapter passed it straight
 * through, so the commit list offered the user a name that resolves to no file.
 *
 * The note below records why the rest of the file's `-z` usage did not catch
 * this: every `git status` call uses `--porcelain=v1 -z -uall`, which never
 * quotes, and this one call did not. An audit that correctly cleared the status
 * paths therefore said nothing about this one.
 *
 * Two details make the obvious one-line fix wrong, and both are exercised below:
 *
 *  1. Simply unquoting is not enough. The old parse was line-oriented, so once
 *     the escape was decoded into a real newline, `two\nlines.txt` split into
 *     two bogus entries. The block format itself had to change.
 *  2. With `-z`, git NUL-delimits *every* record — the paths are not
 *     newline-separated, and the commit boundary is the next NUL-prefixed header
 *     rather than the end of a line. A parser that still split on newlines
 *     silently dropped the real path names.
 *
 * The browser adapter is unaffected: it walks each commit's tree and reads entry
 * names directly, so it already returns real paths. That divergence is itself
 * the bug report — the same repository yields different `files` arrays depending
 * on which adapter is in use.
 */
import { expect } from 'bun:test';
import type { FileOrigin } from '@np/core';
import { SpawnGitAdapter } from '../../apps/desktop/src/renderer/SpawnGitAdapter';
import { TestRepo, createTrackedRepo, describe, it, nodeFileAccess, runGit } from './harness';

function adapterFor(repo: TestRepo): SpawnGitAdapter {
	const origin: FileOrigin = { scheme: 'file', path: repo.path, name: 'repo' };
	return new SpawnGitAdapter(origin, (workingDir, args) => runGit(workingDir, repo.env, args), nodeFileAccess);
}

/**
 * Every path the single commit introduced, enumerated by git itself.
 *
 * `ls-tree --name-only` is newline-delimited and C-quotes, so it fails on
 * exactly the names under test. `ls-files` is already NUL-terminated with no
 * quoting at all, and listing the tree does the same job: the repository holds
 * one commit whose tree is precisely the set of paths introduced.
 * Returns a `Set` so the assertion compares membership, not git's ordering.
 */
function onlyCommitFiles(repo: TestRepo): Set<string> {
	const raw = runGitSync(repo, ['ls-files', '-z', '--full-name', '--with-tree=HEAD']);
	return new Set(raw.split('\0').filter(Boolean));
}

function runGitSync(repo: TestRepo, args: string[]): string {
	// A tiny synchronous read is enough for assertions; the async runner is used
	// by the adapter itself.
	const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
	const res = spawnSync('git', args, { cwd: repo.path, env: repo.env, encoding: 'utf8' });
	if (res.status !== 0) throw new Error(res.stderr);
	return res.stdout;
}

/** Raw `getCommits` output, with or without the `-z` the fix relies on. */
function rawLog(repo: TestRepo, nul: boolean): string {
	const args = ['log'];
	if (nul) args.push('-z');
	args.push('-n', '1', '--date=short', '--pretty=format:%x00%h|%an <%ae>|%ad|%s', '--name-only', '--no-renames');
	return runGitSync(repo, args);
}

describe('getCommits returns unquoted pathnames', () => {
	it('premise: without -z, git C-quotes these paths; with -z it does not', async () => {
		// Without this, the tests below could pass because git stopped quoting,
		// which would mean the bug had silently disappeared rather than been fixed.
		const repo = await createTrackedRepo();
		try {
			await repo.write('two\nlines.txt', 'b\n');
			await repo.write('has\ttab.txt', 'c\n');
			await repo.git(['add', '-A']);
			await repo.git(['commit', '-m', 'odd names']);

			const quoted = rawLog(repo, false);
			expect(quoted).toContain('"two\\nlines.txt"');
			expect(quoted).toContain('"has\\ttab.txt"');

			// The corrected invocation emits the real bytes instead, so the fix
			// works by not asking for the quoted form at all.
			const raw = rawLog(repo, true);
			expect(raw).toContain('two\nlines.txt');
			expect(raw).toContain('has\ttab.txt');
			expect(raw).not.toContain('"two\\nlines.txt"');
		} finally {
			await repo.cleanup();
		}
	});

	it('a name containing the field separator is not mistaken for a commit header', async () => {
		// The corrected format packs header fields with `|`, and a path is now raw,
		// so a filename may legitimately contain that separator. Header detection
		// must not depend on field count alone.
		const repo = await createTrackedRepo();
		try {
			await repo.write('a|b|c|d.txt', 'p\n');
			await repo.write('looks|like|2026-01-02.txt', 'q\n');
			await repo.write('ok.txt', 'r\n');
			await repo.git(['add', '-A']);
			await repo.git(['commit', '-m', 'pipes']);

			const commits = await adapterFor(repo).getCommits();
			expect(commits).toHaveLength(1);
			expect(commits[0].message).toBe('pipes');
			expect([...commits[0].files].sort()).toEqual(
				['a|b|c|d.txt', 'looks|like|2026-01-02.txt', 'ok.txt'].sort()
			);
		} finally {
			await repo.cleanup();
		}
	});

	it('returns the real pathnames, not the quoted display form', async () => {
		const repo = await createTrackedRepo();
		try {
			await repo.write('two\nlines.txt', 'b\n');
			await repo.write('has\ttab.txt', 'c\n');
			await repo.write('quo"te.txt', 'c\n');
			await repo.write('plain.txt', 'd\n');
			await repo.write('café.txt', 'e\n');
			await repo.git(['add', '-A']);
			await repo.git(['commit', '-m', 'odd names']);

			const commits = await adapterFor(repo).getCommits();
			expect(commits).toHaveLength(1);

			// Compared as a set, since --name-only order is git's business.
			expect(new Set(commits[0].files)).toEqual(onlyCommitFiles(repo));
		} finally {
			await repo.cleanup();
		}
	});

	it('every returned path names a file that actually exists', async () => {
		// The user-visible failure: the commit list offers a name, and clicking it
		// resolves to nothing. This asserts resolvability rather than shape.
		const repo = await createTrackedRepo();
		try {
			await repo.write('two\nlines.txt', 'b\n');
			await repo.write('has\ttab.txt', 'c\n');
			await repo.git(['add', '-A']);
			await repo.git(['commit', '-m', 'odd names']);

			const commits = await adapterFor(repo).getCommits();
			for (const file of commits[0].files) {
				expect(await repo.read(file)).not.toBeNull();
			}
			// And no returned name carries git's quoting artifacts.
			for (const file of commits[0].files) {
				expect(file.startsWith('"')).toBe(false);
				expect(file).not.toContain('\\n');
				expect(file).not.toContain('\\t');
			}
		} finally {
			await repo.cleanup();
		}
	});

	it('each of several commits keeps its own files, and the last has none', async () => {
		// The commit boundary is what distinguishes one commit's paths from the
		// next. A trailing commit with no changed files also has to be returned:
		// if the boundary is mishandled, a later commit either inherits an
		// earlier one's files or is dropped from the list altogether.
		const repo = await createTrackedRepo();
		try {
			await repo.write('first.txt', 'a\n');
			await repo.write('shared.txt', 's0\n');
			await repo.git(['add', '-A']);
			await repo.git(['commit', '-m', 'first']);

			await repo.write('second.txt', 'b\n');
			await repo.write('shared.txt', 's1\n');
			await repo.git(['add', '-A']);
			await repo.git(['commit', '-m', 'second']);

			// A commit that changes nothing produces no path section at all.
			await repo.git(['commit', '--allow-empty', '-m', 'empty']);

			const commits = await adapterFor(repo).getCommits();
			expect(commits.map((c) => c.message)).toEqual(['empty', 'second', 'first']);
			expect(commits[0].files).toEqual([]);
			expect([...commits[1].files].sort()).toEqual(['second.txt', 'shared.txt']);
			expect([...commits[2].files].sort()).toEqual(['first.txt', 'shared.txt']);
		} finally {
			await repo.cleanup();
		}
	});

	it('an ordinary commit is unaffected', async () => {
		// Guards against a decoder that mangles the common case while fixing the
		// exotic one.
		const repo = await createTrackedRepo();
		try {
			await repo.write('src/app.ts', 'one\n');
			await repo.write('README.md', 'hi\n');
			await repo.git(['add', '-A']);
			await repo.git(['commit', '-m', 'ordinary']);

			const commits = await adapterFor(repo).getCommits();
			expect([...commits[0].files].sort()).toEqual(['README.md', 'src/app.ts']);
			expect(commits[0].message).toBe('ordinary');
		} finally {
			await repo.cleanup();
		}
	});
});
