import { expect } from 'bun:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import type { FileOrigin, GitChange, FileDiffDetail, VCSStatus } from '@np/core';
import { toURI } from '@np/core/storage';
import { IsomorphicGitAdapter } from '@np/adapters-browser';
import { browserHandleRegistry } from '@np/adapters-browser';
import { SpawnGitAdapter } from '../../apps/desktop/src/renderer/SpawnGitAdapter';
import type { GitFileAccess } from '../../apps/desktop/src/renderer/SpawnGitAdapter';
import { NodeDirectoryHandle, moveEntry } from './node-fs-handle';
import {
	TestRepo,
	atLeastGit,
	checkedGit,
	createTrackedRepo,
	describe,
	gitVersion,
	it,
	indexContents,
	porcelainStatus,
	runGit,
	worktreeContents,
	COPY_DETECTION_FLOOR
} from './harness';

const copyVersion = await gitVersion();

function origin(r: TestRepo): FileOrigin {
	return { scheme: 'file', path: r.path, name: 'repo' };
}

const nodeFileAccess: GitFileAccess = {
	readFile: (path) => readFile(path),
	writeFile: (path, content) => writeFile(path, content),
	deleteEntry: (path) => rm(path, { force: true })
};

/** The read surface under contract: the change list and on-demand diff resolution. */
interface ChangeDiffReads {
	getStatus(): Promise<VCSStatus>;
	getChanges(): Promise<GitChange[]>;
	getFileDiff(filepath: string, options?: { staged?: boolean }): Promise<FileDiffDetail>;
}

interface Engine {
	name: string;
	adapter(r: TestRepo): ChangeDiffReads;
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

/** Base committed repository: README.md, hello.ts, src.txt. */
async function baseRepo(r: TestRepo): Promise<void> {
	await r.write('README.md', 'alpha\nbeta\ngamma\n');
	await r.write('hello.ts', 'const a = 1;\nconst b = 2;\n');
	await r.write('src.txt', 'shared\n');
	const add = await r.git(['add', '-A']);
	if (add.code !== 0) throw new Error(add.stderr);
	const commit = await r.git(['commit', '-m', 'base']);
	if (commit.code !== 0) throw new Error(commit.stderr);
}

async function stageAll(r: TestRepo): Promise<void> {
	const res = await r.git(['add', '-A']);
	if (res.code !== 0) throw new Error(res.stderr);
}

async function commitAll(r: TestRepo, message: string): Promise<void> {
	await stageAll(r);
	const res = await r.git(['commit', '-m', message]);
	if (res.code !== 0) throw new Error(res.stderr);
}

const README_HEAD = 'alpha\nbeta\ngamma\n';
const HELLO_V0 = 'const a = 1;\nconst b = 2;\n';
const HELLO_V1 = 'const a = 1;\nconst b = 3;\n';
const HELLO_V2 = 'const a = 1;\nconst b = 3;\nconst c = 4;\n';
const SRC_CONTENT = 'shared\n';

/**
 * Numstat expectations for tracked changes. The browser adapter deliberately reports
 * zero counts for tracked files until their diff is loaded on demand (statusMatrix
 * carries no line counts; see #30); the desktop adapter reports real numstat.
 */
function trackedStats(engine: Engine, counts: { additions: number; deletions: number }): { additions: number; deletions: number } {
	return engine === isomorphicEngine ? { additions: 0, deletions: 0 } : counts;
}

for (const engine of [spawnEngine, isomorphicEngine]) {
	describe(`${engine.name} — change list and diff reads`, () => {
		it('reports a clean committed repository with no changes', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			const adapter = engine.adapter(r);

			expect(await adapter.getStatus()).toEqual({ isDirty: false, uncommittedFiles: [] });
			expect(await adapter.getChanges()).toEqual([]);
		});

		it('lists untracked files with line counts and resolves their diff', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await r.write('dir/untracked.txt', 'one\ntwo\n');
			const adapter = engine.adapter(r);

			const status = await adapter.getStatus();
			expect(status.isDirty).toBe(true);
			expect(status.uncommittedFiles).toEqual(['dir/untracked.txt']);

			const changes = await adapter.getChanges();
			expect(changes).toEqual([
				{ filepath: 'dir/untracked.txt', status: 'U', additions: 2, deletions: 0, diff: '', staged: false }
			]);

			const diff = await adapter.getFileDiff('dir/untracked.txt');
			expect(diff.originalContent).toBe('');
			expect(diff.modifiedContent).toBe('one\ntwo\n');
		});

		it('lists an unstaged modification and resolves its diff against the index', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await r.write('hello.ts', HELLO_V1);
			const adapter = engine.adapter(r);

			const changes = await adapter.getChanges();
			expect(changes).toEqual([
				{
					filepath: 'hello.ts',
					status: 'M',
					...trackedStats(engine, { additions: 1, deletions: 1 }),
					diff: '',
					staged: false
				}
			]);

			const diff = await adapter.getFileDiff('hello.ts', { staged: false });
			expect(diff.originalContent).toBe(await indexContents(r, 'hello.ts'));
			expect(diff.modifiedContent).toBe(await worktreeContents(r, 'hello.ts'));
		});

