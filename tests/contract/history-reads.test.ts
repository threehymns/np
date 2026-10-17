import { expect } from 'bun:test';
import type { GitHistoryCommit } from '@np/core';
import { toURI } from '@np/core/storage';
import { IsomorphicGitAdapter } from '@np/adapters-browser';
import { browserHandleRegistry } from '@np/adapters-browser';
import { SpawnGitAdapter } from '../../apps/desktop/src/renderer/SpawnGitAdapter';
import { NodeDirectoryHandle } from './node-fs-handle';
import {
	TestRepo,
	checkedGit,
	createTrackedRepo,
	describe,
	it,
	nodeFileAccess,
	runGit,
	TEST_IDENTITY
} from './harness';

interface HistoryReads {
	getHistory?(options?: { branch?: string | null; maxCount?: number }): Promise<GitHistoryCommit[]>;
}

interface Engine {
	name: string;
	adapter(r: TestRepo): HistoryReads;
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
		const repoOrigin = { scheme: 'browser' as const, path: r.path, name: 'repo' };
		browserHandleRegistry.register(toURI(repoOrigin), new NodeDirectoryHandle('repo', r.path));
		return new IsomorphicGitAdapter(repoOrigin);
	}
};

async function commit(r: TestRepo, message: string, date?: string, authorName?: string): Promise<string> {
	await r.write('file.txt', `${message}\n`);
	const add = await r.git(['add', '-A']);
	if (add.code !== 0) throw new Error(add.stderr);
	const env = { ...r.env };
	if (date) {
		env.GIT_AUTHOR_DATE = date;
		env.GIT_COMMITTER_DATE = date;
	}
	if (authorName) {
		env.GIT_AUTHOR_NAME = authorName;
		env.GIT_COMMITTER_NAME = authorName;
	}
	const res = await runGit(r.path, env, ['commit', '-q', '-m', message]);
	if (res.code !== 0) throw new Error(res.stderr);
	const rev = await r.git(['rev-parse', 'HEAD']);
	return rev.stdout.trim();
}

for (const engine of [spawnEngine, isomorphicEngine]) {
	describe(`${engine.name} — history log reads (Ticket #345)`, () => {
		it('returns an empty array for an empty repository with no commits yet', async () => {
			const r = await createTrackedRepo();
			const adapter = engine.adapter(r);

			const history = await adapter.getHistory!();
			expect(history).toEqual([]);
		});

		it('returns commits newest-first with subject, author, timestamp, shortSha, and sha', async () => {
			const r = await createTrackedRepo();
			const sha1 = await commit(r, 'First commit', '2024-01-01T12:00:00Z', 'Alice');
			const sha2 = await commit(r, 'Second commit', '2024-01-02T12:00:00Z', 'Bob');
			const adapter = engine.adapter(r);

			const history = await adapter.getHistory!();
			expect(history).toHaveLength(2);

			// Newest first
			expect(history[0].sha).toBe(sha2);
			expect(history[0].shortSha).toBe(sha2.slice(0, 7));
			expect(history[0].subject).toBe('Second commit');
			expect(history[0].author).toBe('Bob');
			expect(history[0].timestamp).toBeGreaterThan(0);

			expect(history[1].sha).toBe(sha1);
			expect(history[1].shortSha).toBe(sha1.slice(0, 7));
			expect(history[1].subject).toBe('First commit');
			expect(history[1].author).toBe('Alice');
			expect(history[1].timestamp).toBeLessThan(history[0].timestamp);
		});

		it('scopes history to the current branch only (does not include commits from peer branches)', async () => {
			const r = await createTrackedRepo();
			const baseSha = await commit(r, 'Base commit', '2024-01-01T12:00:00Z');

			// Create peer branch and commit on it
			await checkedGit(r, ['checkout', '-q', '-b', 'peer-feature']);
			await commit(r, 'Peer feature commit', '2024-01-02T12:00:00Z');

			// Switch back to default branch (main) and make a commit
			await checkedGit(r, ['checkout', '-q', 'main']);
			const mainSha = await commit(r, 'Main branch commit', '2024-01-03T12:00:00Z');

			const adapter = engine.adapter(r);
			const history = await adapter.getHistory!();

			// Should only contain main branch commit and base commit, NOT peer feature commit
			expect(history.map(c => c.sha)).toEqual([mainSha, baseSha]);
			expect(history.some(c => c.subject === 'Peer feature commit')).toBe(false);
		});

		it('detached HEAD falls back to HEAD history', async () => {
			const r = await createTrackedRepo();
			const sha1 = await commit(r, 'Commit 1', '2024-01-01T12:00:00Z');
			const sha2 = await commit(r, 'Commit 2', '2024-01-02T12:00:00Z');
			await commit(r, 'Commit 3', '2024-01-03T12:00:00Z');

			// Detach HEAD to Commit 2
			await checkedGit(r, ['checkout', '-q', '--detach', sha2]);

			const adapter = engine.adapter(r);
			const history = await adapter.getHistory!();

			expect(history.map(c => c.sha)).toEqual([sha2, sha1]);
			expect(history.some(c => c.subject === 'Commit 3')).toBe(false);
		});
	});
}

describe('SpawnGitAdapter — linked worktree and defensive parsing', () => {
	it('linked worktree shows that worktree\'s history', async () => {
		const r = await createTrackedRepo();
		const main1 = await commit(r, 'Main commit 1', '2024-01-01T12:00:00Z');

		// Add linked worktree on branch wt-branch
		const wtPath = `${r.path}-worktree`;
		await checkedGit(r, ['worktree', 'add', '-b', 'wt-branch', wtPath]);

		// Make a commit inside the linked worktree
		const env = { ...r.env };
		await runGit(wtPath, env, ['commit', '-q', '--allow-empty', '-m', 'Worktree commit 1']);
		const wtRev = await runGit(wtPath, env, ['rev-parse', 'HEAD']);
		const wtSha = wtRev.stdout.trim();

		// Spawn adapter pointing to linked worktree root
		const wtAdapter = new SpawnGitAdapter(
			{ scheme: 'file', path: wtPath, name: 'wt-repo' },
			(workingDir, args) => runGit(workingDir, env, args),
			nodeFileAccess
		);

		const wtHistory = await wtAdapter.getHistory();
		expect(wtHistory.map(c => c.sha)).toEqual([wtSha, main1]);
		expect(wtHistory[0].subject).toBe('Worktree commit 1');
	});

	it('parses defensively with pipe characters in author and subject', async () => {
		const r = await createTrackedRepo();
		const sha = await commit(r, 'Subject | with | pipes', '2024-01-01T12:00:00Z', 'Author | With | Pipes');
		const adapter = spawnEngine.adapter(r);

		const history = await adapter.getHistory!();
		expect(history).toHaveLength(1);
		expect(history[0].sha).toBe(sha);
		expect(history[0].subject).toBe('Subject | with | pipes');
		expect(history[0].author).toBe('Author | With | Pipes');
	});
});
