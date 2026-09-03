import { expect } from 'bun:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import type { FileOrigin, SwitchResult } from '@np/core';
import { toURI } from '@np/core/storage';
import { IsomorphicGitAdapter, browserHandleRegistry } from '@np/adapters-browser';
import { SpawnGitAdapter } from '../../apps/desktop/src/renderer/SpawnGitAdapter';
import type { GitFileAccess } from '../../apps/desktop/src/renderer/SpawnGitAdapter';
import { NodeDirectoryHandle } from './node-fs-handle';
import {
	TestRepo,
	checkoutBranch,
	createTrackedRepo,
	currentBranch,
	describe,
	it,
	indexContents,
	lsFiles,
	porcelainStatus,
	runGit,
	worktreeContents
} from './harness';

function origin(r: TestRepo): FileOrigin {
	return { scheme: 'file', path: r.path, name: 'repo' };
}

const nodeFileAccess: GitFileAccess = {
	readFile: (path) => readFile(path),
	writeFile: (path, content) => writeFile(path, content),
	deleteEntry: (path) => rm(path, { force: true })
};

/** The branch switching surface under contract. */
interface BranchSwitching {
	getCurrentBranch(): Promise<string | null>;
	switchBranch(branchName: string, options?: { dryRun?: boolean }): Promise<SwitchResult>;
}

interface Engine {
	name: string;
	adapter(r: TestRepo): BranchSwitching;
}

const spawnEngine: Engine = {
	name: 'SpawnGitAdapter (real git)',
	adapter(r) {
		return new SpawnGitAdapter(origin(r), (workingDir, args) => runGit(workingDir, r.env, args), nodeFileAccess);
	}
};

const isomorphicEngine: Engine = {
	name: 'IsomorphicGitAdapter (isomorphic-git over node fs)',
	adapter(r) {
		const repoOrigin: FileOrigin = { scheme: 'browser', path: r.path, name: 'repo' };
		browserHandleRegistry.register(toURI(repoOrigin), new NodeDirectoryHandle('repo', r.path));
		return new IsomorphicGitAdapter(repoOrigin);
	}
};

const ENGINES: Engine[] = [spawnEngine, isomorphicEngine];

