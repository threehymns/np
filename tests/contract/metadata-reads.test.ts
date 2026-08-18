import { expect } from 'bun:test';
import type { FileOrigin, GitCommit } from '@np/core';
import { toURI } from '@np/core/storage';
import { IsomorphicGitAdapter } from '@np/adapters-browser';
import { browserHandleRegistry } from '@np/adapters-browser';
import { SpawnGitAdapter } from '../../apps/desktop/src/renderer/SpawnGitAdapter';
import { NodeDirectoryHandle } from './node-fs-handle';
import {
	TestRepo,
	createTrackedRepo,
	currentBranch,
	describe,
	it,
	runGit,
	seedCommit,
	TEST_IDENTITY
} from './harness';

function origin(r: TestRepo): FileOrigin {
	return { scheme: 'file', path: r.path, name: 'repo' };
}

/** The metadata read surface under contract: detection, branch state, branches, history, identity. */
interface MetadataReads {
	detect(rootPath: string): Promise<boolean>;
	getCurrentBranch(): Promise<string | null>;
	getBranches(): Promise<string[]>;
	getCommits(): Promise<GitCommit[]>;
	getUserConfig(): Promise<{ name: string; email: string } | null>;
}

interface Engine {
	name: string;
	adapter(r: TestRepo): MetadataReads;
}

