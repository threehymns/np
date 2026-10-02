/**
 * `getChanges` must report a recreated-after-staged-delete file as untracked.
 *
 * Delete a tracked file, stage the deletion, then write the file again. Real
 * git reports that as two porcelain entries:
 *
 *     D  f.txt
 *     ?? f.txt
 *
 * The `IsomorphicGitAdapter` folds both into the single `statusMatrix` row
 * `[f.txt, 1, 2, 0]`: still in HEAD, "untracked" in the working tree (2 — because
 * the path left the index), and gone from the index (0). That row is exactly
 * what `isResurrectedAfterStagedDelete` already recognises elsewhere in the
 * same file, so the state is known and identified — it is just not applied in
 * `getChanges`.
 *
 * The unstaged status mapping read `head === 0 && stage === 0` for "untracked",
 * which this row fails: its head is 1. It therefore fell through to
 * `stage === 0 ? 'A'` and reported the recreate as an unstaged *addition*.
 *
 * Why the wrong letter matters, not just cosmetics: np's Git panel keys
 * untracked work off `status === 'U'`. A recreated file shown as `A` is
 * indistinguishable from a file the user has actually staged for addition, so
 * the two states cannot be told apart and the row cannot be acted on correctly.
 * `discardChanges(..., { staged: false })` and the recreate guards in
 * `discard-operations.test.ts` both key off the same distinction.
 *
 * The desktop engine is included so the test pins *parity* rather than one
 * adapter's output: the contract is that both engines agree with real git.
 */
import { expect } from 'bun:test';
import type { FileOrigin, GitChange } from '@np/core';
import { toURI } from '@np/core/storage';
import { IsomorphicGitAdapter, browserHandleRegistry } from '@np/adapters-browser';
import { SpawnGitAdapter } from '../../apps/desktop/src/renderer/SpawnGitAdapter';
import { NodeDirectoryHandle } from './node-fs-handle';
import { TestRepo, checkedGit, createTrackedRepo, describe, it, nodeFileAccess, porcelainStatus, runGit } from './harness';

interface ChangeReads {
	getChanges(): Promise<GitChange[]>;
}

interface Engine {
	name: string;
	adapter(r: TestRepo): ChangeReads;
}

const spawnEngine: Engine = {
	name: 'SpawnGitAdapter (real git)',
	adapter(r) {
		const origin: FileOrigin = { scheme: 'file', path: r.path, name: 'repo' };
		return new SpawnGitAdapter(origin, (workingDir, args) => runGit(workingDir, r.env, args), nodeFileAccess);
	}
};

const isomorphicEngine: Engine = {
	name: 'IsomorphicGitAdapter (isomorphic-git over node fs)',
	adapter(r) {
		const origin: FileOrigin = { scheme: 'browser', path: r.path, name: 'repo' };
		browserHandleRegistry.register(toURI(origin), new NodeDirectoryHandle('repo', r.path));
		return new IsomorphicGitAdapter(origin);
	}
};

const engines: Engine[] = [spawnEngine, isomorphicEngine];

/** Track `f.txt` so the delete/recreate cycle starts from a committed state. */
async function seed(repo: TestRepo): Promise<void> {
	await repo.write('f.txt', 'A\nB\n');
	await checkedGit(repo, ['add', '-A']);
	await checkedGit(repo, ['commit', '-m', 'seed']);
}

/** Delete `f.txt`, stage the deletion, then recreate it with new content. */
async function deleteStageAndRecreate(repo: TestRepo, content: string): Promise<void> {
	await checkedGit(repo, ['rm', '-q', '-f', 'f.txt']);
	await repo.write('f.txt', content);
}

