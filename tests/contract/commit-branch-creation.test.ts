import { expect } from 'bun:test';
import type { FileOrigin, GitCommit } from '@np/core';
import { toURI } from '@np/core/storage';
import { IsomorphicGitAdapter, browserHandleRegistry } from '@np/adapters-browser';
import { SpawnGitAdapter } from '../../apps/desktop/src/renderer/SpawnGitAdapter';
import { NodeDirectoryHandle } from './node-fs-handle';
import {
	TestRepo,
	checkedGit,
	createTrackedRepo,
	currentBranch,
	describe,
	headAuthor,
	it,
	nodeFileAccess,
	porcelainStatus,
	runGit,
	TEST_IDENTITY,
	worktreeContents
} from './harness';

function origin(r: TestRepo): FileOrigin {
	return { scheme: 'file', path: r.path, name: 'repo' };
}

/** The commit and branch creation surface under contract. */
interface CommitAndBranchSurface {
	commit(message: string, options?: { author?: { name: string; email: string }; amend?: boolean }): Promise<void>;
	createBranch(branchName: string): Promise<void>;
	getCurrentBranch(): Promise<string | null>;
	getBranches(): Promise<string[]>;
	getCommits(): Promise<GitCommit[]>;
}

interface Engine {
	name: string;
	adapter(r: TestRepo): CommitAndBranchSurface;
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

/** Configure git user.name and user.email in the repository's .git/config. */
async function setUserConfig(r: TestRepo, name = TEST_IDENTITY.name, email = TEST_IDENTITY.email): Promise<void> {
	const nameRes = await r.git(['config', 'user.name', name]);
	if (nameRes.code !== 0) throw new Error(nameRes.stderr);
	const emailRes = await r.git(['config', 'user.email', email]);
	if (emailRes.code !== 0) throw new Error(emailRes.stderr);
}

/** Local branch reality: `git for-each-ref` over refs/heads, sorted. */
async function oracleBranches(r: TestRepo): Promise<string[]> {
	const res = await r.git(['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
	if (res.code !== 0) throw new Error(res.stderr);
	return res.stdout.split('\n').filter(Boolean).sort();
}

/** Files changed by a commit per `git log --name-only --no-renames`. */
async function oracleCommitFiles(r: TestRepo, hash: string): Promise<string[]> {
	const res = await r.git(['-c', 'core.quotepath=false', 'diff-tree', '--no-commit-id', '--name-only', '-r', '--root', hash]);
	if (res.code !== 0) throw new Error(res.stderr);
	return res.stdout.split('\n').filter(Boolean);
}

/** Commit history reality matching the adapter's getCommits() contract. */
async function oracleCommitLog(r: TestRepo): Promise<GitCommit[]> {
	const res = await r.git(['log', '--date=short', '--format=%h|%an <%ae>|%ad|%s']);
	if (res.code !== 0) throw new Error(res.stderr);
	const commits: GitCommit[] = [];
	for (const line of res.stdout.split('\n').filter(Boolean)) {
		const [hash, author, date, ...rest] = line.split('|');
		commits.push({ hash, author, message: rest.join('|'), date, files: await oracleCommitFiles(r, hash) });
	}
	return commits;
}

/** Parent commit hashes of the HEAD commit (`git log -1 --format=%P`). */
async function headParentHashes(r: TestRepo): Promise<string[]> {
	const res = await r.git(['log', '-1', '--format=%P']);
	if (res.code !== 0) throw new Error(res.stderr);
	return res.stdout.trim().split(/\s+/).filter(Boolean);
}

/** Subject/message of the HEAD commit (`git log -1 --format=%s`). */
async function headSubject(r: TestRepo): Promise<string> {
	const res = await r.git(['log', '-1', '--format=%s']);
	if (res.code !== 0) throw new Error(res.stderr);
	return res.stdout.trim();
}

/** Full object SHA of the HEAD commit. */
async function headRev(r: TestRepo): Promise<string> {
	const res = await r.git(['rev-parse', 'HEAD']);
	if (res.code !== 0) throw new Error(res.stderr);
	return res.stdout.trim();
}

/** Full object SHA of a ref/branch. */
async function refRev(r: TestRepo, ref: string): Promise<string> {
	const res = await r.git(['rev-parse', ref]);
	if (res.code !== 0) throw new Error(res.stderr);
	return res.stdout.trim();
}

/** Initialize a fresh repository with user configuration and a committed initial file. */
async function setupRepoWithInitialCommit(
	engine: Engine,
	fileName = 'init.txt',
	content = 'init\n',
	message = 'init'
): Promise<{ r: TestRepo; adapter: CommitAndBranchSurface; initRev: string }> {
	const r = await createTrackedRepo();
	await setUserConfig(r);
	await r.write(fileName, content);
	const add = await r.git(['add', fileName]);
	if (add.code !== 0) throw new Error(add.stderr);
	const adapter = engine.adapter(r);
	await adapter.commit(message);
	const initRev = await headRev(r);
	return { r, adapter, initRev };
}

for (const engine of [spawnEngine, isomorphicEngine]) {
	describe(`${engine.name} — commit operations`, () => {
		it('commits staged files with a message, matching oracle-verified object contents and history', async () => {
			const r = await createTrackedRepo();
			await setUserConfig(r);
			await r.write('README.md', '# Hello\n');
			await r.write('src/main.ts', 'console.log("main");\n');
			const addRes = await r.git(['add', '-A']);
			if (addRes.code !== 0) throw new Error(addRes.stderr);

			const adapter = engine.adapter(r);
			await adapter.commit('initial repository commit');

			// Semantic outcomes verified against real git
			expect(await currentBranch(r)).toBe('main');
			expect(await headSubject(r)).toBe('initial repository commit');
			expect(await headAuthor(r)).toEqual(TEST_IDENTITY);
			expect(await porcelainStatus(r)).toEqual([]);

			const commits = await adapter.getCommits();
			const oracle = await oracleCommitLog(r);
			expect(commits).toHaveLength(1);
			expect(commits.map(c => ({ ...c, files: [...c.files].sort() }))).toEqual(
				oracle.map(c => ({ ...c, files: [...c.files].sort() }))
			);
			expect(commits[0].message).toBe('initial repository commit');
			expect([...commits[0].files].sort()).toEqual(['README.md', 'src/main.ts']);
		});

		it('commits sequential changes advancing history and establishing parent linkage', async () => {
			const { r, adapter, initRev: firstRev } = await setupRepoWithInitialCommit(
				engine,
				'first.txt',
				'first\n',
				'first commit'
			);

			await r.write('second.txt', 'second\n');
			await checkedGit(r, ['add', 'second.txt']);
			await adapter.commit('second commit');
			const secondRev = await headRev(r);

			expect(secondRev).not.toBe(firstRev);
			expect(await headParentHashes(r)).toEqual([firstRev]);
			expect(await headSubject(r)).toBe('second commit');

			const commits = await adapter.getCommits();
			const oracle = await oracleCommitLog(r);
			expect(commits.map(c => ({ ...c, files: [...c.files].sort() }))).toEqual(
				oracle.map(c => ({ ...c, files: [...c.files].sort() }))
			);
			expect(commits).toHaveLength(2);
			expect(commits[0].message).toBe('second commit');
			expect(commits[1].message).toBe('first commit');
		});

		it('records an explicit author overriding the harness/config identity', async () => {
			const r = await createTrackedRepo();
			await setUserConfig(r);
			await r.write('file.txt', 'content\n');
			await checkedGit(r, ['add', 'file.txt']);

			const customAuthor = { name: 'Grace Hopper', email: 'grace@navy.mil' };
			const adapter = engine.adapter(r);
			await adapter.commit('explicit author commit', { author: customAuthor });

			expect(await headAuthor(r)).toEqual(customAuthor);
			expect(await headSubject(r)).toBe('explicit author commit');

			const commits = await adapter.getCommits();
			expect(commits).toHaveLength(1);
			expect(commits[0].author).toBe('Grace Hopper <grace@navy.mil>');
			expect(commits[0].message).toBe('explicit author commit');
		});

		it('amends the root commit, replacing message, files, and author without creating extra history', async () => {
			const { r, adapter, initRev: initialRev } = await setupRepoWithInitialCommit(
				engine,
				'a.txt',
				'v1\n',
				'initial message'
			);

			// Stage an additional file and amend the commit
			await r.write('b.txt', 'v2\n');
			await checkedGit(r, ['add', 'b.txt']);

			const newAuthor = { name: 'Ada Lovelace', email: 'ada@analytical.org' };
			await adapter.commit('amended initial message', { amend: true, author: newAuthor });

			const amendedRev = await headRev(r);
			expect(amendedRev).not.toBe(initialRev);
			expect(await headParentHashes(r)).toEqual([]);
			expect(await headSubject(r)).toBe('amended initial message');
			expect(await headAuthor(r)).toEqual(newAuthor);

			const commits = await adapter.getCommits();
			const oracle = await oracleCommitLog(r);
			expect(commits).toHaveLength(1);
			expect(commits.map(c => ({ ...c, files: [...c.files].sort() }))).toEqual(
				oracle.map(c => ({ ...c, files: [...c.files].sort() }))
			);
			expect(commits[0].message).toBe('amended initial message');
			expect([...commits[0].files].sort()).toEqual(['a.txt', 'b.txt']);
		});

		it('amends a non-root commit, replacing the commit while preserving the original parent', async () => {
			const { r, adapter, initRev: rootRev } = await setupRepoWithInitialCommit(
				engine,
				'root.txt',
				'root\n',
				'root commit'
			);

			await r.write('second.txt', 'v1\n');
			await checkedGit(r, ['add', 'second.txt']);
			await adapter.commit('second commit');
			const secondRev = await headRev(r);

			// Modify second.txt and amend
			await r.write('second.txt', 'v2\n');
			await checkedGit(r, ['add', 'second.txt']);
			await adapter.commit('amended second commit', { amend: true });

			const amendedRev = await headRev(r);
			expect(amendedRev).not.toBe(secondRev);
			// Parent of amended commit must remain the root commit
			expect(await headParentHashes(r)).toEqual([rootRev]);
			expect(await headSubject(r)).toBe('amended second commit');

			const commits = await adapter.getCommits();
			expect(commits).toHaveLength(2);
			expect(commits[0].message).toBe('amended second commit');
			expect(commits[1].message).toBe('root commit');
		});

		it('commits a multiline message with subject and body', async () => {
			const r = await createTrackedRepo();
			await setUserConfig(r);
			await r.write('note.txt', 'note\n');
			await checkedGit(r, ['add', 'note.txt']);

			const multilineMsg = 'feat(core): subject line\n\nDetailed explanation of the change.';
			const adapter = engine.adapter(r);
			await adapter.commit(multilineMsg);

			expect(await headSubject(r)).toBe('feat(core): subject line');
			const commits = await adapter.getCommits();
			expect(commits[0].message).toBe('feat(core): subject line');
		});
	});

	describe(`${engine.name} — branch creation`, () => {
		it('creates a new branch, switches to it, and makes it visible in listings', async () => {
			const { r, adapter, initRev } = await setupRepoWithInitialCommit(engine);

			await adapter.createBranch('feature/awesome');

			// Current branch moved to feature/awesome
			expect(await adapter.getCurrentBranch()).toBe('feature/awesome');
			expect(await currentBranch(r)).toBe('feature/awesome');

			// Both branches are visible in getBranches() and match oracle
			const branches = await adapter.getBranches();
			const oracle = await oracleBranches(r);
			expect([...branches].sort()).toEqual(oracle);
			expect([...branches].sort()).toEqual(['feature/awesome', 'main']);

			// Both branches point to the same initial commit
			expect(await refRev(r, 'refs/heads/feature/awesome')).toBe(initRev);
			expect(await refRev(r, 'refs/heads/main')).toBe(initRev);
		});

		it('allows commits on the new branch to advance independently from the original branch', async () => {
			const { r, adapter, initRev } = await setupRepoWithInitialCommit(engine);

			await adapter.createBranch('feature/work');
			await r.write('feature.txt', 'feature\n');
			await r.git(['add', 'feature.txt']);
			await adapter.commit('feature work done');
			const featureRev = await headRev(r);

			expect(featureRev).not.toBe(initRev);
			expect(await refRev(r, 'refs/heads/feature/work')).toBe(featureRev);
			expect(await refRev(r, 'refs/heads/main')).toBe(initRev);
		});

		it('carries forward uncommitted and staged changes when creating a branch', async () => {
			const { r, adapter } = await setupRepoWithInitialCommit(
				engine,
				'tracked.txt',
				'base\n',
				'base commit'
			);

			// Create uncommitted working tree and staged modifications
			await r.write('tracked.txt', 'modified content\n');
			await r.git(['add', 'tracked.txt']);
			await r.write('untracked.txt', 'untracked file\n');

			await adapter.createBranch('feature/carry-forward');

			expect(await adapter.getCurrentBranch()).toBe('feature/carry-forward');
			expect(await currentBranch(r)).toBe('feature/carry-forward');
			expect(await worktreeContents(r, 'tracked.txt')).toBe('modified content\n');
			expect(await worktreeContents(r, 'untracked.txt')).toBe('untracked file\n');
		});

		it('creates branches with nested slashes in the branch name', async () => {
			const { adapter } = await setupRepoWithInitialCommit(engine);

			await adapter.createBranch('bugfix/issue-47/part-1');

			expect(await adapter.getCurrentBranch()).toBe('bugfix/issue-47/part-1');
			expect((await adapter.getBranches()).includes('bugfix/issue-47/part-1')).toBe(true);
		});

		it('throws an error when attempting to create a branch that already exists', async () => {
			const { adapter } = await setupRepoWithInitialCommit(engine);

			await expect(adapter.createBranch('main')).rejects.toThrow();
		});
	});
}
