import { expect } from 'bun:test';
import type { GitCommit } from '@np/core';
import { toURI } from '@np/core/storage';
import { IsomorphicGitAdapter } from '@np/adapters-browser';
import { browserHandleRegistry } from '@np/adapters-browser';
import { SpawnGitAdapter } from '../../apps/desktop/src/renderer/SpawnGitAdapter';
import { NodeDirectoryHandle } from './node-fs-handle';
import { TestRepo, createTrackedRepo, describe, it, nodeFileAccess, runGit, TEST_IDENTITY } from './harness';

/**
 * `SpawnGitAdapter.getCommits()` reads its commit header out of
 * `git log --pretty=format:%h|%an <%ae>|%ad|%s`, which joins four fields with a
 * bare `|`. It then splits that line on `|`.
 *
 * A `|` is legal in a git author name and legal in an author email, and both are
 * attacker-influenced in the ordinary case: they come from the repository's own
 * history, which a collaborator, a rebase onto a fork, or a patch series from
 * upstream decides. So a commit authored by `Ada|Lovelace <ada@example.com>`
 * splits into more pieces than there are fields, and every field after the
 * offender is read one position too far to the left.
 *
 * The subject is the one field that survives, because the parse collects the
 * remainder and rejoins it -- `message: rest.join('|')`. The author is the field
 * that breaks, and it breaks the two fields behind it.
 *
 * The fix is to stop using an in-band delimiter for a field that can contain
 * one. `--pretty=format:` already supports NUL, and `-z` is already in use for
 * the path side, so the same framing that made paths safe makes this safe.
 *
 * The isomorphic-git engine never had this bug: it reads `commit.author.name`
 * and `commit.author.email` as structured fields and never parses a delimited
 * string. So the cases below are cross-engine checks, and the spawn engine is
 * expected to be the one that disagrees before the fix.
 */
