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
import type { FileOrigin } from '@np/core';
import { SpawnGitAdapter } from '../../apps/desktop/src/renderer/SpawnGitAdapter';
import {
	TestRepo,
	createTrackedRepo,
	describe,
	it,
	nodeFileAccess,
	porcelainStatus,
	seedCommit,
	worktreeContents
} from './harness';

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
	const entry = (await porcelainStatus(repo)).find(e => e.path === filepath);
	return entry ? `${entry.x}${entry.y}` : undefined;
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
		await repo.write('BYPASSER_UNTRACKED.txt', 'precious\n');

		await adapterFor(repo).discardAll();

		// Every untracked file is removed — that is what discardAll means, and the
		// magic-named file is no exception. Unwrapped, the magic pathspec reads as
		// "everything except base.txt", which spares it and removes nothing.
		expect(await worktreeContents(repo, MAGIC)).toBeNull();
		expect(await worktreeContents(repo, 'junk.txt')).toBeNull();
		expect(await worktreeContents(repo, 'BYPASSER_UNTRACKED.txt')).toBeNull();
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

/**
 * `:(literal)` must not narrow a directory argument to a single file. git treats
 * a pathspec naming a directory as "everything under it", and the wrap has to
 * preserve that, or staging a folder would stop working.
 */
describe('SpawnGitAdapter — a directory path still covers everything under it', () => {
	it('stageFile on a directory stages every file beneath it', async () => {
		const repo = await createTrackedRepo();
		await seedCommit(repo);
		await repo.write('src/a.txt', 'a\n');
		await repo.write('src/deep/b.txt', 'b\n');
		await repo.write('other.txt', 'o\n');

		await adapterFor(repo).stageFile('src');

		expect(await xy(repo, 'src/a.txt')).toBe('A ');
		expect(await xy(repo, 'src/deep/b.txt')).toBe('A ');
		expect(await xy(repo, 'other.txt')).toBe('??');
	});

	it('unstageFile on a directory unstages every file beneath it', async () => {
		const repo = await createTrackedRepo();
		await seedCommit(repo);
		await repo.write('src/a.txt', 'a\n');
		await repo.write('other.txt', 'o\n');
		await repo.git(['add', '-A']);
		await repo.git(['commit', '-q', '-m', 'seed']);
		await repo.write('src/a.txt', 'a2\n');
		await repo.write('other.txt', 'o2\n');
		await repo.git(['add', '-A']);

		await adapterFor(repo).unstageFile('src');

		expect(await xy(repo, 'src/a.txt')).toBe(' M');
		expect(await xy(repo, 'other.txt')).toBe('M ');
	});

	it('discarding an untracked directory removes it and leaves siblings alone', async () => {
		const repo = await createTrackedRepo();
		await seedCommit(repo);
		await repo.write('newdir/x.txt', 'x\n');
		await repo.write('KEEPME.txt', 'keep\n');

		await adapterFor(repo).discardChanges('newdir');

		expect(await worktreeContents(repo, 'newdir/x.txt')).toBeNull();
		expect(await worktreeContents(repo, 'KEEPME.txt')).toBe('keep\n');
	});
});