		it('splits a staged+unstaged combination into two changes with per-scope baselines', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await r.write('hello.ts', HELLO_V1);
			await stageAll(r);
			await r.write('hello.ts', HELLO_V2);
			const adapter = engine.adapter(r);

			const porcelain = await porcelainStatus(r);
			expect(porcelain).toEqual([{ x: 'M', y: 'M', path: 'hello.ts' }]);

			const changes = await adapter.getChanges();
			expect(changes).toEqual([
				{
					filepath: 'hello.ts',
					status: 'M',
					...trackedStats(engine, { additions: 1, deletions: 1 }),
					diff: '',
					staged: true
				},
				{
					filepath: 'hello.ts',
					status: 'M',
					...trackedStats(engine, { additions: 1, deletions: 0 }),
					diff: '',
					staged: false
				}
			]);

			const stagedDiff = await adapter.getFileDiff('hello.ts', { staged: true });
			expect(stagedDiff.originalContent).toBe(HELLO_V0);
			expect(stagedDiff.modifiedContent).toBe(HELLO_V1);
			expect(stagedDiff.stagedContent).toBe(HELLO_V1);

			const unstagedDiff = await adapter.getFileDiff('hello.ts', { staged: false });
			expect(unstagedDiff.originalContent).toBe(await indexContents(r, 'hello.ts'));
			expect(unstagedDiff.modifiedContent).toBe(await worktreeContents(r, 'hello.ts'));

			const combinedDiff = await adapter.getFileDiff('hello.ts');
			expect(combinedDiff.originalContent).toBe(HELLO_V0);
			expect(combinedDiff.modifiedContent).toBe(HELLO_V2);
			expect(combinedDiff.stagedContent).toBe(await indexContents(r, 'hello.ts'));
		});

		it('lists a staged addition and resolves its diff against an empty baseline', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await r.write('added.txt', 'new content\n');
			await stageAll(r);
			const adapter = engine.adapter(r);

			const changes = await adapter.getChanges();
			expect(changes).toEqual([
				{
					filepath: 'added.txt',
					status: 'A',
					...trackedStats(engine, { additions: 1, deletions: 0 }),
					diff: '',
					staged: true
				}
			]);

			const diff = await adapter.getFileDiff('added.txt', { staged: true });
			expect(diff.originalContent).toBe('');
			expect(diff.modifiedContent).toBe('new content\n');
		});

		it('lists staged and unstaged deletions; deleted-file diffs read as empty modified content', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await r.git(['rm', '-q', 'README.md']);
			await rm(`${r.path}/hello.ts`);
			const adapter = engine.adapter(r);

			const changes = await adapter.getChanges();
			expect(changes).toEqual([
				{
					filepath: 'README.md',
					status: 'D',
					...trackedStats(engine, { additions: 0, deletions: 3 }),
					diff: '',
					staged: true
				},
				{
					filepath: 'hello.ts',
					status: 'D',
					...trackedStats(engine, { additions: 0, deletions: 2 }),
					diff: '',
					staged: false
				}
			]);

			const stagedDelete = await adapter.getFileDiff('README.md', { staged: true });
			expect(stagedDelete.originalContent).toBe(README_HEAD);
			expect(stagedDelete.modifiedContent).toBe('');

			const unstagedDelete = await adapter.getFileDiff('hello.ts', { staged: false });
			expect(unstagedDelete.originalContent).toBe(await indexContents(r, 'hello.ts'));
			expect(unstagedDelete.modifiedContent).toBe('');

			const combinedDelete = await adapter.getFileDiff('hello.ts');
			expect(combinedDelete.originalContent).toBe(HELLO_V0);
			expect(combinedDelete.modifiedContent).toBe('');
		});

		it('reads a file recreated after a staged delete with the live index as baseline', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await r.git(['rm', '-q', '--cached', 'README.md']);
			await r.write('README.md', 'recreated\n');
			const adapter = engine.adapter(r);

			// `git rm --cached` removes the index entry entirely, so porcelain reports the
			// staged delete and the recreated worktree file as two separate entries (D + ??).
			const porcelain = await porcelainStatus(r);
			expect(porcelain).toEqual([
				{ x: 'D', y: ' ', path: 'README.md' },
				{ x: '?', y: '?', path: 'README.md' }
			]);

			const changes = await adapter.getChanges();
			expect(changes.filter(c => c.filepath === 'README.md').length).toBe(2);
			const staged = changes.find(c => c.filepath === 'README.md' && c.staged);
			expect(staged?.status).toBe('D');
			expect(staged?.deletions).toBe(trackedStats(engine, { additions: 0, deletions: 3 }).deletions);
			const unstaged = changes.find(c => c.filepath === 'README.md' && !c.staged);
			// The desktop adapter sees porcelain '??' and reports 'U' with a line count; the
			// browser adapter derives 'A' from the status matrix with zero counts (see #30).
			// The drift is pinned per-engine until #34 settles staged-delete-plus-recreated.
			expect(unstaged?.status).toBe(engine === isomorphicEngine ? 'A' : 'U');
			expect(unstaged?.additions).toBe(engine === isomorphicEngine ? 0 : 1);

			const unstagedDiff = await adapter.getFileDiff('README.md', { staged: false });
			expect(unstagedDiff.originalContent).toBe('');
			expect(unstagedDiff.modifiedContent).toBe('recreated\n');

			const combinedDiff = await adapter.getFileDiff('README.md');
			expect(combinedDiff.originalContent).toBe(README_HEAD);
			expect(combinedDiff.modifiedContent).toBe('recreated\n');
			expect(combinedDiff.stagedContent).toBe('');
		});

		it('derives status from the same repository state as porcelain for a mixed dirty repo', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await r.write('hello.ts', HELLO_V1);
			await stageAll(r);
			await r.write('untracked.txt', 'x\n');
			await rm(`${r.path}/src.txt`);
			const adapter = engine.adapter(r);

			const porcelain = await porcelainStatus(r);
			const status = await adapter.getStatus();
			expect(status.isDirty).toBe(true);
			expect([...status.uncommittedFiles].sort()).toEqual(porcelain.map(e => e.path).sort());
		});
	});
}