describe('commit metadata survives a pipe in any field (VCS contract)', () => {
	/** Every engine that answers getCommits, so the check is a real contract, not a spawn-only unit test. */
	const engines = [
		{
			name: 'SpawnGitAdapter (real git)',
			create: (r: TestRepo) =>
				new SpawnGitAdapter(
					{ scheme: 'file', path: r.path, name: 'repo' },
					(workingDir, args) => runGit(workingDir, r.env, args),
					nodeFileAccess
				)
		},
		{
			name: 'IsomorphicGitAdapter (isomorphic-git)',
			create: (r: TestRepo) => {
				const repoOrigin = { scheme: 'browser' as const, path: r.path, name: 'repo' };
				browserHandleRegistry.register(toURI(repoOrigin), new NodeDirectoryHandle('repo', r.path));
				return new IsomorphicGitAdapter(repoOrigin);
			}
		}
	];

	interface PipeCase {
		/** What the case is about, in the user's terms. */
		label: string;
		authorName: string;
		authorEmail: string;
		subject: string;
		/** The author string the field must read back as, exactly. */
		expectedAuthor: string;
		/** The date the commit lands on, derived rather than hardcoded so a timezone change cannot strand it. */
		expectedDate: string;
	}

	const cases: PipeCase[] = [
		{
			label: 'a pipe in the author name',
			authorName: 'Ada|Lovelace',
			authorEmail: TEST_IDENTITY.email,
			subject: 'add the analytical engine',
			expectedAuthor: 'Ada|Lovelace <contract@test.invalid>',
			expectedDate: '2024-05-05'
		},
		{
			label: 'a pipe in the author email',
			authorName: TEST_IDENTITY.name,
			authorEmail: 'a|b@contract.test.invalid',
			subject: 'add the analytical engine',
			expectedAuthor: 'Contract Test <a|b@contract.test.invalid>',
			expectedDate: '2024-05-06'
		},
		{
			label: 'pipes in both the author name and the email',
			authorName: 'Ada|Lovelace',
			authorEmail: 'a|b@contract.test.invalid',
			subject: 'add the analytical engine',
			expectedAuthor: 'Ada|Lovelace <a|b@contract.test.invalid>',
			expectedDate: '2024-05-07'
		},
		{
			label: 'a pipe in the subject, which must not disturb the author or the date',
			authorName: TEST_IDENTITY.name,
			authorEmail: TEST_IDENTITY.email,
			subject: 'fix: handle a|b in the delimiter',
			expectedAuthor: 'Contract Test <contract@test.invalid>',
			expectedDate: '2024-05-08'
		},
		{
			label: 'a pipe in the author name AND in the subject',
			authorName: 'Ada|Lovelace',
			authorEmail: TEST_IDENTITY.email,
			subject: 'fix: handle a|b in the delimiter',
			expectedAuthor: 'Ada|Lovelace <contract@test.invalid>',
			expectedDate: '2024-05-09'
		}
	];

	/**
	 * Commit with a specific author name, email, and date.
	 *
	 * The identity is set per-invocation through the environment rather than through
	 * `git config`, because git records the *env* author, and the harness pins the env
	 * author for every other test in the suite. Setting it inline keeps the blast radius
	 * of a pipe-bearing name to this one commit.
	 */
	const commitWithIdentity = async (
		r: TestRepo,
		message: string,
		authorName: string,
		authorEmail: string,
		date: string
	): Promise<void> => {
		const env = {
			...r.env,
			GIT_AUTHOR_NAME: authorName,
			GIT_AUTHOR_EMAIL: authorEmail,
			GIT_COMMITTER_NAME: authorName,
			GIT_COMMITTER_EMAIL: authorEmail,
			GIT_AUTHOR_DATE: `${date}T12:00:00Z`,
			GIT_COMMITTER_DATE: `${date}T12:00:00Z`
		};
		const res = await runGit(r.path, env, ['commit', '-q', '--allow-empty', '-m', message]);
		if (res.code !== 0) throw new Error(res.stderr);
	};

	for (const engine of engines) {
		for (const c of cases) {
			it(`${engine.name} reads every field correctly with ${c.label}`, async () => {
				const r = await createTrackedRepo();
				await r.write('README.md', 'seed\n');
				const add = await r.git(['add', '-A']);
				if (add.code !== 0) throw new Error(add.stderr);
				const seed = await r.git(['commit', '-q', '-m', 'seed']);
				if (seed.code !== 0) throw new Error(seed.stderr);

				await commitWithIdentity(r, c.subject, c.authorName, c.authorEmail, c.expectedDate);

				const commits: GitCommit[] = await engine.create(r).getCommits();
				// Index 0, not a search by message: when the author carries a pipe the
				// message is corrupted too, so searching by it would report "not found"
				// and hide what the field actually read as.
				const found = commits[0];
				expect(found, 'the commit under test is the newest').toBeDefined();
				expect(found!.author).toBe(c.expectedAuthor);
				expect(found!.date).toBe(c.expectedDate);
				expect(found!.message).toBe(c.subject);
			});
		}
	}

	/**
	 * The empty-subject guard.
	 *
	 * A commit with an empty subject and no changed files emits an empty subject
	 * record sitting directly against the blank that closes the previous commit. A
	 * parse that skipped empty records would consume that blank as the subject and
	 * then read the *next* commit's hash into the message slot, corrupting two
	 * commits at once. The four header fields are read by position precisely so
	 * this cannot happen, and this case is what pins that down.
	 */
	it('SpawnGitAdapter (real git) reads an empty subject without corrupting the next commit', async () => {
		const r = await createTrackedRepo();
		await r.write('a.txt', 'a\n');
		const add = await r.git(['add', '-A']);
		if (add.code !== 0) throw new Error(add.stderr);
		const seed = await r.git(['commit', '-q', '-m', 'the commit below']);
		if (seed.code !== 0) throw new Error(seed.stderr);

		// Empty subject, no files: the two shapes that collide under a naive
		// skip-the-blanks parse.
		const empty = await r.git(['commit', '-q', '--allow-empty', '--allow-empty-message', '-m', '']);
		if (empty.code !== 0) throw new Error(empty.stderr);

		const commits: GitCommit[] = await new SpawnGitAdapter(
			{ scheme: 'file', path: r.path, name: 'repo' },
			(workingDir, args) => runGit(workingDir, r.env, args),
			nodeFileAccess
		).getCommits();

		expect(commits).toHaveLength(2);
		// The empty-subject commit: its own hash, and an empty message that is not
		// the next commit's hash.
		expect(commits[0].message).toBe('');
		expect(commits[0].files).toEqual([]);
		expect(commits[0].author).toBe('Contract Test <contract@test.invalid>');
		// And the one below it is still intact, which is the half that would break.
		expect(commits[1].message).toBe('the commit below');
		expect(commits[1].files).toEqual(['a.txt']);
	});

	/** The seed commit's own date must not leak into the case above, so pin it as its own check. */
	it('SpawnGitAdapter (real git) keeps two pipes in one history from colliding', async () => {
		const r = await createTrackedRepo();
		await r.write('a.txt', 'a\n');
		const add = await r.git(['add', '-A']);
		if (add.code !== 0) throw new Error(add.stderr);
		const seed = await r.git(['commit', '-q', '-m', 'seed']);
		if (seed.code !== 0) throw new Error(seed.stderr);

		await commitWithIdentity(r, 'sub|ject with a pipe', 'Ada|Lovelace', 'a|b@contract.test.invalid', '2024-05-10');

		const commits: GitCommit[] = await new SpawnGitAdapter(
			{ scheme: 'file', path: r.path, name: 'repo' },
			(workingDir, args) => runGit(workingDir, r.env, args),
			nodeFileAccess
		).getCommits();

		expect(commits).toHaveLength(2);
		const top = commits[0];
		expect(top.author).toBe('Ada|Lovelace <a|b@contract.test.invalid>');
		expect(top.date).toBe('2024-05-10');
		expect(top.message).toBe('sub|ject with a pipe');
		// And the commit below it is untouched, so the parse is per-record.
		expect(commits[1].author).toBe('Contract Test <contract@test.invalid>');
	});
});