const spawnEngine: Engine = {
	name: 'SpawnGitAdapter (real git)',
	adapter(r) {
		return new SpawnGitAdapter(origin(r), (workingDir, args) => runGit(workingDir, r.env, args));
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

/** Stage everything and commit with an optional fixed author date (noon UTC keeps both engines on the same date). */
async function commitAll(r: TestRepo, message: string, date?: string): Promise<void> {
	const add = await r.git(['add', '-A']);
	if (add.code !== 0) throw new Error(add.stderr);
	const env = date ? { ...r.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : r.env;
	const commit = await runGit(r.path, env, ['commit', '-q', '-m', message]);
	if (commit.code !== 0) throw new Error(commit.stderr);
}

/** Amend the last commit, replacing its message and author date. */
async function amendCommit(r: TestRepo, message: string, date?: string): Promise<void> {
	const env = date ? { ...r.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : r.env;
	const res = await runGit(r.path, env, ['commit', '-q', '--amend', '-m', message]);
	if (res.code !== 0) throw new Error(res.stderr);
}

async function headShortHash(r: TestRepo): Promise<string> {
	const res = await r.git(['rev-parse', '--short', 'HEAD']);
	if (res.code !== 0) throw new Error(res.stderr);
	return res.stdout.trim();
}

/** Local branch reality: `git for-each-ref` over refs/heads, sorted like both engines report. */
async function oracleBranches(r: TestRepo): Promise<string[]> {
	const res = await r.git(['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
	if (res.code !== 0) throw new Error(res.stderr);
	return res.stdout.split('\n').filter(Boolean).sort();
}

/** Files changed by a commit per `git log --name-only --no-renames`: diff-tree against the empty tree for roots. */
async function oracleCommitFiles(r: TestRepo, hash: string): Promise<string[]> {
	const res = await r.git(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', hash]);
	if (res.code !== 0) throw new Error(res.stderr);
	return res.stdout.split('\n').filter(Boolean);
}

/** Commit history reality: the same hash/author/date/message shape plus per-commit file lists. */
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

/** Base history: add, modify+delete+add, rename, and merge commits, each on a distinct noon-UTC date. */
async function seededHistory(r: TestRepo): Promise<void> {
	await r.write('README.md', 'alpha\n');
	await r.write('src/app.ts', 'const app = 1;\n');
	await commitAll(r, 'base commit', '2024-01-02T12:00:00Z');
	await r.write('README.md', 'alpha\nbeta\n');
	await r.git(['rm', '-q', 'src/app.ts']);
	await r.write('src/main.ts', 'const main = 2;\n');
	await commitAll(r, 'drop app, add main', '2024-02-03T12:00:00Z');
	await r.git(['mv', 'src/main.ts', 'src/entry.ts']);
	await commitAll(r, 'rename main to entry', '2024-03-04T12:00:00Z');
	// The source branch and main must both move for the merge to be a real merge commit.
	await r.git(['checkout', '-q', '-b', 'merge-source']);
	await r.write('notes.md', 'notes\n');
	await commitAll(r, 'notes on source', '2024-04-04T12:00:00Z');
	await r.git(['checkout', '-q', 'main']);
	await r.write('README.md', 'alpha\nbeta\ngamma\n');
	await commitAll(r, 'main-side edit', '2024-04-05T12:00:00Z');
	const merge = await runGit(r.path, { ...r.env, GIT_AUTHOR_DATE: '2024-04-06T12:00:00Z', GIT_COMMITTER_DATE: '2024-04-06T12:00:00Z' }, ['merge', '-q', '-m', 'merge source', 'merge-source']);
	if (merge.code !== 0) throw new Error(merge.stderr);
}

for (const engine of [spawnEngine, isomorphicEngine]) {
	describe(`${engine.name} — metadata reads`, () => {
		it('detects a work tree inside a repository, not outside one', async () => {
			const r = await createTrackedRepo();
			await seedCommit(r);
			const adapter = engine.adapter(r);

			// The temp parent of the repo is a real directory that is not a work tree;
			// the browser engine gets a shim handle for it, the spawn engine probes it directly.
			browserHandleRegistry.register(
				toURI({ scheme: 'browser', path: r.root, name: 'root' }),
				new NodeDirectoryHandle('root', r.root)
			);

			expect(await adapter.detect(r.path)).toBe(true);
			expect(await adapter.detect(r.root)).toBe(false);
		});

		it('resolves the current branch for an attached HEAD', async () => {
			const r = await createTrackedRepo();
			await seedCommit(r);
			const adapter = engine.adapter(r);

			expect(await adapter.getCurrentBranch()).toBe('main');
			expect(await adapter.getCurrentBranch()).toBe(await currentBranch(r));
		});

		it('reports null for a detached HEAD', async () => {
			const r = await createTrackedRepo();
			await seedCommit(r);
			const detach = await r.git(['checkout', '-q', '--detach', 'HEAD']);
			if (detach.code !== 0) throw new Error(detach.stderr);
			const adapter = engine.adapter(r);

			expect(await adapter.getCurrentBranch()).toBe(null);
			expect(await adapter.getCurrentBranch()).toBe(await currentBranch(r));
		});

		it('resolves the current branch for an unborn branch', async () => {
			const r = await createTrackedRepo();
			const adapter = engine.adapter(r);

			expect(await adapter.getCurrentBranch()).toBe('main');
			expect(await adapter.getCurrentBranch()).toBe(await currentBranch(r));
		});

		it('lists local branches matching for-each-ref reality', async () => {
			const r = await createTrackedRepo();
			await seedCommit(r);
			for (const branch of ['feature/a', 'feature/b', 'hotfix']) {
				const res = await r.git(['branch', branch]);
				if (res.code !== 0) throw new Error(res.stderr);
			}
			const adapter = engine.adapter(r);

			expect([...await adapter.getBranches()].sort()).toEqual(await oracleBranches(r));
		});

		it('returns an empty commit list for a repository with no commits', async () => {
			const r = await createTrackedRepo();
			const adapter = engine.adapter(r);

			expect(await adapter.getCommits()).toEqual([]);
		});

		it('returns the commit history with hashes, authors, messages, dates, and file lists matching git', async () => {
			const r = await createTrackedRepo();
			await seededHistory(r);
			const adapter = engine.adapter(r);

			const commits = await adapter.getCommits();
			const oracle = await oracleCommitLog(r);
			// File list *order* is not part of the contract: git diff emits deletions before
			// additions while the browser tree walk emits tree order, so compare the sets.
			expect(commits.map(c => ({ ...c, files: [...c.files].sort() }))).toEqual(
				oracle.map(c => ({ ...c, files: [...c.files].sort() }))
			);

			// Pin the semantic fields explicitly so the shape is readable here, not just in the oracle.
			expect(commits.map(c => c.message)).toEqual([
				'merge source',
				'main-side edit',
				'notes on source',
				'rename main to entry',
				'drop app, add main',
				'base commit'
			]);
			expect(commits.map(c => c.date)).toEqual(['2024-04-06', '2024-04-05', '2024-04-04', '2024-03-04', '2024-02-03', '2024-01-02']);
			expect(commits.map(c => c.author).every(a => a === `${TEST_IDENTITY.name} <${TEST_IDENTITY.email}>`)).toBe(true);
			// Merge commits carry no file list (`git log` emits no diff for merges).
			expect(commits[0].files).toEqual([]);
			expect(commits[1].files).toEqual(['README.md']);
			expect(commits[2].files).toEqual(['notes.md']);
			expect([...commits[3].files].sort()).toEqual(['src/entry.ts', 'src/main.ts']);
			expect([...commits[4].files].sort()).toEqual(['README.md', 'src/app.ts', 'src/main.ts']);
			expect([...commits[5].files].sort()).toEqual(['README.md', 'src/app.ts']);
		});

		it('reports an amended commit as a single history entry with the amended message and file list', async () => {
			const r = await createTrackedRepo();
			await r.write('a.txt', 'v1\n');
			await commitAll(r, 'first version', '2024-01-02T12:00:00Z');
			await r.write('a.txt', 'v2\n');
			await r.write('b.txt', 'b\n');
			const stage = await r.git(['add', '-A']);
			if (stage.code !== 0) throw new Error(stage.stderr);
			await amendCommit(r, 'first version, amended', '2024-01-03T12:00:00Z');
			const adapter = engine.adapter(r);

			const commits = await adapter.getCommits();
			expect(commits).toEqual(await oracleCommitLog(r));
			expect(commits).toHaveLength(1);
			expect(commits[0].hash).toBe(await headShortHash(r));
			expect(commits[0].message).toBe('first version, amended');
			// git commit --amend preserves the original author date even when
			// GIT_AUTHOR_DATE is set; only the committer date moves forward.
			expect(commits[0].date).toBe('2024-01-02');
			expect(commits[0].files).toEqual(['a.txt', 'b.txt']);
		});

		it('caps a history wider than 50 commits at the newest 50, newest first', async () => {
			const r = await createTrackedRepo();
			await r.write('a.txt', 'a\n');
			await commitAll(r, 'commit 1', '2024-01-01T12:00:00Z');
			for (let i = 2; i <= 55; i++) {
				const date = new Date(Date.UTC(2024, 0, 1, 12 + i)).toISOString();
				const res = await runGit(r.path, { ...r.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, ['commit', '-q', '--allow-empty', '-m', `commit ${i}`]);
				if (res.code !== 0) throw new Error(res.stderr);
			}
			const adapter = engine.adapter(r);

			const commits = await adapter.getCommits();
			expect(commits).toHaveLength(50);
			expect(commits[0].hash).toBe(await headShortHash(r));
			expect(commits[0].message).toBe('commit 55');
			expect(commits[49].message).toBe('commit 6');
			expect(commits.some(c => c.message === 'commit 1')).toBe(false);
			expect(commits.every(c => c.files.length === 0)).toBe(true);
		});

		it('returns the configured user identity, and null when none is configured', async () => {
			const r = await createTrackedRepo();
			const adapter = engine.adapter(r);

			expect(await adapter.getUserConfig()).toBe(null);

			// The identity the harness injects everywhere else (GIT_AUTHOR_*/GIT_COMMITTER_*)
			// is the identity `git config` should report when written into the repo config.
			const name = await r.git(['config', 'user.name', TEST_IDENTITY.name]);
			if (name.code !== 0) throw new Error(name.stderr);
			const email = await r.git(['config', 'user.email', TEST_IDENTITY.email]);
			if (email.code !== 0) throw new Error(email.stderr);

			expect(await adapter.getUserConfig()).toEqual({ name: TEST_IDENTITY.name, email: TEST_IDENTITY.email });
		});
	});
}
