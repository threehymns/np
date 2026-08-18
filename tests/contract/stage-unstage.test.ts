import { expect } from 'bun:test';
import { chmodSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { FileOrigin } from '@np/core';
import { toURI } from '@np/core/storage';
import { IsomorphicGitAdapter } from '@np/adapters-browser';
import { browserHandleRegistry } from '@np/adapters-browser';
import { SpawnGitAdapter } from '../../apps/desktop/src/renderer/SpawnGitAdapter';
import { NodeDirectoryHandle, moveEntry } from './node-fs-handle';
import {
	TestRepo,
	checkedGit,
	createTrackedRepo,
	describe,
	it,
	indexContents,
	lsFiles,
	nodeFileAccess,
	porcelainStatus,
	runGit,
	worktreeContents
} from './harness';

function origin(r: TestRepo): FileOrigin {
	return { scheme: 'file', path: r.path, name: 'repo' };
}

/** The staging surface under contract: per-file and bulk stage/unstage plus the index-content engine. */
interface StageUnstage {
	stageFile(filepath: string): Promise<void>;
	unstageFile(filepath: string): Promise<void>;
	stageAll(): Promise<void>;
	unstageAll(): Promise<void>;
	updateIndexContent(filepath: string, content: string): Promise<void>;
}

interface Engine {
	name: string;
	adapter(r: TestRepo): StageUnstage;
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

const HELLO_V0 = 'const a = 1;\nconst b = 2;\n';
const HELLO_V1 = 'const a = 1;\nconst b = 3;\n';
const SRC_CONTENT = 'shared\n';

/** The index mode (`git ls-files -s`) of a path, or null when it has no entry. */
async function indexMode(r: TestRepo, relPath: string): Promise<string | null> {
	const res = await r.git(['ls-files', '-s', '--', relPath]);
	if (res.code !== 0 || !res.stdout.trim()) return null;
	return res.stdout.trim().split(/\s+/)[0] ?? null;
}

for (const engine of [spawnEngine, isomorphicEngine]) {
	describe(`${engine.name} — per-file and bulk stage/unstage`, () => {
		it('stages an unstaged modification per-file, matching the index to the worktree', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await r.write('hello.ts', HELLO_V1);
			const adapter = engine.adapter(r);

			await adapter.stageFile('hello.ts');

			expect(await porcelainStatus(r)).toEqual([{ x: 'M', y: ' ', path: 'hello.ts' }]);
			expect(await indexContents(r, 'hello.ts')).toBe(HELLO_V1);
			expect(await indexContents(r, 'hello.ts')).toBe(await worktreeContents(r, 'hello.ts'));
			expect(await lsFiles(r)).toEqual(['README.md', 'hello.ts', 'src.txt']);
		});

		it('stages an untracked file per-file, adding it to the index', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await r.write('added.txt', 'new content\n');
			const adapter = engine.adapter(r);

			await adapter.stageFile('added.txt');

			expect(await porcelainStatus(r)).toEqual([{ x: 'A', y: ' ', path: 'added.txt' }]);
			expect(await indexContents(r, 'added.txt')).toBe('new content\n');
			expect(await lsFiles(r)).toEqual(['README.md', 'added.txt', 'hello.ts', 'src.txt']);
		});

		it('stages a worktree deletion per-file without touching the worktree', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await rm(`${r.path}/hello.ts`);
			const adapter = engine.adapter(r);

			await adapter.stageFile('hello.ts');

			expect(await porcelainStatus(r)).toEqual([{ x: 'D', y: ' ', path: 'hello.ts' }]);
			expect(await indexContents(r, 'hello.ts')).toBe(null);
			expect(await lsFiles(r)).toEqual(['README.md', 'src.txt']);
			expect(await worktreeContents(r, 'hello.ts')).toBe(null);
		});

		it('unstages a staged modification per-file, restoring HEAD content to the index', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await r.write('hello.ts', HELLO_V1);
			await stageAll(r);
			const adapter = engine.adapter(r);

			await adapter.unstageFile('hello.ts');

			expect(await porcelainStatus(r)).toEqual([{ x: ' ', y: 'M', path: 'hello.ts' }]);
			expect(await indexContents(r, 'hello.ts')).toBe(HELLO_V0);
			expect(await worktreeContents(r, 'hello.ts')).toBe(HELLO_V1);
		});

		it('unstages a staged addition per-file, removing it from the index', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await r.write('added.txt', 'new content\n');
			await stageAll(r);
			const adapter = engine.adapter(r);

			await adapter.unstageFile('added.txt');

			expect(await porcelainStatus(r)).toEqual([{ x: '?', y: '?', path: 'added.txt' }]);
			expect(await indexContents(r, 'added.txt')).toBe(null);
			expect(await lsFiles(r)).toEqual(['README.md', 'hello.ts', 'src.txt']);
			expect(await worktreeContents(r, 'added.txt')).toBe('new content\n');
		});

		it('unstages a staged delete per-file, restoring the file to the index', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await checkedGit(r, ['rm', '-q', '--cached', 'README.md']);
			const adapter = engine.adapter(r);
			// Porcelain reports the staged delete (`D `) and the now-untracked
			// worktree file (`??`) as separate comparisons.
			expect(await porcelainStatus(r)).toEqual([
				{ x: 'D', y: ' ', path: 'README.md' },
				{ x: '?', y: '?', path: 'README.md' }
			]);

			await adapter.unstageFile('README.md');

			expect(await porcelainStatus(r)).toEqual([]);
			expect(await indexContents(r, 'README.md')).toBe('alpha\nbeta\ngamma\n');
		});

		it('unstaging a staged rename per-file restores the source to the index', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await checkedGit(r, ['mv', 'src.txt', 'moved.txt']);
			const adapter = engine.adapter(r);
			expect(await porcelainStatus(r)).toEqual([{ x: 'R', y: ' ', path: 'moved.txt', origPath: 'src.txt' }]);

			await adapter.unstageFile('moved.txt');

			// The rename is reverted in the index: the source is restored and the
			// destination is untracked again, exactly what `git reset HEAD` yields.
			expect(await porcelainStatus(r)).toEqual([
				{ x: ' ', y: 'D', path: 'src.txt' },
				{ x: '?', y: '?', path: 'moved.txt' }
			]);
			expect(await indexContents(r, 'src.txt')).toBe(SRC_CONTENT);
			expect(await indexContents(r, 'moved.txt')).toBe(null);
			expect(await worktreeContents(r, 'moved.txt')).toBe(SRC_CONTENT);
		});

		it('stageAll stages modifications, additions, and deletions in one operation', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await r.write('hello.ts', HELLO_V1);
			await r.write('added.txt', 'new content\n');
			await rm(`${r.path}/src.txt`);
			const adapter = engine.adapter(r);

			await adapter.stageAll();

			expect(await porcelainStatus(r)).toEqual([
				{ x: 'A', y: ' ', path: 'added.txt' },
				{ x: 'M', y: ' ', path: 'hello.ts' },
				{ x: 'D', y: ' ', path: 'src.txt' }
			]);
			expect(await indexContents(r, 'hello.ts')).toBe(await worktreeContents(r, 'hello.ts'));
			expect(await indexContents(r, 'added.txt')).toBe('new content\n');
			expect(await indexContents(r, 'src.txt')).toBe(null);
		});

		it('stageAll on a worktree rename produces a staged rename', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await moveEntry(`${r.path}/src.txt`, `${r.path}/moved.txt`);
			const adapter = engine.adapter(r);

			await adapter.stageAll();

			expect(await porcelainStatus(r)).toEqual([{ x: 'R', y: ' ', path: 'moved.txt', origPath: 'src.txt' }]);
			expect(await indexContents(r, 'moved.txt')).toBe(SRC_CONTENT);
			expect(await indexContents(r, 'src.txt')).toBe(null);
		});

		it('unstageAll returns the index to HEAD for every staged change', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await r.write('hello.ts', HELLO_V1);
			await r.write('added.txt', 'new content\n');
			await stageAll(r);
			await r.git(['rm', '-q', '--cached', 'README.md']);
			const adapter = engine.adapter(r);

			await adapter.unstageAll();

			// Porcelain lists index entries first, then untracked files.
			expect(await porcelainStatus(r)).toEqual([
				{ x: ' ', y: 'M', path: 'hello.ts' },
				{ x: '?', y: '?', path: 'added.txt' }
			]);
			expect(await indexContents(r, 'hello.ts')).toBe(HELLO_V0);
			expect(await indexContents(r, 'added.txt')).toBe(null);
			expect(await indexContents(r, 'README.md')).toBe('alpha\nbeta\ngamma\n');
		});
	});

	describe(`${engine.name} — index-content engine`, () => {
		it('writes the exact content to the index without touching the worktree', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await r.write('hello.ts', HELLO_V1);
			const adapter = engine.adapter(r);

			await adapter.updateIndexContent('hello.ts', 'const a = 1;\nconst b = 99;\n');

			expect(await indexContents(r, 'hello.ts')).toBe('const a = 1;\nconst b = 99;\n');
			expect(await worktreeContents(r, 'hello.ts')).toBe(HELLO_V1);
			expect(await porcelainStatus(r)).toEqual([{ x: 'M', y: 'M', path: 'hello.ts' }]);
			expect(await indexMode(r, 'hello.ts')).toBe('100644');
		});

		it('writes empty content to the index for a tracked file', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			const adapter = engine.adapter(r);

			await adapter.updateIndexContent('hello.ts', '');

			expect(await indexContents(r, 'hello.ts')).toBe('');
			expect(await worktreeContents(r, 'hello.ts')).toBe(HELLO_V0);
		});

		it('writes identical content as a no-op, leaving the index and worktree untouched', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			const adapter = engine.adapter(r);
			expect(await porcelainStatus(r)).toEqual([]);

			await adapter.updateIndexContent('hello.ts', HELLO_V0);

			// The index already holds exactly this content: the write must be
			// skipped entirely, leaving status, index, and worktree untouched.
			expect(await indexContents(r, 'hello.ts')).toBe(HELLO_V0);
			expect(await worktreeContents(r, 'hello.ts')).toBe(HELLO_V0);
			expect(await porcelainStatus(r)).toEqual([]);
		});

		it('writes empty content to an already empty index entry as a no-op without throwing', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			const adapter = engine.adapter(r);

			// An empty→empty replace renders a `+0,0` hunk that `git apply --cached`
			// rejects as corrupt, so sequential empty writes must be skipped cleanly.
			await adapter.updateIndexContent('hello.ts', '');
			await adapter.updateIndexContent('hello.ts', '');

			expect(await indexContents(r, 'hello.ts')).toBe('');
			expect(await worktreeContents(r, 'hello.ts')).toBe(HELLO_V0);
			expect(await porcelainStatus(r)).toEqual([{ x: 'M', y: 'M', path: 'hello.ts' }]);
		});

		it('writes content without a trailing newline to the index exactly as given', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			const adapter = engine.adapter(r);

			await adapter.updateIndexContent('hello.ts', 'no trailing newline');

			expect(await indexContents(r, 'hello.ts')).toBe('no trailing newline');
			expect(await worktreeContents(r, 'hello.ts')).toBe(HELLO_V0);
			expect(await porcelainStatus(r)).toEqual([{ x: 'M', y: 'M', path: 'hello.ts' }]);
		});

		it('writes a lone-newline file to the index in both directions without a corrupt patch', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			const adapter = engine.adapter(r);

			// HELLO_V0 (2 lines) → "\n": the hunk claims one line on each side, so
			// the newline-only side must render a lone +/- line (as git's own diff
			// does) or git apply rejects the patch as corrupt.
			await adapter.updateIndexContent('hello.ts', '\n');

			expect(await indexContents(r, 'hello.ts')).toBe('\n');
			expect(await worktreeContents(r, 'hello.ts')).toBe(HELLO_V0);
			expect(await porcelainStatus(r)).toEqual([{ x: 'M', y: 'M', path: 'hello.ts' }]);

			// "\n" → HELLO_V0: the reverse transition must round-trip too. HELLO_V0
			// is the committed content, so the write restores HEAD fully.
			await adapter.updateIndexContent('hello.ts', HELLO_V0);

			expect(await indexContents(r, 'hello.ts')).toBe(HELLO_V0);
			expect(await worktreeContents(r, 'hello.ts')).toBe(HELLO_V0);
			expect(await porcelainStatus(r)).toEqual([]);
		});

		it('stages a lone-newline untracked file through the index-content engine', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await r.write('added.txt', 'worktree copy\n');
			const adapter = engine.adapter(r);

			await adapter.updateIndexContent('added.txt', '\n');

			expect(await indexContents(r, 'added.txt')).toBe('\n');
			expect(await worktreeContents(r, 'added.txt')).toBe('worktree copy\n');
			expect(await porcelainStatus(r)).toEqual([{ x: 'A', y: 'M', path: 'added.txt' }]);
			expect(await indexMode(r, 'added.txt')).toBe('100644');
		});

		it('stages an untracked file with exact content without touching the worktree', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await r.write('added.txt', 'worktree copy\n');
			const adapter = engine.adapter(r);

			await adapter.updateIndexContent('added.txt', 'staged copy\n');

			expect(await indexContents(r, 'added.txt')).toBe('staged copy\n');
			expect(await worktreeContents(r, 'added.txt')).toBe('worktree copy\n');
			expect(await porcelainStatus(r)).toEqual([{ x: 'A', y: 'M', path: 'added.txt' }]);
			expect(await indexMode(r, 'added.txt')).toBe('100644');
		});

		it('stages content into a hollowed index entry without mis-targeting other paths', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			// The index entry is removed while HEAD and the worktree keep the file;
			// the write must re-add the exact content without touching other entries.
			await r.git(['rm', '-q', '--cached', 'README.md']);
			const adapter = engine.adapter(r);
			expect(await indexContents(r, 'README.md')).toBe(null);

			await adapter.updateIndexContent('README.md', 're-staged\n');

			expect(await indexContents(r, 'README.md')).toBe('re-staged\n');
			expect(await porcelainStatus(r)).toEqual([{ x: 'M', y: 'M', path: 'README.md' }]);
			expect(await lsFiles(r)).toEqual(['README.md', 'hello.ts', 'src.txt']);
			expect(await indexContents(r, 'hello.ts')).toBe(HELLO_V0);
		});

		it('never removes an unrelated worktree-deleted path when staging a new untracked file', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await rm(`${r.path}/src.txt`);
			await r.write('other.txt', 'unrelated\n');
			const adapter = engine.adapter(r);

			await adapter.updateIndexContent('other.txt', 'staged\n');

			expect(await indexContents(r, 'src.txt')).toBe(SRC_CONTENT);
			expect(await indexContents(r, 'other.txt')).toBe('staged\n');
			// Index entries come before untracked files in porcelain output.
			expect(await porcelainStatus(r)).toEqual([
				{ x: 'A', y: 'M', path: 'other.txt' },
				{ x: ' ', y: 'D', path: 'src.txt' }
			]);
		});
	});

	describe(`${engine.name} — hunk index update isolation and rename handling`, () => {
		it('stages an untracked file into the index without modifying other files', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await r.write('new-file.txt', 'new content\n');
			const adapter = engine.adapter(r);

			await adapter.updateIndexContent('new-file.txt', 'new content\n');

			expect(await porcelainStatus(r)).toEqual([{ x: 'A', y: ' ', path: 'new-file.txt' }]);
			expect(await indexContents(r, 'new-file.txt')).toBe('new content\n');
			expect(await lsFiles(r)).toEqual(['README.md', 'hello.ts', 'new-file.txt', 'src.txt']);
			expect(await indexMode(r, 'new-file.txt')).toBe('100644');
		});

		it('preserves the executable index mode of an existing entry across updateIndexContent', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			// Make the tracked file executable so its index entry carries 100755.
			chmodSync(path.join(r.path, 'hello.ts'), 0o755);
			await stageAll(r);
			expect(await indexMode(r, 'hello.ts')).toBe('100755');
			const adapter = engine.adapter(r);

			await adapter.updateIndexContent('hello.ts', `${HELLO_V0}extra\n`);

			// A content write must never reset the mode back to the default: the
			// replace path keeps the index entry's mode (no mode header in the
			// patch), the new-file path is the only one allowed to use the default.
			expect(await indexMode(r, 'hello.ts')).toBe('100755');
			expect(await indexContents(r, 'hello.ts')).toBe(`${HELLO_V0}extra\n`);
		});

		it('writes spliced content into a destination already staged as a rename', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			// The rename is already staged when the write arrives (porcelain RM):
			// the destination is in the index, so the write takes the replace
			// branch and must keep the rename pair intact.
			await r.git(['mv', 'src.txt', 'moved.txt']);
			await stageAll(r);
			const adapter = engine.adapter(r);
			expect(await porcelainStatus(r)).toEqual([{ x: 'R', y: ' ', path: 'moved.txt', origPath: 'src.txt' }]);

			await adapter.updateIndexContent('moved.txt', `${SRC_CONTENT}extra\n`);

			expect(await porcelainStatus(r)).toEqual([{ x: 'R', y: 'M', path: 'moved.txt', origPath: 'src.txt' }]);
			expect(await indexContents(r, 'moved.txt')).toBe(`${SRC_CONTENT}extra\n`);
			expect(await worktreeContents(r, 'moved.txt')).toBe(SRC_CONTENT);
			expect(await indexContents(r, 'src.txt')).toBe(null);
			expect(await lsFiles(r)).toEqual(['README.md', 'hello.ts', 'moved.txt']);
		});

		it('does not stage deletion of an unrelated deleted file when staging an untracked file with identical content', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			// src.txt is deleted in the worktree but NOT staged as deleted in the index
			await rm(`${r.path}/src.txt`);
			// An unrelated new file happens to have identical content to src.txt
			await r.write('unrelated.txt', SRC_CONTENT);
			const adapter = engine.adapter(r);

			// Status before: src.txt is worktree-deleted, unrelated.txt is untracked
			expect(await porcelainStatus(r)).toEqual([
				{ x: ' ', y: 'D', path: 'src.txt' },
				{ x: '?', y: '?', path: 'unrelated.txt' }
			]);

			// Stage hunk/content on unrelated.txt only
			await adapter.updateIndexContent('unrelated.txt', SRC_CONTENT);

			// src.txt MUST remain untouched in the index (not staged as deleted);
			// unrelated.txt is staged as an addition (A).
			expect(await porcelainStatus(r)).toEqual([
				{ x: ' ', y: 'D', path: 'src.txt' },
				{ x: 'A', y: ' ', path: 'unrelated.txt' }
			]);
			expect(await indexContents(r, 'src.txt')).toBe(SRC_CONTENT);
			expect(await indexContents(r, 'unrelated.txt')).toBe(SRC_CONTENT);
			expect(await lsFiles(r)).toEqual(['README.md', 'hello.ts', 'src.txt', 'unrelated.txt']);
		});
	});

	describe(`${engine.name} — stale-cache prevention`, () => {

		it('unstaging after the rename source changed targets the fresh source', async () => {
			const r = await createTrackedRepo();
			await r.write('a.txt', 'content of a\n');
			await r.write('b.txt', 'content of b\n');
			await commitAll(r, 'base');
			const adapter = engine.adapter(r);

			await r.git(['mv', 'a.txt', 'new.txt']);
			const reset = await r.git(['reset', '-q', '--hard', 'HEAD']);
			if (reset.code !== 0) throw new Error(reset.stderr);
			await r.git(['mv', 'b.txt', 'new.txt']);

			await adapter.unstageFile('new.txt');

			expect(await porcelainStatus(r)).toEqual([
				{ x: ' ', y: 'D', path: 'b.txt' },
				{ x: '?', y: '?', path: 'new.txt' }
			]);
			expect(await indexContents(r, 'a.txt')).toBe('content of a\n');
			expect(await indexContents(r, 'b.txt')).toBe('content of b\n');
			expect(await indexContents(r, 'new.txt')).toBe(null);
		});
	});
}
