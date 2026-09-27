import { expect } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileOrigin } from '@np/core';
import { toURI } from '@np/core/storage';
import { IsomorphicGitAdapter, browserHandleRegistry } from '@np/adapters-browser';
import { SpawnGitAdapter } from '../../apps/desktop/src/renderer/SpawnGitAdapter';
import { NodeDirectoryHandle } from './node-fs-handle';
import { TestRepo, currentBranch, describe, gitEnv, it, nodeFileAccess, runGit } from './harness';

/**
 * `init()` under contract.
 *
 * This is the only `VCSAdapter` method that had no contract coverage, and the
 * measurement in `validation/init-default-branch-probe.txt` shows why that gap
 * mattered: the two engines picked different initial branches. `SpawnGitAdapter`
 * ran a bare `git init`, which falls back to git's built-in default when
 * `init.defaultBranch` is unset -- so a repository initialized from the desktop
 * landed on `master`, while `IsomorphicGitAdapter` hardcodes
 * `defaultBranch: "main"`. The suite's own `createTestRepo` had been papering
 * over this with an extra `git symbolic-ref HEAD refs/heads/main`, which is
 * itself evidence the divergence was real and had to be worked around.
 *
 * These tests pin the *semantic* outcome (a repository exists, on `main`, and it
 * is a working repository that can be committed to) rather than the command
 * string, per ADR 0004.
 */

/** The init surface under contract. */
interface InitSurface {
	detect(rootPath: string): Promise<boolean>;
	init(rootPath?: string): Promise<void>;
	getCurrentBranch(): Promise<string | null>;
}

interface Engine {
	name: string;
	adapter(r: TestRepo): InitSurface;
}

const spawnEngine: Engine = {
	name: 'SpawnGitAdapter (real git)',
	adapter(r) {
		return new SpawnGitAdapter(
			{ scheme: 'file', path: r.path, name: 'repo' },
			(workingDir, args) => runGit(workingDir, r.env, args),
			nodeFileAccess
		);
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

const engines: Engine[] = [spawnEngine, isomorphicEngine];

const bareDirectories: TestRepo[] = [];

/**
 * A hermetic directory that is NOT yet a repository.
 *
 * `createTestRepo` runs `git init` itself, so it cannot exercise `init()` -- doing
 * so would test nothing. This builds the same isolated environment the harness
 * uses, minus the init, so the adapter's own `init()` is the only thing that
 * creates the repository.
 */
async function createBareDirectory(): Promise<TestRepo> {
	const root = await mkdtemp(join(tmpdir(), 'np-init-contract-'));
	const path = join(root, 'repo');
	const home = join(root, 'home');
	await mkdir(path);
	await mkdir(home);
	const repo = new TestRepo(root, path, gitEnv(home));
	bareDirectories.push(repo);
	return repo;
}

describe('init()', () => {
	for (const engine of engines) {
		describe(engine.name, () => {
			it('creates a repository on the "main" branch, matching the other engine', async () => {
				const repo = await createBareDirectory();
				const adapter = engine.adapter(repo);

				await adapter.init(repo.path);

				expect(await currentBranch(repo)).toBe('main');
			});

			it('leaves a repository that detect() recognizes as a work tree', async () => {
				const repo = await createBareDirectory();
				const adapter = engine.adapter(repo);

				await adapter.init(repo.path);

				expect(await adapter.detect(repo.path)).toBe(true);
			});

			it('reports the initialized repository through getCurrentBranch()', async () => {
				const repo = await createBareDirectory();
				const adapter = engine.adapter(repo);

				await adapter.init(repo.path);

				expect(await adapter.getCurrentBranch()).toBe('main');
			});

			it('produces a repository that can actually be committed to', async () => {
				const repo = await createBareDirectory();
				const adapter = engine.adapter(repo);

				await adapter.init(repo.path);
				await repo.write('file.txt', 'content\n');
				await repo.git(['add', 'file.txt']);
				const commit = await repo.git(['commit', '-m', 'first']);

				expect(commit.stderr).toBe('');
				expect(commit.code).toBe(0);
				expect(await currentBranch(repo)).toBe('main');
			});

			it('is idempotent: init() on an existing repository preserves its history', async () => {
				const repo = await createBareDirectory();
				const adapter = engine.adapter(repo);

				await adapter.init(repo.path);
				await repo.write('file.txt', 'content\n');
				await repo.git(['add', 'file.txt']);
				await repo.git(['commit', '-m', 'first']);

				// Re-initializing an existing repository must not destroy the commit.
				await adapter.init(repo.path);

				expect(await currentBranch(repo)).toBe('main');
				const log = await repo.git(['log', '--oneline']);
				expect(log.stdout).toContain('first');
			});

			it('never moves HEAD off a branch the user already has work on', async () => {
				const repo = await createBareDirectory();
				const adapter = engine.adapter(repo);

				await adapter.init(repo.path);
				await repo.write('file.txt', 'content\n');
				await repo.git(['add', 'file.txt']);
				await repo.git(['commit', '-m', 'first']);
				// The user switches to their own branch and commits more work there.
				await repo.git(['checkout', '-b', 'my-work']);
				await repo.write('file.txt', 'more work\n');
				await repo.git(['commit', '-am', 'second']);

				await adapter.init(repo.path);

				// The user's branch and its commits must survive re-initialization.
				expect(await currentBranch(repo)).toBe('my-work');
				const log = await repo.git(['log', '--oneline']);
				expect(log.stdout).toContain('second');
			});
		});
	}
});
