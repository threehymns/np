/**
 * A filename that looks like a git pathspec must be treated as one literal path.
 *
 * A bare `--` ends git's option parsing but does not disable pathspec magic, so
 * a filename beginning with `:(`, `:!` or `glob:` is otherwise parsed as a magic
 * pathspec and resolves to a different set of paths. The measured damage on a
 * real repository (git 2.55):
 *
 *   - `git add -- ':(exclude)base.txt'` staged *every* untracked file, because
 *     the pathspec reads as "everything except base.txt".
 *   - `git clean -fd -- ':(exclude)base.txt'` deleted *every* untracked file
 *     except one named `base.txt` — discarding a single file destroyed
 *     unrelated work that existed nowhere else.
 *   - `git checkout HEAD -- ':(exclude)base.txt'` discarded every staged change
 *     in the repository, not just the requested one.
 *
 * `:(literal)` restores the intended meaning and is a no-op for an ordinary
 * filename. These cases pin that the adapter applies it to every operation
 * taking a user-supplied path, exercised against the real git CLI so a wiring
 * regression is observable.
 *
 * `IsomorphicGitAdapter` is deliberately not included: it calls isomorphic-git's
 * JS API rather than a CLI, so pathspec magic never applies to it and the
 * defect is desktop-only.
 */
import { expect } from 'bun:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import type { FileOrigin } from '@np/core';
import { SpawnGitAdapter } from '../../apps/desktop/src/renderer/SpawnGitAdapter';
import type { GitFileAccess } from '../../apps/desktop/src/renderer/SpawnGitAdapter';
import {
	TestRepo,
	createTrackedRepo,
	describe,
	it,
	seedCommit,
	worktreeContents
} from './harness';

const nodeFileAccess: GitFileAccess = {
	readFile: (filePath) => readFile(filePath),
	writeFile: (filePath, content) => writeFile(filePath, content),
	deleteEntry: (filePath) => rm(filePath, { force: true })
};

/**
 * A filename that is valid magic pathspec syntax, so an unwrapped path is
 * parsed as a pathspec rather than as a name.
 */
const MAGIC = ':(exclude)base.txt';

/** An ordinary filename, which must keep working exactly as before. */
const PLAIN = 'plain.txt';

function origin(r: TestRepo): FileOrigin {
	return { scheme: 'file', path: r.path, name: 'repo' };
}

function adapterFor(r: TestRepo): SpawnGitAdapter {
	return new SpawnGitAdapter(origin(r), (workingDir, args) => r.git(args), nodeFileAccess);
}

/** A repo with one commit, holding committed `MAGIC` and `PLAIN` files. */
async function repoWithTrackedMagicFile(): Promise<TestRepo> {
	const repo = await createTrackedRepo();
	await seedCommit(repo);
	await repo.write(MAGIC, 'magic\n');
	await repo.write(PLAIN, 'plain\n');
	await repo.git(['add', '-A']);
	await repo.git(['commit', '-q', '-m', 'add magic and plain']);
	return repo;
}

/** A repo with one commit, holding an untracked `MAGIC` file and a bystander. */
async function repoWithUntrackedMagicFile(): Promise<TestRepo> {
	const repo = await createTrackedRepo();
	await seedCommit(repo);
	await repo.write(MAGIC, 'magic\n');
	await repo.write('IMPORTANT_UNTRACKED.txt', 'precious\n');
	return repo;
}

/** Stage an edit to both `MAGIC` and `PLAIN`, so per-file scoping is observable. */
async function stageEditsToBoth(repo: TestRepo): Promise<void> {
	await repo.write(MAGIC, 'magic edited\n');
	await repo.write(PLAIN, 'plain edited\n');
	await repo.git(['add', '-A']);
}

/** The index/worktree status letters for `filepath`, or undefined when unchanged. */
async function xy(repo: TestRepo, filepath: string): Promise<string | undefined> {
	const status = await repo.git(['status', '--porcelain=v1', '-z', '-uall']);
	if (status.code !== 0 || !status.stdout) return undefined;
	for (const entry of status.stdout.split('\0')) {
		if (entry.length < 4) continue;
		if (entry.slice(3) === filepath) return entry.slice(0, 2);
	}
	return undefined;
}

