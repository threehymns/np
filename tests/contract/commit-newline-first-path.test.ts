/**
 * `getCommits` must not split a filename that contains a newline.
 *
 * This is a second defect in the same method that task-013 fixed, and it is
 * NOT caught by the suite that shipped with that fix. The gap is worth stating
 * precisely, because the existing tests do run a newline-named file — they
 * simply never put it in the position that matters.
 *
 * With `-z`, git frames one commit as `\0<header>\n<path>\0<path>\0\0`: the
 * header is followed by a newline, then each path, and the commit ends on a
 * blank record. The parser therefore does:
 *
 *     const [headerLine, ...firstPaths] = record.split('\n');
 *
 * That is correct for every path *except* one that occupies the first slot
 * after the header. A newline inside that path is indistinguishable from the
 * header/paths separator, so `car\nriage.txt` is read as two files — `car` and
 * `riage.txt` — neither of which exists, while the real path is dropped.
 *
 * ## Why the task-013 suite passes
 *
 * Two of its tests should have caught this and do not:
 *
 *  1. `returns the real pathnames, not the quoted display form` compares
 *     `new Set(files)` against the expected set. Splitting one name into two
 *     changes the set's *size*, so a single odd name does fail that check —
 *     but only incidentally, because the file count happens to differ.
 *  2. Its odd names are `two\nlines.txt`, `has\ttab.txt`, `quo"te.txt`,
 *     `plain.txt`, `café.txt`. Git orders tree entries by byte value, and
 *     `two\n…` sorts **last** of the five — after `plain.txt` and even after
 *     `café.txt` (0x63 < 0x74). It therefore never occupies the first slot
 *     after the header, and the split never happens.
 *  3. `every returned path names a file that actually exists` uses the same
 *     repository, so `two\nlines.txt` is again not first and is read whole.
 *
 * Position, not the presence of a newline, is the whole trigger. The test below
 * uses `car\nriage.txt`, whose first byte sorts before `plain.txt`, so git
 * emits it first and the defect fires. The control case proves the same
 * adapter is correct on the same repository when the odd name sorts *last* —
 * which is what makes ordering, rather than any property of the adapter, the
 * variable under test.
 *
 * ## Scope
 *
 * Desktop only. The browser adapter walks each commit's tree and reads entry
 * names structurally, so it is unaffected — verified by execution, and included
 * below as a live control. That divergence is the bug report: the same
 * repository yields different `files` arrays depending on the adapter.
 */
import { expect } from 'bun:test';
import type { FileOrigin, GitCommit } from '@np/core';
import { toURI } from '@np/core/storage';
import { IsomorphicGitAdapter, browserHandleRegistry } from '@np/adapters-browser';
import { SpawnGitAdapter } from '../../apps/desktop/src/renderer/SpawnGitAdapter';
import { TestRepo, createTrackedRepo, describe, it, nodeFileAccess, runGit } from './harness';
import { NodeDirectoryHandle } from './node-fs-handle';

function desktopAdapter(repo: TestRepo): SpawnGitAdapter {
	const origin: FileOrigin = { scheme: 'file', path: repo.path, name: 'repo' };
	return new SpawnGitAdapter(origin, (workingDir, args) => runGit(workingDir, repo.env, args), nodeFileAccess);
}

function browserAdapter(repo: TestRepo): IsomorphicGitAdapter {
	const origin: FileOrigin = { scheme: 'browser', path: repo.path, name: 'repo' };
	browserHandleRegistry.register(toURI(origin), new NodeDirectoryHandle('repo', repo.path));
	return new IsomorphicGitAdapter(origin);
}

/** The single commit's paths, enumerated by git itself, in git's own order. */
async function gitPaths(repo: TestRepo): Promise<string[]> {
	const res = await repo.git(['ls-tree', '-r', '--name-only', '-z', 'HEAD']);
	if (res.code !== 0) throw new Error(res.stderr);
	return res.stdout.split('\0').filter(Boolean);
}

async function oneCommitWith(repo: TestRepo, names: string[]): Promise<void> {
	for (const n of names) await repo.write(n, 'x\n');
	await repo.git(['add', '-A']);
	await repo.git(['commit', '-m', 'odd names']);
}

/** Paths that do not name a real file in the worktree. */
async function unresolvable(paths: string[], repo: TestRepo): Promise<string[]> {
	const bad: string[] = [];
	for (const p of paths) {
		if ((await repo.read(p)) === null) bad.push(p);
	}
	return bad;
}

describe('getCommits does not split a newline out of the first-listed path', () => {
	it('premise: git lists the newline-named path FIRST, so the trigger fires', async () => {
		// Without this, the assertions below could pass for the same reason the
		// task-013 suite passes: the odd name sorts last and never reaches the
		// slot that gets split.
		const repo = await createTrackedRepo();
		try {
			await oneCommitWith(repo, ['car\nriage.txt', 'plain.txt']);
			const paths = await gitPaths(repo);
			expect(paths[0]).toBe('car\nriage.txt');
			expect(paths).toContain('plain.txt');
		} finally {
			await repo.cleanup();
		}
	});

	it('returns the newline-named path intact, not split into two nonexistent names', async () => {
		const repo = await createTrackedRepo();
		try {
			await oneCommitWith(repo, ['car\nriage.txt', 'plain.txt']);
			const commits = await desktopAdapter(repo).getCommits();
			expect(commits).toHaveLength(1);

			// Exact list, in git's order -- not a set. A set comparison is what
			// let the task-013 suite pass: the split changes membership, but a
			// set-shaped assertion over a different number of names fails for
			// the wrong reason, and any future variant that keeps the count
			// equal would fail to notice entirely.
			expect(commits[0].files).toEqual(await gitPaths(repo));

			// The user-visible half: nothing offered names a file that is absent,
			// and the real name is present rather than lost.
			expect(await unresolvable(commits[0].files, repo)).toEqual([]);
			expect(commits[0].files).toContain('car\nriage.txt');
		} finally {
			await repo.cleanup();
		}
	});

	it('control: the same adapter is correct when the odd name sorts LAST', async () => {
		// Identical adapter, identical newline -- only git's ordering differs, and
		// the premise above pins that ordering rather than assuming it. If this
		// failed too, the defect would be "newlines break getCommits" and the fix
		// would be a different one entirely.
		const repo = await createTrackedRepo();
		try {
			await oneCommitWith(repo, ['plain.txt', 'z\nar.txt']);
			const paths = await gitPaths(repo);
			expect(paths[paths.length - 1]).toBe('z\nar.txt');

			const commits = await desktopAdapter(repo).getCommits();
			expect(commits[0].files).toEqual(paths);
		} finally {
			await repo.cleanup();
		}
	});

	it('the browser adapter is unaffected, so the divergence is desktop-only', async () => {
		const repo = await createTrackedRepo();
		try {
			await oneCommitWith(repo, ['car\nriage.txt', 'plain.txt']);
			const commits = await browserAdapter(repo).getCommits();
			expect(commits).toHaveLength(1);
			expect(new Set(commits[0].files)).toEqual(new Set(await gitPaths(repo)));
		} finally {
			await repo.cleanup();
		}
	});
});