describe('SpawnGitAdapter — porcelain rename and copy read paths', () => {
	it('reports numstat matching raw git diffs for a mixed dirty repository', async () => {
		const r = await createTrackedRepo();
		await baseRepo(r);
		await r.write('hello.ts', HELLO_V1);
		await stageAll(r);
		await r.write('hello.ts', HELLO_V2);
		await r.write('added.txt', 'new content\n');
		await stageAll(r);
		await r.write('untracked.txt', 'a\nb\nc\n');
		const adapter = spawnEngine.adapter(r);

		const rawStaged = new Map<string, { additions: number; deletions: number }>();
		const rawUnstaged = new Map<string, { additions: number; deletions: number }>();
		for (const [args, map] of [
			[['diff', '--cached', '--numstat'], rawStaged],
			[['diff', '--numstat'], rawUnstaged]
		] as const) {
			const res = await r.git([...args]);
			if (res.code !== 0) throw new Error(res.stderr);
			for (const line of res.stdout.split('\n').filter(Boolean)) {
				const [a, d, ...rest] = line.split('\t');
				map.set(rest.join('\t'), { additions: Number(a) || 0, deletions: Number(d) || 0 });
			}
		}

		const changes = await adapter.getChanges();
		for (const change of changes) {
			if (change.status === 'U') continue; // untracked files never appear in git diff --numstat
			const raw = (change.staged ? rawStaged : rawUnstaged).get(change.filepath);
			expect({ additions: change.additions, deletions: change.deletions }).toEqual(
				raw ?? { additions: 0, deletions: 0 }
			);
		}
		const untracked = changes.find(c => c.filepath === 'untracked.txt');
		expect(untracked?.additions).toBe(3);
		expect(untracked?.deletions).toBe(0);
	});

	it('resolves a staged rename baseline from the rename origin path', async () => {
		const r = await createTrackedRepo();
		await baseRepo(r);
		await r.git(['mv', 'src.txt', 'moved.txt']);
		const adapter = spawnEngine.adapter(r);

		const porcelain = await porcelainStatus(r);
		expect(porcelain).toEqual([{ x: 'R', y: ' ', path: 'moved.txt', origPath: 'src.txt' }]);

		const changes = await adapter.getChanges();
		expect(changes).toEqual([
			{ filepath: 'moved.txt', status: 'M', additions: 0, deletions: 0, diff: '', staged: true }
		]);

		const diff = await adapter.getFileDiff('moved.txt', { staged: true });
		expect(diff.originalContent).toBe(SRC_CONTENT);
		expect(diff.modifiedContent).toBe(await indexContents(r, 'moved.txt'));
	});

	it('resolves a staged rename with unstaged edits at the destination (RM)', async () => {
		const r = await createTrackedRepo();
		await baseRepo(r);
		await r.git(['mv', 'src.txt', 'moved.txt']);
		await r.write('moved.txt', `${SRC_CONTENT}more\n`);
		const adapter = spawnEngine.adapter(r);

		const porcelain = await porcelainStatus(r);
		expect(porcelain).toEqual([{ x: 'R', y: 'M', path: 'moved.txt', origPath: 'src.txt' }]);

		const changes = await adapter.getChanges();
		expect(changes).toEqual([
			{ filepath: 'moved.txt', status: 'M', additions: 0, deletions: 0, diff: '', staged: true },
			{ filepath: 'moved.txt', status: 'M', additions: 1, deletions: 0, diff: '', staged: false }
		]);

		const stagedDiff = await adapter.getFileDiff('moved.txt', { staged: true });
		expect(stagedDiff.originalContent).toBe(SRC_CONTENT);
		expect(stagedDiff.modifiedContent).toBe(await indexContents(r, 'moved.txt'));

		const unstagedDiff = await adapter.getFileDiff('moved.txt', { staged: false });
		expect(unstagedDiff.originalContent).toBe(await indexContents(r, 'moved.txt'));
		expect(unstagedDiff.modifiedContent).toBe(`${SRC_CONTENT}more\n`);

		const combinedDiff = await adapter.getFileDiff('moved.txt');
		expect(combinedDiff.originalContent).toBe(SRC_CONTENT);
		expect(combinedDiff.modifiedContent).toBe(`${SRC_CONTENT}more\n`);
	});

	it('reports a worktree-only move as a delete plus an untracked file, without a rename baseline', async () => {
		const r = await createTrackedRepo();
		await baseRepo(r);
		await moveEntry(`${r.path}/src.txt`, `${r.path}/moved.txt`);
		const adapter = spawnEngine.adapter(r);

		// git status never emits ' R' for worktree moves (verified empirically): the move
		// surfaces as a tracked deletion plus an untracked addition, so no rename origin
		// can be recovered for the diff baseline.
		const porcelain = await porcelainStatus(r);
		expect(porcelain).toEqual([
			{ x: ' ', y: 'D', path: 'src.txt' },
			{ x: '?', y: '?', path: 'moved.txt' }
		]);

		const changes = await adapter.getChanges();
		expect(changes).toEqual([
			{ filepath: 'src.txt', status: 'D', additions: 0, deletions: 1, diff: '', staged: false },
			{ filepath: 'moved.txt', status: 'U', additions: 1, deletions: 0, diff: '', staged: false }
		]);

		const unstagedDiff = await adapter.getFileDiff('moved.txt', { staged: false });
		expect(unstagedDiff.originalContent).toBe('');
		expect(unstagedDiff.modifiedContent).toBe(await worktreeContents(r, 'moved.txt'));

		const combinedDiff = await adapter.getFileDiff('moved.txt');
		expect(combinedDiff.originalContent).toBe('');
		expect(combinedDiff.modifiedContent).toBe(SRC_CONTENT);
	});

	it('reports a move of a staged-edit file as staged M plus unstaged delete, with no rename baseline for the new file', async () => {
		const r = await createTrackedRepo();
		await r.write('old.txt', 'a\nb\nc\n');
		await commitAll(r, 'base');
		await r.write('old.txt', 'a\nbX\nc\n');
		await stageAll(r);
		await moveEntry(`${r.path}/old.txt`, `${r.path}/new.txt`);
		const adapter = spawnEngine.adapter(r);

		const porcelain = await porcelainStatus(r);
		expect(porcelain).toEqual([
			{ x: 'M', y: 'D', path: 'old.txt' },
			{ x: '?', y: '?', path: 'new.txt' }
		]);

		const changes = await adapter.getChanges();
		expect(changes).toEqual([
			{ filepath: 'old.txt', status: 'M', additions: 1, deletions: 1, diff: '', staged: true },
			{ filepath: 'old.txt', status: 'D', additions: 0, deletions: 3, diff: '', staged: false },
			{ filepath: 'new.txt', status: 'U', additions: 3, deletions: 0, diff: '', staged: false }
		]);

		const unstagedDiff = await adapter.getFileDiff('new.txt', { staged: false });
		expect(unstagedDiff.originalContent).toBe('');
		expect(unstagedDiff.modifiedContent).toBe('a\nbX\nc\n');
	});

	it('re-probes the rename source so a repository change between calls never serves a stale baseline', async () => {
		const r = await createTrackedRepo();
		await r.write('a.txt', 'content of a\n');
		await r.write('b.txt', 'content of b\n');
		await commitAll(r, 'base');
		await checkedGit(r, ['mv', 'a.txt', 'new.txt']);
		const adapter = spawnEngine.adapter(r);
		await adapter.getChanges();

		await checkedGit(r, ['reset', '-q', '--hard', 'HEAD']);
		await checkedGit(r, ['mv', 'b.txt', 'new.txt']);

		const porcelain = await porcelainStatus(r);
		expect(porcelain).toEqual([{ x: 'R', y: ' ', path: 'new.txt', origPath: 'b.txt' }]);

		const diff = await adapter.getFileDiff('new.txt', { staged: true });
		expect(diff.originalContent).toBe('content of b\n');
		expect(diff.modifiedContent).toBe(await indexContents(r, 'new.txt'));
	});

	it('resolves a rename baseline from a fresh porcelain probe even without a prior getChanges call', async () => {
		const r = await createTrackedRepo();
		await baseRepo(r);
		await checkedGit(r, ['mv', 'src.txt', 'moved.txt']);
		const adapter = spawnEngine.adapter(r);

		// getChanges() is intentionally NOT called: getFileDiff must probe porcelain
		// itself and resolve the rename origin path to read the right HEAD blob.
		const diff = await adapter.getFileDiff('moved.txt', { staged: true });
		expect(diff.originalContent).toBe(SRC_CONTENT);
		expect(diff.modifiedContent).toBe(await indexContents(r, 'moved.txt'));
	});

	it.skipIf(
		!atLeastGit(copyVersion, COPY_DETECTION_FLOOR),
		`requires git >= ${COPY_DETECTION_FLOOR.major}.${COPY_DETECTION_FLOOR.minor}.0 for status copy detection (found ${copyVersion.raw})`
	)('reports a staged identical-content copy as an addition and keeps following entries aligned', async () => {
		const r = await createTrackedRepo();
		await baseRepo(r);
		const config = await r.git(['config', 'status.renames', 'copies']);
		if (config.code !== 0) throw new Error(config.stderr);
		await r.write('copy.txt', SRC_CONTENT);
		await stageAll(r);
		await r.write('README.md', `${README_HEAD}delta\n`);
		const adapter = spawnEngine.adapter(r);

		// With status.renames=copies but an unchanged index source, git status still
		// emits plain 'A' (verified against git 2.55.0, human and porcelain output):
		// copy detection only fires when the source is part of the index diff, and
		// this fixture's source (src.txt) is untouched. 'C'/'CM' appears only when
		// the source is itself staged-modified (see the CM fixture below).
		const porcelain = await porcelainStatus(r);
		expect(porcelain).toEqual([
			{ x: ' ', y: 'M', path: 'README.md' },
			{ x: 'A', y: ' ', path: 'copy.txt' }
		]);

		const changes = await adapter.getChanges();
		expect(changes).toEqual([
			{ filepath: 'README.md', status: 'M', additions: 1, deletions: 0, diff: '', staged: false },
			{ filepath: 'copy.txt', status: 'A', additions: 1, deletions: 0, diff: '', staged: true }
		]);

		const diff = await adapter.getFileDiff('copy.txt', { staged: true });
		expect(diff.originalContent).toBe('');
		expect(diff.modifiedContent).toBe(await indexContents(r, 'copy.txt'));
	});

	it.skipIf(
		!atLeastGit(copyVersion, COPY_DETECTION_FLOOR),
		`requires git >= ${COPY_DETECTION_FLOOR.major}.${COPY_DETECTION_FLOOR.minor}.0 for status copy detection (found ${copyVersion.raw})`
	)('reports a staged copy with unstaged destination edits (CM) as staged plus unstaged entries with an empty copy baseline', async () => {
		const r = await createTrackedRepo();
		await baseRepo(r);
		const config = await r.git(['config', 'status.renames', 'copies']);
		if (config.code !== 0) throw new Error(config.stderr);
		// Copy detection fires only when the source is part of the index diff:
		// stage a modification to src.txt, then stage an identical-content copy of
		// the modified version, then append an unstaged edit at the destination.
		await r.write('src.txt', 'shared\nmore\n');
		await stageAll(r);
		await r.write('copy.txt', 'shared\nmore\n');
		await stageAll(r);
		await r.write('copy.txt', 'shared\nmore\nedit\n');
		const adapter = spawnEngine.adapter(r);

		const porcelain = await porcelainStatus(r);
		expect(porcelain).toEqual([
			{ x: 'C', y: 'M', path: 'copy.txt' },
			{ x: 'M', y: ' ', path: 'src.txt' }
		]);

		const changes = await adapter.getChanges();
		expect(changes).toEqual([
			{ filepath: 'copy.txt', status: 'M', additions: 2, deletions: 0, diff: '', staged: true },
			{ filepath: 'copy.txt', status: 'M', additions: 1, deletions: 0, diff: '', staged: false },
			{ filepath: 'src.txt', status: 'M', additions: 1, deletions: 0, diff: '', staged: true }
		]);

		// The copy baseline is empty (a copy is not a rename): the staged diff
		// compares against nothing, never against the source blob.
		const stagedDiff = await adapter.getFileDiff('copy.txt', { staged: true });
		expect(stagedDiff.originalContent).toBe('');
		expect(stagedDiff.modifiedContent).toBe(await indexContents(r, 'copy.txt'));
	});

	it('does not treat an untracked file as a rename even when a deleted file has identical content', async () => {
		const r = await createTrackedRepo();
		await baseRepo(r);
		await rm(`${r.path}/src.txt`);
		await r.write('new.txt', SRC_CONTENT);
		const adapter = spawnEngine.adapter(r);

		const porcelain = await porcelainStatus(r);
		expect(porcelain).toEqual([
			{ x: ' ', y: 'D', path: 'src.txt' },
			{ x: '?', y: '?', path: 'new.txt' }
		]);

		const unstagedDiff = await adapter.getFileDiff('new.txt', { staged: false });
		expect(unstagedDiff.originalContent).toBe('');
		expect(unstagedDiff.modifiedContent).toBe(SRC_CONTENT);

		const combinedDiff = await adapter.getFileDiff('new.txt');
		expect(combinedDiff.originalContent).toBe('');
		expect(combinedDiff.modifiedContent).toBe(SRC_CONTENT);
	});

	it('does not pair an untracked file with a deleted file when their contents merely resemble each other', async () => {
		const r = await createTrackedRepo();
		await baseRepo(r);
		await rm(`${r.path}/src.txt`);
		await r.write('new.txt', 'shared\nbut a different tail\n');
		const adapter = spawnEngine.adapter(r);

		const porcelain = await porcelainStatus(r);
		expect(porcelain).toEqual([
			{ x: ' ', y: 'D', path: 'src.txt' },
			{ x: '?', y: '?', path: 'new.txt' }
		]);

		const unstagedDiff = await adapter.getFileDiff('new.txt', { staged: false });
		expect(unstagedDiff.originalContent).toBe('');
		expect(unstagedDiff.modifiedContent).toBe('shared\nbut a different tail\n');
	});
});