describe('SpawnGitAdapter — a pathspec-magic filename is one literal path', () => {
	it('stageFile stages only the named file, not every untracked file', async () => {
		const repo = await repoWithUntrackedMagicFile();
		await repo.write('OTHER_UNTRACKED.txt', 'other\n');
		await repo.write('nested/deep.txt', 'deep\n');

		await adapterFor(repo).stageFile(MAGIC);

		// Only the requested file is staged. Unwrapped, the magic pathspec reads as
		// "everything except base.txt" and stages all four.
		expect(await xy(repo, MAGIC)).toBe('A ');
		expect(await xy(repo, 'OTHER_UNTRACKED.txt')).toBe('??');
		expect(await xy(repo, 'IMPORTANT_UNTRACKED.txt')).toBe('??');
		expect(await xy(repo, 'nested/deep.txt')).toBe('??');
	});

	it('stageFile still stages an ordinary filename', async () => {
		const repo = await createTrackedRepo();
		await seedCommit(repo);
		await repo.write(PLAIN, 'plain\n');
		await repo.write('unrelated.txt', 'unrelated\n');

		await adapterFor(repo).stageFile(PLAIN);

		expect(await xy(repo, PLAIN)).toBe('A ');
		expect(await xy(repo, 'unrelated.txt')).toBe('??');
	});

	it('discarding an untracked magic-named file leaves other untracked files alone', async () => {
		const repo = await repoWithUntrackedMagicFile();

		await adapterFor(repo).discardChanges(MAGIC);

		// The named file is gone...
		expect(await worktreeContents(repo, MAGIC)).toBeNull();
		// ...and the bystander the user never mentioned survives. Unwrapped, the
		// clean deletes it: that is the data loss this pins.
		expect(await worktreeContents(repo, 'IMPORTANT_UNTRACKED.txt')).toBe('precious\n');
	});

	it('discarding a staged change to a magic-named file discards only that file', async () => {
		const repo = await repoWithTrackedMagicFile();
		await stageEditsToBoth(repo);

		await adapterFor(repo).discardChanges(MAGIC, { staged: true });

		// The magic file's staged change is discarded...
		expect(await xy(repo, MAGIC)).toBeUndefined();
		// ...and the plain file keeps its staged change. Unwrapped, `checkout HEAD`
		// matches every path but base.txt and discards this one too.
		expect(await xy(repo, PLAIN)).toBe('M ');
	});

	it('discarding unstaged edits in a magic-named file preserves other worktree edits', async () => {
		const repo = await repoWithTrackedMagicFile();
		await stageEditsToBoth(repo);
		// Now both also differ from the index in the worktree.
		await repo.write(MAGIC, 'magic worktree 2\n');
		await repo.write(PLAIN, 'plain worktree 2\n');

		await adapterFor(repo).discardChanges(MAGIC, { staged: false });

		// The magic file's worktree copy is back to its staged version...
		expect(await worktreeContents(repo, MAGIC)).toBe('magic edited\n');
		// ...and the plain file's worktree edit is untouched.
		expect(await worktreeContents(repo, PLAIN)).toBe('plain worktree 2\n');
	});

	it('unstageFile unstages only the named magic-named file', async () => {
		const repo = await repoWithTrackedMagicFile();
		await stageEditsToBoth(repo);

		await adapterFor(repo).unstageFile(MAGIC);

		// The named file is now unstaged-only...
		expect(await xy(repo, MAGIC)).toBe(' M');
		// ...while the other staged change is still staged.
		expect(await xy(repo, PLAIN)).toBe('M ');
	});

	it('discardAll removes the enumerated untracked files, magic-named ones included', async () => {
		// A tracked file, so `restore --staged --worktree .` inside discardAll has
		// something to match; an empty commit makes that pathspec match nothing.
		const repo = await createTrackedRepo();
		await repo.write('tracked.txt', 'tracked\n');
		await repo.git(['add', '-A']);
		await repo.git(['commit', '-q', '-m', 'seed']);
		await repo.write(MAGIC, 'magic\n');
		await repo.write('junk.txt', 'junk\n');

		await adapterFor(repo).discardAll();

		// Every untracked file is removed — that is what discardAll means. Unwrapped,
		// the first magic pathspec excludes the rest of the list and nothing is
		// removed at all.
		expect(await worktreeContents(repo, MAGIC)).toBeNull();
		expect(await worktreeContents(repo, 'junk.txt')).toBeNull();
		expect(await worktreeContents(repo, 'IMPORTANT_UNTRACKED.txt')).toBeNull();
	});

	it('discardAll leaves tracked files alone', async () => {
		const repo = await repoWithTrackedMagicFile();
		await repo.write('junk.txt', 'junk\n');

		await adapterFor(repo).discardAll();

		expect(await worktreeContents(repo, 'junk.txt')).toBeNull();
		expect(await worktreeContents(repo, MAGIC)).toBe('magic\n');
		expect(await worktreeContents(repo, PLAIN)).toBe('plain\n');
	});

	it('an ordinary filename is unaffected end to end', async () => {
		const repo = await repoWithTrackedMagicFile();
		await stageEditsToBoth(repo);

		await adapterFor(repo).unstageFile(PLAIN);

		expect(await xy(repo, PLAIN)).toBe(' M');
		// The magic-named sibling is untouched by operating on the plain one.
		expect(await xy(repo, MAGIC)).toBe('M ');
	});
});
