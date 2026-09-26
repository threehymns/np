/**
 * A file deleted and recreated between refreshes must not be reported as deleted.
 *
 * `getFileDiff` short-circuits the worktree read when the combined porcelain
 * status is `D`. That status means "staged deletion". It does NOT mean the file
 * is absent from disk: a user who deletes a file, stages the deletion, and then
 * recreates it gets exactly `D  f.txt` alongside `?? f.txt` from git, and the
 * UI combines those into one entry whose status is `D`.
 *
 * The consequence is unrecoverable data loss. Reporting the worktree as empty
 * makes the editor offer "discard", and discarding writes the HEAD content back
 * over the recreated file — destroying work that was never staged, never
 * committed, and exists nowhere else.
 *
 * The `D` short-circuit is still correct for the common case (the optimization
 * avoids a disk read per deleted file), so these tests pin the boundary: the
 * status is trusted only when the file is genuinely gone from disk.
 */
import { expect } from 'bun:test';
import type { FileOrigin } from '@np/core';
import { SpawnGitAdapter } from '../../apps/desktop/src/renderer/SpawnGitAdapter';
import { TestRepo, createTrackedRepo, describe, it, nodeFileAccess, porcelainStatus, runGit, worktreeContents } from './harness';

function adapterFor(repo: TestRepo): SpawnGitAdapter {
	const origin: FileOrigin = { scheme: 'file', path: repo.path, name: 'repo' };
	return new SpawnGitAdapter(origin, (workingDir, args) => runGit(workingDir, repo.env, args), nodeFileAccess);
}

/** The status the UI derives: the staged entry wins, as in `combineChangesByFilepath`. */
async function uiStatusFor(repo: TestRepo, filepath: string): Promise<'M' | 'A' | 'D' | 'U' | undefined> {
	const all = await porcelainStatus(repo);
	const group = all.filter(e => e.path === filepath);
	const staged = group.find(e => e.x !== '?' && e.x !== ' ');
	return (staged?.x ?? group[0]?.x) as 'M' | 'A' | 'D' | 'U' | undefined;
}

async function seed(repo: TestRepo, content = 'A\nB\n'): Promise<void> {
	await repo.write('f.txt', content);
	const add = await repo.git(['add', '-A']);
	if (add.code !== 0) throw new Error(add.stderr);
	const commit = await repo.git(['commit', '-m', 'seed']);
	if (commit.code !== 0) throw new Error(commit.stderr);
}

describe('getFileDiff: a deleted file that was recreated', () => {
	it('reports the recreated worktree content instead of an empty file', async () => {
		const repo = await createTrackedRepo();
		await seed(repo);
		await repo.git(['rm', '-q', '-f', 'f.txt']);
		await repo.write('f.txt', 'C\n');
		const status = await uiStatusFor(repo, 'f.txt');
		expect(status).toBe('D');

		const detail = await adapterFor(repo).getFileDiff('f.txt', { status });

		expect(detail.modifiedContent).toBe('C\n');
		expect(await worktreeContents(repo, 'f.txt')).toBe('C\n');
	});

	it('still reports an empty worktree for a file that really is gone', async () => {
		const repo = await createTrackedRepo();
		await seed(repo);
		await repo.git(['rm', '-q', '-f', 'f.txt']);
		const status = await uiStatusFor(repo, 'f.txt');
		expect(status).toBe('D');
		expect(await worktreeContents(repo, 'f.txt')).toBeNull();

		const detail = await adapterFor(repo).getFileDiff('f.txt', { status });

		// The optimization still holds: a genuinely deleted file has no content
		// to read, and the diff must still show the whole file as removed.
		expect(detail.modifiedContent).toBe('');
		expect(detail.originalContent).toBe('A\nB\n');
	});

	it('does not resurrect a deleted file when status is omitted entirely', async () => {
		const repo = await createTrackedRepo();
		await seed(repo);
		await repo.git(['rm', '-q', '-f', 'f.txt']);

		// A caller that passes no status must get the truth from disk, which is
		// the empty/absent file — the deleted case.
		const detail = await adapterFor(repo).getFileDiff('f.txt');

		expect(detail.modifiedContent).toBe('');
	});
});