describe('IsomorphicGitAdapter — engine-specific read contracts', () => {
	it('reports zero numstat for tracked changes until their diff loads on demand', async () => {
		const r = await createTrackedRepo();
		await baseRepo(r);
		await r.write('hello.ts', HELLO_V1);
		await stageAll(r);
		await r.write('hello.ts', HELLO_V2);
		const adapter = isomorphicEngine.adapter(r);

		const changes = await adapter.getChanges();
		expect(changes.every(c => c.additions === 0 && c.deletions === 0)).toBe(true);
	});

	it('represents a worktree rename as delete+add and resolves the deleted HEAD blob as baseline', async () => {
		const r = await createTrackedRepo();
		await baseRepo(r);
		await moveEntry(`${r.path}/src.txt`, `${r.path}/moved.txt`);
		const adapter = isomorphicEngine.adapter(r);

		const changes = await adapter.getChanges();
		expect([...changes].sort((a, b) => a.filepath.localeCompare(b.filepath))).toEqual([
			{ filepath: 'moved.txt', status: 'U', additions: 1, deletions: 0, diff: '', staged: false },
			{ filepath: 'src.txt', status: 'D', additions: 0, deletions: 0, diff: '', staged: false }
		]);

		const combinedDiff = await adapter.getFileDiff('moved.txt');
		expect(combinedDiff.originalContent).toBe(SRC_CONTENT);
		expect(combinedDiff.modifiedContent).toBe(SRC_CONTENT);

		// The rename resolver pairs the worktree blob with the deleted HEAD blob, so even
		// the unstaged scope gets the pre-move content as its baseline.
		const unstagedDiff = await adapter.getFileDiff('moved.txt', { staged: false });
		expect(unstagedDiff.originalContent).toBe(SRC_CONTENT);
		expect(unstagedDiff.modifiedContent).toBe(SRC_CONTENT);
	});

	it('represents a staged git-mv rename as delete+add with the staged content as the added baseline', async () => {
		const r = await createTrackedRepo();
		await baseRepo(r);
		await r.git(['mv', 'src.txt', 'moved.txt']);
		const adapter = isomorphicEngine.adapter(r);

		const changes = await adapter.getChanges();
		expect([...changes].sort((a, b) => a.filepath.localeCompare(b.filepath))).toEqual([
			{ filepath: 'moved.txt', status: 'A', additions: 0, deletions: 0, diff: '', staged: true },
			{ filepath: 'src.txt', status: 'D', additions: 0, deletions: 0, diff: '', staged: true }
		]);

		// The staged blob of moved.txt matches the deleted HEAD blob of src.txt, so the
		// rename resolver recovers the pre-move content as the staged diff baseline.
		const stagedDiff = await adapter.getFileDiff('moved.txt', { staged: true });
		expect(stagedDiff.originalContent).toBe(SRC_CONTENT);
		expect(stagedDiff.modifiedContent).toBe(SRC_CONTENT);
	});

	it('reports a staged identical-content copy as a plain addition, like the git CLI engine', async () => {
		const r = await createTrackedRepo();
		await baseRepo(r);
		await r.write('copy.txt', SRC_CONTENT);
		await stageAll(r);
		const adapter = isomorphicEngine.adapter(r);

		// statusMatrix never detects copies: an identical-content staged copy surfaces
		// as a plain staged addition, matching the spawn engine's porcelain pin.
		const changes = await adapter.getChanges();
		expect(changes).toEqual([
			{ filepath: 'copy.txt', status: 'A', additions: 0, deletions: 0, diff: '', staged: true }
		]);

		const diff = await adapter.getFileDiff('copy.txt', { staged: true });
		expect(diff.originalContent).toBe('');
		expect(diff.modifiedContent).toBe(SRC_CONTENT);
	});
});