/** Helper to create a commit in the test repo using git CLI. */
async function commitFiles(r: TestRepo, message: string, files: Record<string, string>): Promise<void> {
	for (const [relPath, content] of Object.entries(files)) {
		await r.write(relPath, content);
	}
	const add = await r.git(['add', '-A']);
	if (add.code !== 0) throw new Error(`git add failed: ${add.stderr}`);
	const commit = await r.git(['commit', '-m', message]);
	if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr}`);
}

/** Helper to create a new branch in the test repo. */
async function createBranch(r: TestRepo, branchName: string): Promise<void> {
	const res = await r.git(['branch', branchName]);
	if (res.code !== 0) throw new Error(`git branch ${branchName} failed: ${res.stderr}`);
}

for (const engine of ENGINES) {
	describe(`${engine.name} — branch switching`, () => {
		describe('no-op and clean switching', () => {
			it('reports no-op when switching to the current branch and changes nothing', async () => {
				const r = await createTrackedRepo();
				await commitFiles(r, 'initial', { 'file.txt': 'base content\n' });
				await r.write('file.txt', 'dirty worktree\n');

				const adp = engine.adapter(r);
				const res = await adp.switchBranch('main');

				expect(res).toEqual({ status: 'noop' });
				expect(await currentBranch(r)).toBe('main');
				expect(await worktreeContents(r, 'file.txt')).toBe('dirty worktree\n');
				expect(await indexContents(r, 'file.txt')).toBe('base content\n');
			});

			it('switches cleanly between branches and updates worktree to match target branch', async () => {
				const r = await createTrackedRepo();
				await commitFiles(r, 'initial', { 'common.txt': 'base\n', 'feature-only.txt': 'v1\n' });
				await createBranch(r, 'feature');

				// Create commit on main
				await commitFiles(r, 'main commit', { 'main-only.txt': 'hello main\n' });

				// Switch to feature branch using adapter
				const adp = engine.adapter(r);
				const res = await adp.switchBranch('feature');

				expect(res).toEqual({ status: 'switched' });
				expect(await currentBranch(r)).toBe('feature');
				expect(await worktreeContents(r, 'common.txt')).toBe('base\n');
				expect(await worktreeContents(r, 'main-only.txt')).toBeNull();
				expect(await lsFiles(r)).toEqual(['common.txt', 'feature-only.txt']);
			});
		});

		describe('carry-forward uncommitted changes (ADR 0001)', () => {
			it('preserves an unstaged modification across branch switch', async () => {
				const r = await createTrackedRepo();
				await commitFiles(r, 'initial', { 'common.txt': 'base\n', 'other.txt': 'other\n' });
				await createBranch(r, 'feature');

				// Commit on feature branch touching other.txt only
				await checkoutBranch(r, 'feature');
				await commitFiles(r, 'feature commit', { 'other.txt': 'other modified on feature\n' });
				await checkoutBranch(r, 'main');

				// Make unstaged dirty edit to common.txt on main
				await r.write('common.txt', 'unstaged dirty edit\n');

				const adp = engine.adapter(r);
				const res = await adp.switchBranch('feature');

				expect(res).toEqual({ status: 'switched' });
				expect(await currentBranch(r)).toBe('feature');
				expect(await worktreeContents(r, 'common.txt')).toBe('unstaged dirty edit\n');
				expect(await indexContents(r, 'common.txt')).toBe('base\n');
				expect(await worktreeContents(r, 'other.txt')).toBe('other modified on feature\n');

				const status = await porcelainStatus(r);
				const commonStatus = status.find(s => s.path === 'common.txt');
				expect(commonStatus).toBeDefined();
				expect(commonStatus?.y).toBe('M');
				expect(commonStatus?.x).toBe(' ');
			});

			it('preserves a staged modification across branch switch', async () => {
				const r = await createTrackedRepo();
				await commitFiles(r, 'initial', { 'common.txt': 'base\n', 'other.txt': 'other\n' });
				await createBranch(r, 'feature');

				// Commit on feature branch touching other.txt only
				await checkoutBranch(r, 'feature');
				await commitFiles(r, 'feature commit', { 'other.txt': 'feature other\n' });
				await checkoutBranch(r, 'main');

				// Stage a modification to common.txt
				await r.write('common.txt', 'staged dirty edit\n');
				await r.git(['add', 'common.txt']);

				const adp = engine.adapter(r);
				const res = await adp.switchBranch('feature');

				expect(res).toEqual({ status: 'switched' });
				expect(await currentBranch(r)).toBe('feature');
				expect(await worktreeContents(r, 'common.txt')).toBe('staged dirty edit\n');
				expect(await indexContents(r, 'common.txt')).toBe('staged dirty edit\n');

				const status = await porcelainStatus(r);
				const commonStatus = status.find(s => s.path === 'common.txt');
				expect(commonStatus).toBeDefined();
				expect(commonStatus?.x).toBe('M');
				expect(commonStatus?.y).toBe(' ');
			});

			it('preserves an untracked file across branch switch', async () => {
				const r = await createTrackedRepo();
				await commitFiles(r, 'initial', { 'common.txt': 'base\n' });
				await createBranch(r, 'feature');

				// Add untracked file
				await r.write('untracked.txt', 'brand new untracked\n');

				const adp = engine.adapter(r);
				const res = await adp.switchBranch('feature');

				expect(res).toEqual({ status: 'switched' });
				expect(await currentBranch(r)).toBe('feature');
				expect(await worktreeContents(r, 'untracked.txt')).toBe('brand new untracked\n');
				expect(await indexContents(r, 'untracked.txt')).toBeNull();

				const status = await porcelainStatus(r);
				const untrackedStatus = status.find(s => s.path === 'untracked.txt');
				expect(untrackedStatus).toBeDefined();
				expect(untrackedStatus?.x).toBe('?');
				expect(untrackedStatus?.y).toBe('?');
			});

			it('preserves a newly staged file across branch switch', async () => {
				const r = await createTrackedRepo();
				await commitFiles(r, 'initial', { 'common.txt': 'base\n' });
				await createBranch(r, 'feature');

				// Add and stage a new file
				await r.write('staged-new.txt', 'new staged content\n');
				await r.git(['add', 'staged-new.txt']);

				const adp = engine.adapter(r);
				const res = await adp.switchBranch('feature');

				expect(res).toEqual({ status: 'switched' });
				expect(await currentBranch(r)).toBe('feature');
				expect(await worktreeContents(r, 'staged-new.txt')).toBe('new staged content\n');
				expect(await indexContents(r, 'staged-new.txt')).toBe('new staged content\n');

				const status = await porcelainStatus(r);
				const newStatus = status.find(s => s.path === 'staged-new.txt');
				expect(newStatus).toBeDefined();
				expect(newStatus?.x).toBe('A');
				expect(newStatus?.y).toBe(' ');
			});

			it('preserves partially staged (staged + unstaged MM) changes across branch switch', async () => {
				const r = await createTrackedRepo();
				await commitFiles(r, 'initial', { 'common.txt': 'base\n' });
				await createBranch(r, 'feature');

				// Stage an edit, then make further unstaged edit
				await r.write('common.txt', 'staged version\n');
				await r.git(['add', 'common.txt']);
				await r.write('common.txt', 'worktree unstaged version\n');

				const adp = engine.adapter(r);
				const res = await adp.switchBranch('feature');

				expect(res).toEqual({ status: 'switched' });
				expect(await currentBranch(r)).toBe('feature');
				expect(await worktreeContents(r, 'common.txt')).toBe('worktree unstaged version\n');
				expect(await indexContents(r, 'common.txt')).toBe('staged version\n');

				const status = await porcelainStatus(r);
				const mmStatus = status.find(s => s.path === 'common.txt');
				expect(mmStatus).toBeDefined();
				expect(mmStatus?.x).toBe('M');
				expect(mmStatus?.y).toBe('M');
			});

			it('preserves a staged deletion across branch switch', async () => {
				const r = await createTrackedRepo();
				await commitFiles(r, 'initial', { 'common.txt': 'base\n', 'to-delete.txt': 'delete me\n' });
				await createBranch(r, 'feature');

				// Stage deletion of to-delete.txt
				await r.git(['rm', 'to-delete.txt']);

				const adp = engine.adapter(r);
				const res = await adp.switchBranch('feature');

				expect(res).toEqual({ status: 'switched' });
				expect(await currentBranch(r)).toBe('feature');
				expect(await worktreeContents(r, 'to-delete.txt')).toBeNull();
				expect(await indexContents(r, 'to-delete.txt')).toBeNull();

				const status = await porcelainStatus(r);
				const delStatus = status.find(s => s.path === 'to-delete.txt');
				expect(delStatus).toBeDefined();
				expect(delStatus?.x).toBe('D');
				expect(delStatus?.y).toBe(' ');
			});

			it('preserves nested directory files across branch switch', async () => {
				const r = await createTrackedRepo();
				await commitFiles(r, 'initial', { 'src/common.txt': 'base\n' });
				await createBranch(r, 'feature');

				// Add unstaged edit in nested dir, staged file in nested dir, and untracked in nested dir
				await r.write('src/common.txt', 'nested unstaged edit\n');
				await r.write('src/staged.txt', 'nested staged\n');
				await r.git(['add', 'src/staged.txt']);
				await r.write('src/nested/untracked.txt', 'deep untracked\n');

				const adp = engine.adapter(r);
				const res = await adp.switchBranch('feature');

				expect(res).toEqual({ status: 'switched' });
				expect(await currentBranch(r)).toBe('feature');
				expect(await worktreeContents(r, 'src/common.txt')).toBe('nested unstaged edit\n');
				expect(await indexContents(r, 'src/common.txt')).toBe('base\n');
				expect(await worktreeContents(r, 'src/staged.txt')).toBe('nested staged\n');
				expect(await indexContents(r, 'src/staged.txt')).toBe('nested staged\n');
				expect(await worktreeContents(r, 'src/nested/untracked.txt')).toBe('deep untracked\n');
			});

			it('preserves a combination of multiple dirty files (staged, unstaged, untracked, deleted) simultaneously', async () => {
				const r = await createTrackedRepo();
				await commitFiles(r, 'initial', {
					'mod-unstaged.txt': 'base1\n',
					'mod-staged.txt': 'base2\n',
					'mod-both.txt': 'base3\n',
					'del-staged.txt': 'base4\n'
				});
				await createBranch(r, 'feature');

				// 1. Unstaged modify
				await r.write('mod-unstaged.txt', 'unstaged change\n');
				// 2. Staged modify
				await r.write('mod-staged.txt', 'staged change\n');
				await r.git(['add', 'mod-staged.txt']);
				// 3. Staged + unstaged (both)
				await r.write('mod-both.txt', 'staged part\n');
				await r.git(['add', 'mod-both.txt']);
				await r.write('mod-both.txt', 'worktree part\n');
				// 4. Staged delete
				await r.git(['rm', 'del-staged.txt']);
				// 5. Untracked file
				await r.write('untracked.txt', 'untracked content\n');
				// 6. Staged new file
				await r.write('added-staged.txt', 'added staged\n');
				await r.git(['add', 'added-staged.txt']);

				const adp = engine.adapter(r);
				const res = await adp.switchBranch('feature');

				expect(res).toEqual({ status: 'switched' });
				expect(await currentBranch(r)).toBe('feature');

				expect(await worktreeContents(r, 'mod-unstaged.txt')).toBe('unstaged change\n');
				expect(await indexContents(r, 'mod-unstaged.txt')).toBe('base1\n');

				expect(await worktreeContents(r, 'mod-staged.txt')).toBe('staged change\n');
				expect(await indexContents(r, 'mod-staged.txt')).toBe('staged change\n');

				expect(await worktreeContents(r, 'mod-both.txt')).toBe('worktree part\n');
				expect(await indexContents(r, 'mod-both.txt')).toBe('staged part\n');

				expect(await worktreeContents(r, 'del-staged.txt')).toBeNull();
				expect(await indexContents(r, 'del-staged.txt')).toBeNull();

				expect(await worktreeContents(r, 'untracked.txt')).toBe('untracked content\n');
				expect(await indexContents(r, 'untracked.txt')).toBeNull();

				expect(await worktreeContents(r, 'added-staged.txt')).toBe('added staged\n');
				expect(await indexContents(r, 'added-staged.txt')).toBe('added staged\n');
			});
		});

		describe('conflict detection and safety (must never destroy work)', () => {
			it('blocks switch when local modified file differs between current and target branch', async () => {
				const r = await createTrackedRepo();
				await commitFiles(r, 'initial', { 'conflict.txt': 'base\n', 'safe.txt': 'safe\n' });
				await createBranch(r, 'feature');

				// Feature branch changes conflict.txt
				await checkoutBranch(r, 'feature');
				await commitFiles(r, 'feature commit', { 'conflict.txt': 'feature modified\n' });
				await checkoutBranch(r, 'main');

				// Main branch makes local uncommitted edit to conflict.txt
				await r.write('conflict.txt', 'local uncommitted work\n');

				const adp = engine.adapter(r);
				const res = await adp.switchBranch('feature');

				expect(res).toEqual({
					status: 'blocked',
					reason: 'conflict',
					files: ['conflict.txt']
				});

				// Safety check: branch did NOT change, worktree did NOT lose work
				expect(await currentBranch(r)).toBe('main');
				expect(await worktreeContents(r, 'conflict.txt')).toBe('local uncommitted work\n');
				expect(await indexContents(r, 'conflict.txt')).toBe('base\n');
			});

			it('preserves non-conflicting dirty files intact when switch is blocked by a conflict', async () => {
				const r = await createTrackedRepo();
				await commitFiles(r, 'initial', { 'conflict.txt': 'base\n', 'safe.txt': 'base-safe\n' });
				await createBranch(r, 'feature');

				await checkoutBranch(r, 'feature');
				await commitFiles(r, 'feature commit', { 'conflict.txt': 'feature modified\n' });
				await checkoutBranch(r, 'main');

				// Main branch has dirty safe.txt (staged) and dirty conflict.txt (unstaged)
				await r.write('safe.txt', 'safe staged edit\n');
				await r.git(['add', 'safe.txt']);
				await r.write('conflict.txt', 'local dirty conflict\n');

				const adp = engine.adapter(r);
				const res = await adp.switchBranch('feature');

				expect(res.status).toBe('blocked');
				if (res.status === 'blocked') {
					expect(res.files).toContain('conflict.txt');
					expect(res.files).not.toContain('safe.txt');
				}

				// Both safe and conflict uncommitted edits must be preserved exactly
				expect(await currentBranch(r)).toBe('main');
				expect(await worktreeContents(r, 'conflict.txt')).toBe('local dirty conflict\n');
				expect(await worktreeContents(r, 'safe.txt')).toBe('safe staged edit\n');
				expect(await indexContents(r, 'safe.txt')).toBe('safe staged edit\n');
			});

			it('blocks switch when local untracked file collides with target branch tracked file', async () => {
				const r = await createTrackedRepo();
				await commitFiles(r, 'initial', { 'base.txt': 'base\n' });
				await createBranch(r, 'feature');

				// Feature branch creates new file collision.txt
				await checkoutBranch(r, 'feature');
				await commitFiles(r, 'feature commit', { 'collision.txt': 'feature content\n' });
				await checkoutBranch(r, 'main');

				// Main branch has untracked file at the same path
				await r.write('collision.txt', 'untracked local content\n');

				const adp = engine.adapter(r);
				const res = await adp.switchBranch('feature');

				expect(res).toEqual({
					status: 'blocked',
					reason: 'conflict',
					files: ['collision.txt']
				});

				// Safety check: untracked local file is NOT overwritten or lost
				expect(await currentBranch(r)).toBe('main');
				expect(await worktreeContents(r, 'collision.txt')).toBe('untracked local content\n');
			});

			it('reports all conflicting files when multiple files differ', async () => {
				const r = await createTrackedRepo();
				await commitFiles(r, 'initial', { 'c1.txt': 'base1\n', 'c2.txt': 'base2\n', 'ok.txt': 'ok\n' });
				await createBranch(r, 'feature');

				await checkoutBranch(r, 'feature');
				await commitFiles(r, 'feature commit', { 'c1.txt': 'feat1\n', 'c2.txt': 'feat2\n' });
				await checkoutBranch(r, 'main');

				await r.write('c1.txt', 'dirty1\n');
				await r.write('c2.txt', 'dirty2\n');

				const adp = engine.adapter(r);
				const res = await adp.switchBranch('feature');

				expect(res.status).toBe('blocked');
				if (res.status === 'blocked') {
					expect(res.reason).toBe('conflict');
					expect(res.files.sort()).toEqual(['c1.txt', 'c2.txt']);
				}

				expect(await currentBranch(r)).toBe('main');
				expect(await worktreeContents(r, 'c1.txt')).toBe('dirty1\n');
				expect(await worktreeContents(r, 'c2.txt')).toBe('dirty2\n');
			});

			it('reports a non-ASCII conflict filename verbatim (unquoted)', async () => {
				const r = await createTrackedRepo();
				await commitFiles(r, 'initial', { 'café.txt': 'base\n' });
				await createBranch(r, 'feature');

				await checkoutBranch(r, 'feature');
				await commitFiles(r, 'feature commit', { 'café.txt': 'feat\n' });
				await checkoutBranch(r, 'main');

				await r.write('café.txt', 'dirty\n');

				const adp = engine.adapter(r);
				const res = await adp.switchBranch('feature');

				expect(res.status).toBe('blocked');
				if (res.status === 'blocked') {
					expect(res.reason).toBe('conflict');
					// Must be the raw (un-C-quoted) path. Regression: the O(1)
					// `git diff --name-only` in SpawnGitAdapter without `-z`
					// returned the C-quoted form ("caf\\303\\251.txt") instead.
					expect(res.files).toEqual(['café.txt']);
				}
				expect(await currentBranch(r)).toBe('main');
			});
		});

		describe('dryRun option', () => {
			it('returns switched for valid switch in dry-run mode without actually switching branches', async () => {
				const r = await createTrackedRepo();
				await commitFiles(r, 'initial', { 'file.txt': 'base\n' });
				await createBranch(r, 'feature');

				const adp = engine.adapter(r);
				const res = await adp.switchBranch('feature', { dryRun: true });

				expect(res).toEqual({ status: 'switched' });
				// Branch is still main!
				expect(await currentBranch(r)).toBe('main');
			});

			it('returns blocked in dry-run mode when conflicts exist', async () => {
				const r = await createTrackedRepo();
				await commitFiles(r, 'initial', { 'file.txt': 'base\n' });
				await createBranch(r, 'feature');

				await checkoutBranch(r, 'feature');
				await commitFiles(r, 'feature edit', { 'file.txt': 'feature content\n' });
				await checkoutBranch(r, 'main');

				await r.write('file.txt', 'local dirty\n');

				const adp = engine.adapter(r);
				const res = await adp.switchBranch('feature', { dryRun: true });

				expect(res).toEqual({
					status: 'blocked',
					reason: 'conflict',
					files: ['file.txt']
				});
				expect(await currentBranch(r)).toBe('main');
			});
		});

		describe('error handling and safety', () => {
			it('returns structured error when target branch does not exist and preserves local work', async () => {
				const r = await createTrackedRepo();
				await commitFiles(r, 'initial', { 'file.txt': 'base\n' });
				await r.write('file.txt', 'dirty work\n');

				const adp = engine.adapter(r);
				const res = await adp.switchBranch('non-existent-branch');

				expect(res.status).toBe('error');
				if (res.status === 'error') {
					expect(res.message).toBeTruthy();
				}
				expect(await currentBranch(r)).toBe('main');
				expect(await worktreeContents(r, 'file.txt')).toBe('dirty work\n');
				expect(await indexContents(r, 'file.txt')).toBe('base\n');
			});
		});
	});
}
