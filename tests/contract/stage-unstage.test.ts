import { expect } from 'bun:test';
import { chmodSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FileOrigin } from '@np/core';
import { toURI } from '@np/core/storage';
import { IsomorphicGitAdapter } from '@np/adapters-browser';
import { browserHandleRegistry } from '@np/adapters-browser';
import { SpawnGitAdapter } from '../../apps/desktop/src/renderer/SpawnGitAdapter';
import type { GitFileAccess } from '../../apps/desktop/src/renderer/SpawnGitAdapter';
import { NodeDirectoryHandle, moveEntry } from './node-fs-handle';
import {
	TestRepo,
	createTrackedRepo,
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
			await r.git(['rm', '-q', '--cached', 'README.md']);
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
			await r.git(['mv', 'src.txt', 'moved.txt']);
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

			// The literal-empty leg is the regression pin: an empty→empty replace
			// renders a `+0,0` hunk that `git apply --cached` rejects as corrupt,
			// so the second write must be skipped without throwing.
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

	describe(`${engine.name} — worktree rename staging`, () => {
		it('stages a worktree rename as a rename with the source removed from the index', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await moveEntry(`${r.path}/src.txt`, `${r.path}/moved.txt`);
			const adapter = engine.adapter(r);

			await adapter.updateIndexContent('moved.txt', SRC_CONTENT);

			expect(await porcelainStatus(r)).toEqual([{ x: 'R', y: ' ', path: 'moved.txt', origPath: 'src.txt' }]);
			expect(await indexContents(r, 'moved.txt')).toBe(SRC_CONTENT);
			expect(await indexContents(r, 'src.txt')).toBe(null);
			expect(await lsFiles(r)).toEqual(['README.md', 'hello.ts', 'moved.txt']);
			expect(await indexMode(r, 'moved.txt')).toBe('100644');
		});

		it('stages spliced content into a worktree-renamed file while keeping the rename', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await moveEntry(`${r.path}/src.txt`, `${r.path}/moved.txt`);
			const adapter = engine.adapter(r);

			await adapter.updateIndexContent('moved.txt', `${SRC_CONTENT}extra\n`);

			expect(await porcelainStatus(r)).toEqual([{ x: 'R', y: 'M', path: 'moved.txt', origPath: 'src.txt' }]);
			expect(await indexContents(r, 'moved.txt')).toBe(`${SRC_CONTENT}extra\n`);
			expect(await indexContents(r, 'src.txt')).toBe(null);
			expect(await worktreeContents(r, 'moved.txt')).toBe(SRC_CONTENT);
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

		it('preserves the source executable mode when staging a worktree-renamed script', async () => {
			const r = await createTrackedRepo();
			await r.write('run.sh', '#!/bin/sh\necho hi\n');
			await commitAll(r, 'add script');
			chmodSync(path.join(r.path, 'run.sh'), 0o755);
			await commitAll(r, 'make executable');
			expect(await indexMode(r, 'run.sh')).toBe('100755');
			await moveEntry(`${r.path}/run.sh`, `${r.path}/runner.sh`);
			const adapter = engine.adapter(r);

			await adapter.updateIndexContent('runner.sh', '#!/bin/sh\necho hi\n');

			// A mode change would surface as RM; the preserved source mode keeps it a
			// clean rename.
			expect(await porcelainStatus(r)).toEqual([{ x: 'R', y: ' ', path: 'runner.sh', origPath: 'run.sh' }]);
			expect(await indexMode(r, 'runner.sh')).toBe('100755');
			expect(await indexContents(r, 'runner.sh')).toBe('#!/bin/sh\necho hi\n');
		});
	});

	describe(`${engine.name} — stale-cache prevention`, () => {
		it('resolves a changed rename source freshly and never mis-targets the old one', async () => {
			const r = await createTrackedRepo();
			await r.write('a.txt', 'line a1\nline a2\nline a3\n');
			await r.write('b.txt', 'line b1\nline b2\nline b3\n');
			await commitAll(r, 'base');
			const adapter = engine.adapter(r);

			// First rename: a.txt -> new.txt, staged as a rename with spliced content.
			// The spliced content keeps two of three lines so git still detects a rename.
			await moveEntry(`${r.path}/a.txt`, `${r.path}/new.txt`);
			await adapter.updateIndexContent('new.txt', 'line a1\nline a2\nEDITED\n');
			expect(await porcelainStatus(r)).toEqual([{ x: 'R', y: 'M', path: 'new.txt', origPath: 'a.txt' }]);

			// The repository is reset and a different rename now occupies new.txt:
			// the write must pair with b.txt, not with the previous source a.txt.
			const reset = await r.git(['reset', '-q', '--hard', 'HEAD']);
			if (reset.code !== 0) throw new Error(reset.stderr);
			await moveEntry(`${r.path}/b.txt`, `${r.path}/new.txt`);
			await adapter.updateIndexContent('new.txt', 'line b1\nline b2\nEDITED\n');

			expect(await porcelainStatus(r)).toEqual([{ x: 'R', y: 'M', path: 'new.txt', origPath: 'b.txt' }]);
			expect(await indexContents(r, 'new.txt')).toBe('line b1\nline b2\nEDITED\n');
			expect(await indexContents(r, 'a.txt')).toBe('line a1\nline a2\nline a3\n');
			expect(await indexContents(r, 'b.txt')).toBe(null);
			expect(await lsFiles(r)).toEqual(['a.txt', 'new.txt']);
		});

		it('stages a rename destination as a plain new file when the source index entry is already gone', async () => {
			const r = await createTrackedRepo();
			await r.write('a.txt', 'content of a\n');
			await r.write('b.txt', 'content of b\n');
			await commitAll(r, 'base');
			const adapter = engine.adapter(r);

			await moveEntry(`${r.path}/a.txt`, `${r.path}/new.txt`);
			// The source disappears from the index entirely before the write: the
			// destination must still be staged with exact content, and no unrelated
			// path may be removed.
			await r.git(['rm', '-q', '--cached', 'a.txt']);
			await adapter.updateIndexContent('new.txt', 'a spliced\n');

			expect(await indexContents(r, 'new.txt')).toBe('a spliced\n');
			expect(await indexContents(r, 'b.txt')).toBe('content of b\n');
			expect(await indexContents(r, 'a.txt')).toBe(null);
			expect(await lsFiles(r)).toEqual(['b.txt', 'new.txt']);
		});

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
