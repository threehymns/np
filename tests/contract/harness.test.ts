import { afterAll, expect, describe as bunDescribe, test as bunTest } from 'bun:test';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { sep } from 'node:path';
import {
	GIT_FLOOR,
	TEST_IDENTITY,
	TestRepo,
	atLeastGit,
	createTestRepo,
	currentBranch,
	describe,
	gitFloorSkipReason,
	gitVersion,
	headAuthor,
	indexContents,
	it,
	lsFiles,
	porcelainStatus,
	worktreeContents
} from './harness';

const created: TestRepo[] = [];

afterAll(async () => {
	await Promise.all(created.map(repo => repo.cleanup()));
});

async function repo(): Promise<TestRepo> {
	const r = await createTestRepo();
	created.push(r);
	return r;
}

describe('contract harness', () => {
	it('creates a fresh repository per test with its own temp root and .git', async () => {
		const a = await repo();
		const b = await repo();

		expect(a.path).not.toBe(b.path);
		expect(a.path.startsWith(tmpdir() + sep)).toBe(true);
		expect(existsSync(`${a.path}/.git`)).toBe(true);
		expect(existsSync(`${b.path}/.git`)).toBe(true);
		expect(await currentBranch(a)).toBe('main');
	});

	it('never shares or mutates another test repository', async () => {
		const a = await repo();
		const b = await repo();

		await a.write('a-only.txt', 'contents of a');
		await a.git(['add', 'a-only.txt']);
		await a.git(['commit', '-m', 'commit in a only']);

		expect(await b.read('a-only.txt')).toBeNull();
		expect(await worktreeContents(b, 'a-only.txt')).toBeNull();
		expect(await lsFiles(b)).toEqual([]);
		expect(await headAuthor(b)).toBeNull();
		const statusB = await porcelainStatus(b);
		expect(statusB.find(entry => entry.path === 'a-only.txt')).toBeUndefined();
	});

	it('commits with the synthetic identity, isolated from developer git config', async () => {
		const r = await repo();

		const globalConfig = await r.git(['config', '--global', '--list']);
		expect(globalConfig.stdout.trim()).toBe('');

		await r.write('hello.txt', 'hello\n');
		await r.git(['add', 'hello.txt']);
		await r.git(['commit', '-m', 'seeded']);

		expect(await headAuthor(r)).toEqual(TEST_IDENTITY);
	});

	it('oracle helpers report index contents, worktree contents, and porcelain status', async () => {
		const r = await repo();
		await r.write('tracked.txt', 'worktree v1\n');
		await r.git(['add', 'tracked.txt']);

		expect(await indexContents(r, 'tracked.txt')).toBe('worktree v1\n');
		expect(await worktreeContents(r, 'tracked.txt')).toBe('worktree v1\n');
		expect(await lsFiles(r)).toEqual(['tracked.txt']);

		let status = await porcelainStatus(r);
		expect(status).toHaveLength(1);
		expect(status[0]).toMatchObject({ x: 'A', y: ' ', path: 'tracked.txt' });

		await r.write('tracked.txt', 'worktree v2\n');
		await r.write('untracked.txt', 'new\n');

		status = await porcelainStatus(r);
		expect(status).toHaveLength(2);
		const modified = status.find(entry => entry.path === 'tracked.txt');
		expect(modified).toMatchObject({ x: 'A', y: 'M' });
		const untracked = status.find(entry => entry.path === 'untracked.txt');
		expect(untracked).toMatchObject({ x: '?', y: '?' });

		expect(await indexContents(r, 'missing.txt')).toBeNull();
		expect(await worktreeContents(r, 'missing.txt')).toBeNull();
	});

	it('reports the version floor skip reason with a clear message when below any floor', async () => {
		const version = await gitVersion();
		expect(version.raw).toMatch(/^git version \d+\.\d+\.\d+/);
		expect(atLeastGit(version, GIT_FLOOR)).toBe(true);

		expect(atLeastGit({ major: 2, minor: 23, patch: 0, raw: 'x' }, GIT_FLOOR)).toBe(true);
		expect(atLeastGit({ major: 2, minor: 22, patch: 9, raw: 'x' }, GIT_FLOOR)).toBe(false);
		expect(atLeastGit({ major: 3, minor: 0, patch: 0, raw: 'x' }, GIT_FLOOR)).toBe(true);

		expect(await gitFloorSkipReason(GIT_FLOOR)).toBeNull();

		const impossible = { major: 99, minor: 0 };
		const reason = await gitFloorSkipReason(impossible);
		expect(reason).toMatch(/^requires git >= 99\.0\.0 \(found git version \d+\.\d+\.\d+\)$/);
	});
});

// The guard machinery itself: a describe bound at an impossible floor must skip
// every test inside it (nothing below this point can ever execute).
const impossibleFloorReason = await gitFloorSkipReason({ major: 99, minor: 0 });
const impossibleDescribe = impossibleFloorReason
	? bunDescribe.skipIf(true, impossibleFloorReason)
	: bunDescribe;

impossibleDescribe('skip guard self-check (impossible floor 99.0)', () => {
	bunTest('must never run', () => {
		throw new Error('skip guard failed: test below the version floor executed');
	});
});