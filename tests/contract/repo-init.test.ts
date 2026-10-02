import { expect } from 'bun:test';
import type { FileOrigin } from '@np/core';
import { toURI } from '@np/core/storage';
import { IsomorphicGitAdapter, browserHandleRegistry } from '@np/adapters-browser';
import { SpawnGitAdapter } from '../../apps/desktop/src/renderer/SpawnGitAdapter';
import { NodeDirectoryHandle } from './node-fs-handle';
import {
	TestRepo,
	atLeastGit,
	createTrackedDirectory,
	currentBranch,
	describe,
	gitVersion,
	indexContents,
	it,
	nodeFileAccess,
	runGit
} from './harness';

/**
 * `init()` under contract.
 *
 * Each engine uses its own default for a new repository, and neither invents
 * one for a repository that already exists. `SpawnGitAdapter` runs a bare
 * `git init`, so the initial branch is whatever the user's git would pick:
 * `init.defaultBranch` when configured, otherwise git's compiled fallback.
 * `IsomorphicGitAdapter` is not the user's local git -- it cannot read
 * `~/.gitconfig` -- so it carries its own `defaultBranch: "main"`.
 *
 * These tests pin the *semantic* outcome (a repository exists, it is usable,
 * and re-initialization never moves HEAD) rather than the command string, per
 * ADR 0004. The suite's own `createTestRepo` still pins its throwaway
 * repositories to `main` via `symbolic-ref`: that is the harness choosing
 * determinism for every other test file, not product behavior.
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
	/** True when `init()` defers the initial branch to the user's git config. */
	defersToGitConfig: boolean;
}

const spawnEngine: Engine = {
	name: 'SpawnGitAdapter (real git)',
	defersToGitConfig: true,
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
	defersToGitConfig: false,
	adapter(r) {
		const repoOrigin: FileOrigin = { scheme: 'browser', path: r.path, name: 'repo' };
		browserHandleRegistry.register(toURI(repoOrigin), new NodeDirectoryHandle('repo', r.path));
		return new IsomorphicGitAdapter(repoOrigin);
	}
};

const engines: Engine[] = [spawnEngine, isomorphicEngine];

const gitVer = await gitVersion();
// `init.defaultBranch` is only honored by git >= 2.28; below that the config
// is silently ignored and this case would assert a branch git never promised.
const belowDefaultBranchFloor = !atLeastGit(gitVer, { major: 2, minor: 28 });

describe('init()', () => {
	for (const engine of engines) {
		describe(engine.name, () => {
			if (engine.defersToGitConfig) {
				it('creates a repository on git\'s own default branch', async () => {
					const repo = await createTrackedDirectory();
					const adapter = engine.adapter(repo);

					await adapter.init(repo.path);
					const adapterBranch = await currentBranch(repo);
					expect(adapterBranch).not.toBeNull();

					// Oracle: what a bare `git init` picks in this same
					// environment, so the test tracks git rather than a name.
					const oracle = await createTrackedDirectory();
					const init = await oracle.git(['init', '-q']);
					expect(init.code).toBe(0);
					expect(adapterBranch).toBe(await currentBranch(oracle));
				});

				it.skipIf(
					belowDefaultBranchFloor,
					'requires git >= 2.28 for init.defaultBranch (found ' + gitVer.raw + ')'
				)('honours init.defaultBranch when the user configured one', async () => {
					const repo = await createTrackedDirectory();
					// Isolated HOME plus a pinned GIT_CONFIG_GLOBAL, so this
					// cannot leak past the test.
					const config = await repo.git(['config', '--global', 'init.defaultBranch', 'trunk']);
					expect(config.code).toBe(0);

					await engine.adapter(repo).init(repo.path);

					expect(await currentBranch(repo)).toBe('trunk');
				});
			} else {
				it('creates a repository on the "main" branch', async () => {
					const repo = await createTrackedDirectory();
					const adapter = engine.adapter(repo);

					await adapter.init(repo.path);

					// Its own default, not the user's git config, which it
					// cannot see from the browser.
					expect(await currentBranch(repo)).toBe('main');
				});
			}

			it('leaves a repository that detect() recognizes as a work tree', async () => {
				const repo = await createTrackedDirectory();
				const adapter = engine.adapter(repo);

				await adapter.init(repo.path);

				expect(await adapter.detect(repo.path)).toBe(true);
			});

			it('reports the initialized repository through getCurrentBranch()', async () => {
				const repo = await createTrackedDirectory();
				const adapter = engine.adapter(repo);

				await adapter.init(repo.path);

				const branch = await currentBranch(repo);
				expect(branch).not.toBeNull();
				expect(await adapter.getCurrentBranch()).toBe(branch);
			});

			it('produces a repository that can actually be committed to', async () => {
				const repo = await createTrackedDirectory();
				const adapter = engine.adapter(repo);

				await adapter.init(repo.path);
				const branch = await currentBranch(repo);
				await repo.write('file.txt', 'content\n');
				await repo.git(['add', 'file.txt']);
				const commit = await repo.git(['commit', '-m', 'first']);

				expect(commit.stderr).toBe('');
				expect(commit.code).toBe(0);
				expect(await currentBranch(repo)).toBe(branch);
			});

			it('is idempotent: init() on an existing repository preserves its history', async () => {
				const repo = await createTrackedDirectory();
				const adapter = engine.adapter(repo);

				await adapter.init(repo.path);
				const branch = await currentBranch(repo);
				await repo.write('file.txt', 'content\n');
				await repo.git(['add', 'file.txt']);
				await repo.git(['commit', '-m', 'first']);

				// Re-initializing an existing repository must not destroy the commit.
				await adapter.init(repo.path);

				expect(await currentBranch(repo)).toBe(branch);
				const log = await repo.git(['log', '--oneline']);
				expect(log.stdout).toContain('first');
			});

			it('never moves HEAD off a branch the user already has work on', async () => {
				const repo = await createTrackedDirectory();
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

			it('never moves HEAD of a repository that already exists, even with no commits', async () => {
				const repo = await createTrackedDirectory();
				const adapter = engine.adapter(repo);

				// The user ran `git init` themselves and staged a file without
				// committing, so HEAD is unborn. `-c` pins their branch whatever the
				// machine's own `init.defaultBranch` happens to be.
				const init = await repo.git(['-c', 'init.defaultBranch=master', 'init']);
				expect(init.code).toBe(0);
				await repo.write('file.txt', 'staged\n');
				await repo.git(['add', 'file.txt']);
				expect(await currentBranch(repo)).toBe('master');

				await adapter.init(repo.path);

				// An unborn HEAD is exactly the case where nothing is stranded by
				// leaving it alone, and exactly the case where the user has already
				// said which branch they want. git itself does not move it, so
				// neither engine may.
				expect(await currentBranch(repo)).toBe('master');
				expect(await indexContents(repo, 'file.txt')).toBe('staged\n');
			});
		});
	}
});