describe('getChanges: a staged deletion whose file was recreated', () => {
	for (const engine of engines) {
		it(`[${engine.name}] reports the recreate as an untracked unstaged change`, async () => {
			const repo = await createTrackedRepo();
			await seed(repo);
			await deleteStageAndRecreate(repo, 'C\n');

			// Oracle: git itself says "staged delete" plus "untracked".
			const oracle = await porcelainStatus(repo);
			const staged = oracle.find((e) => e.path === 'f.txt' && e.x === 'D');
			const untracked = oracle.find((e) => e.path === 'f.txt' && e.y === '?');
			expect(staged).toBeDefined();
			expect(untracked).toBeDefined();

			const changes = await engine.adapter(repo).getChanges();
			const unstaged = changes.find((c) => c.filepath === 'f.txt' && !c.staged);

			expect(unstaged).toBeDefined();
			// `U` is np's spelling of git's `??`. Reporting `A` here would make a
			// recreate indistinguishable from a file the user staged for addition.
			expect(unstaged!.status).toBe('U');
			// The count converges with it, for the same root cause: an untracked file
			// has no HEAD blob to diff against, so both engines count the working tree
			// file's lines. Before the fix the browser engine's row was labelled 'A',
			// kept out of its counting branch, and reported 0.
			expect(unstaged!.additions).toBe(1);
			expect(unstaged!.deletions).toBe(0);
		});

		it(`[${engine.name}] still reports a genuinely staged addition as 'A'`, async () => {
			// The boundary of the fix: an unstaged `A` is correct for a file that
			// is newly created and really untracked-but-staged-for-add is 'A'
			// *staged*. A plain new file staged for addition must not become 'U'.
			const repo = await createTrackedRepo();
			await seed(repo);
			await repo.write('added.txt', 'new\n');
			await checkedGit(repo, ['add', '-A']);

			const changes = await engine.adapter(repo).getChanges();
			const staged = changes.find((c) => c.filepath === 'added.txt');

			expect(staged).toBeDefined();
			expect(staged!.staged).toBe(true);
			expect(staged!.status).toBe('A');
			// Nothing unstaged: a real addition has no working tree delta, so a leaked
			// unstaged row here is exactly the failure this boundary exists to catch.
			expect(changes.find(c => c.filepath === 'added.txt' && !c.staged)).toBeUndefined();
		});

		it(`[${engine.name}] reports a plain untracked file as 'U'`, async () => {
			// The other boundary: a file that was never tracked has head 0 and
			// stage 0, which the old mapping already handled. Pin it so the
			// fix for the head-1 case cannot regress it.
			const repo = await createTrackedRepo();
			await seed(repo);
			await repo.write('brand-new.txt', 'x\n');

			const changes = await engine.adapter(repo).getChanges();
			const untracked = changes.find((c) => c.filepath === 'brand-new.txt');

			expect(untracked).toBeDefined();
			expect(untracked!.status).toBe('U');
		});

		it(`[${engine.name}] reports a staged deletion that was NOT recreated as 'D'`, async () => {
			// A file that is genuinely gone: the recreate never happened, so the
			// row must keep reporting the staged deletion, not a recreate.
			const repo = await createTrackedRepo();
			await seed(repo);
			await checkedGit(repo, ['rm', '-q', '-f', 'f.txt']);

			const changes = await engine.adapter(repo).getChanges();
			const staged = changes.find((c) => c.filepath === 'f.txt' && c.staged);

			expect(staged).toBeDefined();
			expect(staged!.status).toBe('D');
			expect(await repo.read('f.txt')).toBeNull();
			// The working-tree copy is gone, so there is no recreate to report. An unstaged
			// row here would be the fix leaking past the state it names.
			expect(changes.find(c => c.filepath === 'f.txt' && !c.staged)).toBeUndefined();
		});
	}

	it('both engines agree on the recreate status', async () => {
		// Parity is the contract these two adapters share, so assert it directly
		// rather than only through each engine's own expectation.
		const perEngine: Record<string, string | undefined> = {};
		for (const engine of engines) {
			const repo = await createTrackedRepo();
			await seed(repo);
			await deleteStageAndRecreate(repo, 'C\n');
			const changes = await engine.adapter(repo).getChanges();
			perEngine[engine.name] = changes.find((c) => c.filepath === 'f.txt' && !c.staged)?.status;
		}
		const distinct = [...new Set(Object.values(perEngine))];
		expect(distinct).toEqual(['U']);
	});

	it('a recreated file is never reported as an unstaged addition by either engine', async () => {
		// Guards the exact regression: `A` in the *unstaged* slot means a
		// recreate, because a genuine addition is reported in the *staged* slot.
		for (const engine of engines) {
			const repo = await createTrackedRepo();
			await seed(repo);
			await deleteStageAndRecreate(repo, 'C\n');
			const changes = await engine.adapter(repo).getChanges();
			const unstagedAdd = changes.find((c) => c.filepath === 'f.txt' && !c.staged && c.status === 'A');
			expect(unstagedAdd).toBeUndefined();
		}
	});
});
