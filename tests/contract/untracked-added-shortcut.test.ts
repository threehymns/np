import { expect } from 'bun:test';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { FileOrigin } from '@np/core';
import { SpawnGitAdapter } from '../../apps/desktop/src/renderer/SpawnGitAdapter';
import {
	TestRepo,
	createTrackedRepo,
	describe,
	indexContents,
	it,
	nodeFileAccess,
	runGit,
	seedCommit,
	worktreeContents
} from './harness';

function origin(r: TestRepo): FileOrigin {
	return { scheme: 'file', path: r.path, name: 'repo' };
}

function adapterFor(repo: TestRepo): SpawnGitAdapter {
	return new SpawnGitAdapter(origin(repo), (workingDir, args) => runGit(workingDir, repo.env, args), nodeFileAccess);
}

/**
 * The `U` and `A` short-circuits in SpawnGitAdapter.getFileDiff() are the two
 * places where a status letter substitutes for real object lookups: an untracked
 * file has no HEAD and no index object, and an added file has no HEAD by
 * definition. Both facts are only correct if the branch passes '' for the
 * content it cannot have.
 *
 * These tests assert that '' directly, so a future edit that reaches for real
 * content in these branches fails loudly instead of silently returning a
 * plausible wrong answer.
 */
describe('the U and A status shortcuts report the content they cannot have', () => {
	// U: porcelain 'U' means the path is untracked. It is in no commit and in no
	// index entry, so both originalContent and stagedContent must be ''.
	// modifiedContent is the worktree file the user actually sees.
	it('an untracked file has an empty original and empty staged side', async () => {
		const repo = await createTrackedRepo();
		const adapter = adapterFor(repo);
		await seedCommit(repo);

		await repo.write('untracked.txt', 'brand new\n');

		// Precondition: the path really is untracked. Without this the test
		// could pass while exercising the general path instead of the shortcut.
		const status = await runGit(repo.path, repo.env, ['status', '--porcelain', '-z', '--', 'untracked.txt']);
		expect(status.code).toBe(0);
		expect(status.stdout).toContain('untracked.txt');
		expect(status.stdout).toContain('??');

		const detail = await adapter.getFileDiff('untracked.txt', { status: 'U' });
		expect(detail.originalContent).toBe('');
		expect(detail.stagedContent).toBe('');
		expect(detail.modifiedContent).toBe('brand new\n');
	});

	// A: porcelain x='A' means the path is a new addition relative to HEAD.
	// HEAD cannot contain it, so originalContent must be ''. The index DOES
	// hold the staged blob, and the worktree holds the unstaged blob.
	it('an added file has an empty original side but real staged and worktree sides', async () => {
		const repo = await createTrackedRepo();
		const adapter = adapterFor(repo);
		await seedCommit(repo);

		await repo.write('added.txt', 'staged version\n');
		await repo.git(['add', 'added.txt']);
		await repo.write('added.txt', 'staged version\nplus an unstaged line\n');

		// Precondition: HEAD really has no such path, and the index really does.
		// runGit returns stdout verbatim, so the trailing newline is part of the
		// content. Asserting the trimmed form here would test nothing.
		const inHead = await runGit(repo.path, repo.env, ['cat-file', '-e', 'HEAD:added.txt']);
		expect(inHead.code).not.toBe(0);
		expect(await indexContents(repo, 'added.txt')).toBe('staged version\n');
		expect(await worktreeContents(repo, 'added.txt')).toBe('staged version\nplus an unstaged line\n');
		// The shortcut is only meaningful for a real 'A'. Assert the porcelain
		// shape so this cannot silently degrade into a modified-tracked-file case.
		const status = await runGit(repo.path, repo.env, ['status', '--porcelain', '-z', '--', 'added.txt']);
		expect(status.code).toBe(0);
		expect(status.stdout.startsWith('AM ')).toBe(true);

		const combined = await adapter.getFileDiff('added.txt', { status: 'A' });
		expect(combined.originalContent).toBe('');
		expect(combined.stagedContent).toBe('staged version\n');
		expect(combined.modifiedContent).toBe('staged version\nplus an unstaged line\n');

		// The staged view must diff index against the same empty HEAD.
		const staged = await adapter.getFileDiff('added.txt', { status: 'A', staged: true });
		expect(staged.originalContent).toBe('');
		expect(staged.modifiedContent).toBe('staged version\n');
	});

	// A staged addition whose worktree copy is gone. This is the shape task-011
	// re-verified by hand. Note the staging step must be a plain `rm`, not
	// `git rm`: `git rm` also drops the index entry, which leaves the path out of
	// porcelain entirely and is NOT the A/D case. Verified against real git.
	it('a staged addition deleted from the worktree has an empty worktree side', async () => {
		const repo = await createTrackedRepo();
		const adapter = adapterFor(repo);
		await seedCommit(repo);

		await repo.write('gone.txt', 'was here\n');
		await repo.git(['add', 'gone.txt']);
		await rm(path.join(repo.path, 'gone.txt'));

		// Precondition: porcelain really is x='A', y='D', and the index still holds it.
		const status = await runGit(repo.path, repo.env, ['status', '--porcelain', '-z', '--', 'gone.txt']);
		expect(status.code).toBe(0);
		expect(status.stdout.startsWith('AD ')).toBe(true);
		expect(await indexContents(repo, 'gone.txt')).toBe('was here\n');
		expect(await worktreeContents(repo, 'gone.txt')).toBeNull();

		const detail = await adapter.getFileDiff('gone.txt', { status: 'A' });
		expect(detail.originalContent).toBe('');
		expect(detail.stagedContent).toBe('was here\n');
		expect(detail.modifiedContent).toBe('');
	});
});
