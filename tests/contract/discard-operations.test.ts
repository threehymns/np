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
	copyDetectionGuard,
	createTrackedRepo,
	describe,
	gitVersion,
	it,
	indexContents,
	lsFiles,
	porcelainStatus,
	runGit,
	worktreeContents
} from './harness';

const copyVersion = await gitVersion();

const [skipCopyDetection, copyDetectionReason] = copyDetectionGuard(copyVersion);

function origin(r: TestRepo): FileOrigin {
	return { scheme: 'file', path: r.path, name: 'repo' };
}

const nodeFileAccess: GitFileAccess = {
	readFile: (filePath) => readFile(filePath),
	writeFile: (filePath, content) => writeFile(filePath, content),
	deleteEntry: (filePath) => rm(filePath, { force: true })
};

/** The discard surface under contract: per-file discard across scopes plus bulk discard-all. */
interface DiscardSurface {
	discardChanges(filepath: string, options?: { staged?: boolean }): Promise<void>;
	discardAll(): Promise<void>;
}

interface Engine {
	name: string;
	adapter(r: TestRepo): DiscardSurface;
	/**
	 * Whether a worktree file written through this engine's filesystem can carry
	 * a POSIX mode at all. `BrowserGitFS` has no `chmod` and reports a fixed
	 * `100644` from `stat`, so a file it writes can never be executable — an
	 * engine-capability limit, not a behaviour any restore can work around.
	 */
	preservesFileMode?: boolean;
}

const spawnEngine: Engine = {
	name: 'SpawnGitAdapter (real git)',
	preservesFileMode: true,
	adapter(r) {
		return new SpawnGitAdapter(origin(r), (workingDir, args) => runGit(workingDir, r.env, args), nodeFileAccess);
	}
};

const isomorphicEngine: Engine = {
	name: 'IsomorphicGitAdapter (isomorphic-git over node fs)',
	preservesFileMode: false,
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

const HELLO_V0 = 'const a = 1;\nconst b = 2;\n';
const HELLO_V1 = 'const a = 1;\nconst b = 3;\n';
const SRC_CONTENT = 'shared\n';
const SRC_EDITED = 'shared\nEDITED SRC\n';
const DEST_EDITED = 'shared\nDEST EDITS\n';
const SCRIPT_CONTENT = '#!/bin/sh\necho hi\n';

/** The index mode (`git ls-files -s`) of a path, or null when it has no entry. */
async function indexMode(r: TestRepo, relPath: string): Promise<string | null> {
	const res = await r.git(['ls-files', '-s', '--', relPath]);
	if (res.code !== 0 || !res.stdout.trim()) return null;
	return res.stdout.trim().split(/\s+/)[0] ?? null;
}

const RECREATED_WORKTREE = 'C\nD\nE\n';

/**
 * A file deleted, with the deletion staged, then recreated on disk.
 *
 * git reports this as two entries — `D  src.txt` (in HEAD, gone from the index) and
 * `?? src.txt` (present again, untracked) — and the deletion was never committed, so
 * `src.txt` is still in HEAD with its original `SRC_CONTENT`. Anything that treats
 * the index or HEAD as the answer to "what should this path be" therefore picks
 * `SRC_CONTENT` over the bytes the user can only lose: this content was never
 * staged and never committed, so it exists nowhere else.
 */
async function recreateAfterStagedDelete(r: TestRepo): Promise<void> {
	await baseRepo(r);
	const rm = await r.git(['rm', '-q', '-f', 'src.txt']);
	if (rm.code !== 0) throw new Error(rm.stderr);
	await r.write('src.txt', RECREATED_WORKTREE);
}

/** The `D  ` + `?? ` pair git emits for that state. */
const RECREATED_STATUS: PorcelainEntry[] = [
	{ x: 'D', y: ' ', path: 'src.txt' },
	{ x: '?', y: '?', path: 'src.txt' }
];

for (const engine of [spawnEngine, isomorphicEngine]) {
	describe(`${engine.name} — discard of staged changes`, () => {
		it('discards a staged modification, returning the index and worktree to HEAD', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await r.write('hello.ts', HELLO_V1);
			await stageAll(r);
			const adapter = engine.adapter(r);

			await adapter.discardChanges('hello.ts');

			expect(await porcelainStatus(r)).toEqual([]);
			expect(await indexContents(r, 'hello.ts')).toBe(HELLO_V0);
			expect(await worktreeContents(r, 'hello.ts')).toBe(HELLO_V0);
			expect(await lsFiles(r)).toEqual(['README.md', 'hello.ts', 'src.txt']);
		});

		it('discards a staged addition, removing it from the index and worktree', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await r.write('added.txt', 'new content\n');
			await stageAll(r);
			const adapter = engine.adapter(r);

			await adapter.discardChanges('added.txt');

			expect(await porcelainStatus(r)).toEqual([]);
			expect(await indexContents(r, 'added.txt')).toBe(null);
			expect(await worktreeContents(r, 'added.txt')).toBe(null);
			expect(await lsFiles(r)).toEqual(['README.md', 'hello.ts', 'src.txt']);
		});

		it('discards a staged deletion, restoring the file to the index and worktree', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			const rmRes = await r.git(['rm', '-q', 'README.md']);
			if (rmRes.code !== 0) throw new Error(rmRes.stderr);
			const adapter = engine.adapter(r);
			expect(await porcelainStatus(r)).toEqual([{ x: 'D', y: ' ', path: 'README.md' }]);

			await adapter.discardChanges('README.md');

			expect(await porcelainStatus(r)).toEqual([]);
			expect(await indexContents(r, 'README.md')).toBe('alpha\nbeta\ngamma\n');
			expect(await worktreeContents(r, 'README.md')).toBe('alpha\nbeta\ngamma\n');
			expect(await lsFiles(r)).toEqual(['README.md', 'hello.ts', 'src.txt']);
		});

		it('discards a staged rename by restoring the original path and removing the destination', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			const mvRes = await r.git(['mv', 'src.txt', 'moved.txt']);
			if (mvRes.code !== 0) throw new Error(mvRes.stderr);
			const adapter = engine.adapter(r);
			expect(await porcelainStatus(r)).toEqual([{ x: 'R', y: ' ', path: 'moved.txt', origPath: 'src.txt' }]);

			await adapter.discardChanges('moved.txt');

			// The rename is fully reverted: the original path is back in the index and
			// worktree with its committed content, and the destination is gone everywhere.
			expect(await porcelainStatus(r)).toEqual([]);
			expect(await indexContents(r, 'src.txt')).toBe(SRC_CONTENT);
			expect(await worktreeContents(r, 'src.txt')).toBe(SRC_CONTENT);
			expect(await indexContents(r, 'moved.txt')).toBe(null);
			expect(await worktreeContents(r, 'moved.txt')).toBe(null);
			expect(await lsFiles(r)).toEqual(['README.md', 'hello.ts', 'src.txt']);
		});

		it('discards a staged rename with unstaged destination edits, keeping those edits as an untracked file', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			const mvRes = await r.git(['mv', 'src.txt', 'moved.txt']);
			if (mvRes.code !== 0) throw new Error(mvRes.stderr);
			await r.write('moved.txt', DEST_EDITED);
			const adapter = engine.adapter(r);
			expect(await porcelainStatus(r)).toEqual([{ x: 'R', y: 'M', path: 'moved.txt', origPath: 'src.txt' }]);

			await adapter.discardChanges('moved.txt');

			// The staged rename is reverted in the index, but the user's unstaged edits
			// at the destination survive as an untracked file.
			expect(await porcelainStatus(r)).toEqual([{ x: '?', y: '?', path: 'moved.txt' }]);
			expect(await indexContents(r, 'src.txt')).toBe(SRC_CONTENT);
			expect(await worktreeContents(r, 'src.txt')).toBe(SRC_CONTENT);
			expect(await indexContents(r, 'moved.txt')).toBe(null);
			expect(await worktreeContents(r, 'moved.txt')).toBe(DEST_EDITED);
		});

		it.skipIf(
			skipCopyDetection,
			copyDetectionReason
		)('discards a staged copy without touching the source file', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			const config = await r.git(['config', 'status.renames', 'copies']);
			if (config.code !== 0) throw new Error(config.stderr);
			// The copy source must itself be staged-modified for git to report 'C':
			// the destination is a copy of the source's HEAD content.
			await r.write('src.txt', SRC_EDITED);
			await r.write('copy.txt', SRC_CONTENT);
			await stageAll(r);
			const adapter = engine.adapter(r);
			// Copy entries never record origPath (the harness consumes the source token).
			expect(await porcelainStatus(r)).toEqual([
				{ x: 'C', y: ' ', path: 'copy.txt' },
				{ x: 'M', y: ' ', path: 'src.txt' }
			]);

			await adapter.discardChanges('copy.txt');

			// Only the copy is removed; the staged-modified source is never touched.
			expect(await porcelainStatus(r)).toEqual([{ x: 'M', y: ' ', path: 'src.txt' }]);
			expect(await indexContents(r, 'src.txt')).toBe(SRC_EDITED);
			expect(await worktreeContents(r, 'src.txt')).toBe(SRC_EDITED);
			expect(await indexContents(r, 'copy.txt')).toBe(null);
			expect(await worktreeContents(r, 'copy.txt')).toBe(null);
		});

		it.skipIf(
			skipCopyDetection,
			copyDetectionReason
		)('discards a staged copy with unstaged destination edits, keeping the edits', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			const config = await r.git(['config', 'status.renames', 'copies']);
			if (config.code !== 0) throw new Error(config.stderr);
			await r.write('src.txt', SRC_EDITED);
			await r.write('copy.txt', SRC_CONTENT);
			await stageAll(r);
			await r.write('copy.txt', DEST_EDITED);
			const adapter = engine.adapter(r);
			expect(await porcelainStatus(r)).toEqual([
				{ x: 'C', y: 'M', path: 'copy.txt' },
				{ x: 'M', y: ' ', path: 'src.txt' }
			]);

			await adapter.discardChanges('copy.txt');

			// The staged copy is unstaged and the destination edits survive as an
			// untracked file; the source keeps its staged modification.
			expect(await porcelainStatus(r)).toEqual([
				{ x: 'M', y: ' ', path: 'src.txt' },
				{ x: '?', y: '?', path: 'copy.txt' }
			]);
			expect(await indexContents(r, 'src.txt')).toBe(SRC_EDITED);
			expect(await worktreeContents(r, 'src.txt')).toBe(SRC_EDITED);
			expect(await indexContents(r, 'copy.txt')).toBe(null);
			expect(await worktreeContents(r, 'copy.txt')).toBe(DEST_EDITED);
		});
	});

	describe(`${engine.name} — discard of unstaged changes`, () => {
		it('discards an unstaged modification, returning the worktree to the index', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await r.write('hello.ts', HELLO_V1);
			const adapter = engine.adapter(r);

			await adapter.discardChanges('hello.ts', { staged: false });

			expect(await porcelainStatus(r)).toEqual([]);
			expect(await indexContents(r, 'hello.ts')).toBe(HELLO_V0);
			expect(await worktreeContents(r, 'hello.ts')).toBe(HELLO_V0);
		});

		it('discards only the unstaged half of a staged+unstaged modification, keeping the staged change', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await r.write('hello.ts', HELLO_V1);
			await stageAll(r);
			await r.write('hello.ts', 'const a = 1;\nconst b = 99;\n');
			const adapter = engine.adapter(r);
			expect(await porcelainStatus(r)).toEqual([{ x: 'M', y: 'M', path: 'hello.ts' }]);

			await adapter.discardChanges('hello.ts', { staged: false });

			// The staged modification survives; only the worktree copy is reset to it.
			expect(await porcelainStatus(r)).toEqual([{ x: 'M', y: ' ', path: 'hello.ts' }]);
			expect(await indexContents(r, 'hello.ts')).toBe(HELLO_V1);
			expect(await worktreeContents(r, 'hello.ts')).toBe(HELLO_V1);
		});

		it('leaves a staged rename intact while discarding the worktree copy of its destination', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			const mvRes = await r.git(['mv', 'src.txt', 'moved.txt']);
			if (mvRes.code !== 0) throw new Error(mvRes.stderr);
			const adapter = engine.adapter(r);

			await adapter.discardChanges('moved.txt', { staged: false });

			expect(await porcelainStatus(r)).toEqual([{ x: 'R', y: ' ', path: 'moved.txt', origPath: 'src.txt' }]);
			expect(await indexContents(r, 'moved.txt')).toBe(SRC_CONTENT);
			expect(await worktreeContents(r, 'moved.txt')).toBe(SRC_CONTENT);
		});

		it('discards the unstaged edits at an RM rename destination, keeping the staged rename', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			const mvRes = await r.git(['mv', 'src.txt', 'moved.txt']);
			if (mvRes.code !== 0) throw new Error(mvRes.stderr);
			await r.write('moved.txt', DEST_EDITED);
			const adapter = engine.adapter(r);
			expect(await porcelainStatus(r)).toEqual([{ x: 'R', y: 'M', path: 'moved.txt', origPath: 'src.txt' }]);

			await adapter.discardChanges('moved.txt', { staged: false });

			// The worktree copy is reset to the staged rename content; the staged
			// rename itself is untouched.
			expect(await porcelainStatus(r)).toEqual([{ x: 'R', y: ' ', path: 'moved.txt', origPath: 'src.txt' }]);
			expect(await indexContents(r, 'moved.txt')).toBe(SRC_CONTENT);
			expect(await worktreeContents(r, 'moved.txt')).toBe(SRC_CONTENT);
			expect(await indexContents(r, 'src.txt')).toBe(null);
		});

		it('restores a worktree-deleted tracked file from the index', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await rm(`${r.path}/src.txt`);
			const adapter = engine.adapter(r);

			await adapter.discardChanges('src.txt', { staged: false });

			expect(await porcelainStatus(r)).toEqual([]);
			expect(await worktreeContents(r, 'src.txt')).toBe(SRC_CONTENT);
		});

		it('restores the source and removes the destination of an unstaged worktree rename', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			// Unstaged worktree rename: git never pairs these, so the adapter sees a
			// worktree deletion plus an untracked file rather than a rename.
			await moveEntry(`${r.path}/src.txt`, `${r.path}/moved.txt`);
			const adapter = engine.adapter(r);
			expect(await porcelainStatus(r)).toEqual([
				{ x: ' ', y: 'D', path: 'src.txt' },
				{ x: '?', y: '?', path: 'moved.txt' }
			]);

			await adapter.discardChanges('moved.txt', { staged: false });

			expect(await worktreeContents(r, 'src.txt')).toBe(SRC_CONTENT);
			expect(await worktreeContents(r, 'moved.txt')).toBe(null);
		});

		// The source is recovered by matching the destination's bytes against the
		// index content of paths git reports as worktree-deleted. These two tests pin
		// the cases where that match must NOT fire, so the recovery can never
		// resurrect a file the user did not rename.

		it('treats an edited destination as an untracked file, never resurrecting a deleted source', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			// Same shape as a rename, but the user then edited the destination, so its
			// content no longer matches the source. There is no rename to undo: the
			// deletion is unrelated and must stay deleted.
			await moveEntry(`${r.path}/src.txt`, `${r.path}/moved.txt`);
			await r.write('moved.txt', DEST_EDITED);
			const adapter = engine.adapter(r);

			await adapter.discardChanges('moved.txt', { staged: false });

			// The untracked destination is discarded; the unrelated deletion stands.
			expect(await worktreeContents(r, 'moved.txt')).toBe(null);
			expect(await worktreeContents(r, 'src.txt')).toBe(null);
			expect(await indexContents(r, 'src.txt')).toBe(SRC_CONTENT);
		});

		it('never restores a source that is still present in the worktree', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			// An untracked copy of a tracked file whose source the user still has.
			// Content matching alone would pair these, but the source is not deleted,
			// so there is no rename to undo and the source must not be rewritten.
			await r.write('copy.txt', SRC_CONTENT);
			const adapter = engine.adapter(r);
			expect(await porcelainStatus(r)).toEqual([{ x: '?', y: '?', path: 'copy.txt' }]);

			await adapter.discardChanges('copy.txt', { staged: false });

			expect(await worktreeContents(r, 'copy.txt')).toBe(null);
			expect(await worktreeContents(r, 'src.txt')).toBe(SRC_CONTENT);
			expect(await porcelainStatus(r)).toEqual([]);
		});

		// Byte-identical content does not identify a source: two tracked files can
		// hold the same bytes, and a deletion the user made on purpose is
		// indistinguishable from the source half of a rename. Anything less than a
		// unique match would resurrect a file nobody renamed.

		it('treats a destination matching two deleted sources as an untracked file, restoring neither', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await r.write('dup.txt', SRC_CONTENT);
			await stageAll(r);
			const commit = await r.git(['commit', '-m', 'duplicate content']);
			if (commit.code !== 0) throw new Error(commit.stderr);
			// The user renames src.txt and separately deletes dup.txt on purpose. Both
			// candidates hold identical content, so nothing in the repository says
			// which one moved — and restoring either by guess would resurrect a
			// deliberate deletion or leave the real rename half-undone.
			await moveEntry(`${r.path}/src.txt`, `${r.path}/moved.txt`);
			await rm(`${r.path}/dup.txt`);
			const adapter = engine.adapter(r);
			expect(await porcelainStatus(r)).toEqual([
				{ x: ' ', y: 'D', path: 'dup.txt' },
				{ x: ' ', y: 'D', path: 'src.txt' },
				{ x: '?', y: '?', path: 'moved.txt' }
			]);

			await adapter.discardChanges('moved.txt', { staged: false });

			// Neither candidate is restored: the destination is an untracked file.
			expect(await worktreeContents(r, 'moved.txt')).toBe(null);
			expect(await worktreeContents(r, 'src.txt')).toBe(null);
			expect(await worktreeContents(r, 'dup.txt')).toBe(null);
			// Both deletions stand, and the index still records both files.
			expect(await porcelainStatus(r)).toEqual([
				{ x: ' ', y: 'D', path: 'dup.txt' },
				{ x: ' ', y: 'D', path: 'src.txt' }
			]);
			expect(await indexContents(r, 'src.txt')).toBe(SRC_CONTENT);
			expect(await indexContents(r, 'dup.txt')).toBe(SRC_CONTENT);
		});

		it('restores a unique byte-identical match, which is the whole limit of what a rename can be proven to be', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			// Exactly one worktree deletion whose index content equals the untracked
			// destination. The user could equally have deleted src.txt on purpose and
			// then written a new file that happens to hold the same bytes: no git
			// invocation separates the two shapes, so the adapter commits to the
			// recovery. This test pins that boundary deliberately rather than leaving
			// it implied -- the only thing that makes the pairing decidable is that
			// the match is unique, and the test above shows what uniqueness buys.
			await rm(`${r.path}/src.txt`);
			await r.write('notes.txt', SRC_CONTENT);
			const adapter = engine.adapter(r);
			expect(await porcelainStatus(r)).toEqual([
				{ x: ' ', y: 'D', path: 'src.txt' },
				{ x: '?', y: '?', path: 'notes.txt' }
			]);

			await adapter.discardChanges('notes.txt', { staged: false });

			// The single matching candidate is recovered, and the destination goes.
			expect(await worktreeContents(r, 'notes.txt')).toBe(null);
			expect(await worktreeContents(r, 'src.txt')).toBe(SRC_CONTENT);
			expect(await porcelainStatus(r)).toEqual([]);
		});

		// The restored source is written from the index, and the index is the only
		// place this platform can read a POSIX mode from: a browser exposes none.
		// So the restore has to carry the index mode across with the bytes, or the
		// repository is left permanently modified by a discard that restored
		// exactly what was committed.
		//
		// The isomorphic engine cannot honour this however the restore is written.
		// `BrowserGitFS` has no `chmod`, and its `stat` reports a fixed 100644 for
		// every file (measured: a 755 file on disk reads back as 100644), so no
		// restore through it can produce an executable file. Its own `stageAll`
		// already collapses 100755 to 100644 in the index on the same fixture, so
		// the mode is not reliably present to copy either. That is the engine's
		// filesystem, not this recovery, and it is tracked with the exec-bit work
		// in #214 — so the test is scoped to engines that can express a mode
		// instead of asserting a capability the engine does not have.
		it.skipIf(
			engine.preservesFileMode === false,
			'BrowserGitFS cannot express a POSIX mode: no chmod, and stat reports 100644 for every file'
		)('restores the index mode of a renamed executable source, leaving the repository clean', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await r.write('run.sh', SCRIPT_CONTENT);
			chmodSync(path.join(r.path, 'run.sh'), 0o755);
			await stageAll(r);
			const commit = await r.git(['commit', '-m', 'executable']);
			if (commit.code !== 0) throw new Error(commit.stderr);
			await moveEntry(`${r.path}/run.sh`, `${r.path}/moved.sh`);
			const adapter = engine.adapter(r);
			// The index records 100755; the worktree simply lost the file.
			expect(await indexMode(r, 'run.sh')).toBe('100755');
			expect(await porcelainStatus(r)).toEqual([
				{ x: ' ', y: 'D', path: 'run.sh' },
				{ x: '?', y: '?', path: 'moved.sh' }
			]);

			await adapter.discardChanges('moved.sh', { staged: false });

			// The bytes come back, and so must the executable bit. Restoring the
			// file non-executable is a modification nobody made: porcelain would
			// report the source as dirty against an index that says otherwise.
			expect(await worktreeContents(r, 'run.sh')).toBe(SCRIPT_CONTENT);
			expect(await indexMode(r, 'run.sh')).toBe('100755');
			expect(await porcelainStatus(r)).toEqual([]);
			expect(await worktreeContents(r, 'moved.sh')).toBe(null);
		});
	});

	describe(`${engine.name} — discard of untracked files`, () => {
		it('cleans an untracked file without touching unrelated worktree deletions', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await r.write('added.txt', 'untracked\n');
			await rm(`${r.path}/src.txt`);
			const adapter = engine.adapter(r);
			expect(await porcelainStatus(r)).toEqual([
				{ x: ' ', y: 'D', path: 'src.txt' },
				{ x: '?', y: '?', path: 'added.txt' }
			]);

			await adapter.discardChanges('added.txt', { staged: false });

			// Only the untracked file is cleaned; the unrelated deletion is never
			// restored or staged.
			expect(await porcelainStatus(r)).toEqual([{ x: ' ', y: 'D', path: 'src.txt' }]);
			expect(await worktreeContents(r, 'added.txt')).toBe(null);
			expect(await worktreeContents(r, 'src.txt')).toBe(null);
			expect(await indexContents(r, 'src.txt')).toBe(SRC_CONTENT);
		});

		it('keeps a recreated file when discarding its unstaged changes', async () => {
			const r = await createTrackedRepo();
			await recreateAfterStagedDelete(r);
			const adapter = engine.adapter(r);
			expect(await porcelainStatus(r)).toEqual(RECREATED_STATUS);

			await adapter.discardChanges('src.txt', { staged: false });

			// The unstaged copy is the only copy of `C\nD\nE\n`, so discarding
			// unstaged changes must not remove it. In git's model that copy is
			// untracked, so there are no unstaged changes to revert, and the state
			// is left exactly as it was rather than half-acted on.
			expect(await worktreeContents(r, 'src.txt')).toBe(RECREATED_WORKTREE);
			expect(await porcelainStatus(r)).toEqual(RECREATED_STATUS);
		});

		it('cleans an untracked file without a scope, never touching unrelated worktree deletions', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			await r.write('added.txt', 'untracked\n');
			await rm(`${r.path}/src.txt`);
			const adapter = engine.adapter(r);

			await adapter.discardChanges('added.txt');

			expect(await porcelainStatus(r)).toEqual([{ x: ' ', y: 'D', path: 'src.txt' }]);
			expect(await worktreeContents(r, 'added.txt')).toBe(null);
			expect(await worktreeContents(r, 'src.txt')).toBe(null);
			expect(await indexContents(r, 'src.txt')).toBe(SRC_CONTENT);
		});

		it('cleans an untracked file without touching unrelated staged renames', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			const mvRes = await r.git(['mv', 'src.txt', 'moved.txt']);
			if (mvRes.code !== 0) throw new Error(mvRes.stderr);
			await r.write('added.txt', 'untracked\n');
			const adapter = engine.adapter(r);
			expect(await porcelainStatus(r)).toEqual([
				{ x: 'R', y: ' ', path: 'moved.txt', origPath: 'src.txt' },
				{ x: '?', y: '?', path: 'added.txt' }
			]);

			await adapter.discardChanges('added.txt');

			// Only the untracked file is cleaned; the unrelated staged rename is untouched.
			expect(await porcelainStatus(r)).toEqual([{ x: 'R', y: ' ', path: 'moved.txt', origPath: 'src.txt' }]);
			expect(await worktreeContents(r, 'added.txt')).toBe(null);
			expect(await indexContents(r, 'moved.txt')).toBe(SRC_CONTENT);
			expect(await worktreeContents(r, 'moved.txt')).toBe(SRC_CONTENT);
			expect(await indexContents(r, 'src.txt')).toBe(null);
		});
	});

	describe(`${engine.name} — bulk discard`, () => {
		it('discardAll restores every tracked change and removes every untracked file in one operation', async () => {
			const r = await createTrackedRepo();
			await baseRepo(r);
			// Staged + unstaged modification, staged addition, staged deletion, and
			// untracked files (top-level and nested).
			await r.write('hello.ts', HELLO_V1);
			await stageAll(r);
			await r.write('added.txt', 'new content\n');
			await stageAll(r);
			await r.write('hello.ts', 'const a = 1;\nconst b = 99;\n');
			const rmRes = await r.git(['rm', '-q', 'README.md']);
			if (rmRes.code !== 0) throw new Error(rmRes.stderr);
			await r.write('untracked.txt', 'untracked\n');
			await r.write('nested/deep.txt', 'nested untracked\n');
			const adapter = engine.adapter(r);
			expect(await porcelainStatus(r)).toEqual([
				{ x: 'D', y: ' ', path: 'README.md' },
				{ x: 'A', y: ' ', path: 'added.txt' },
				{ x: 'M', y: 'M', path: 'hello.ts' },
				{ x: '?', y: '?', path: 'nested/deep.txt' },
				{ x: '?', y: '?', path: 'untracked.txt' }
			]);

			await adapter.discardAll();

			expect(await porcelainStatus(r)).toEqual([]);
			expect(await indexContents(r, 'hello.ts')).toBe(HELLO_V0);
			expect(await worktreeContents(r, 'hello.ts')).toBe(HELLO_V0);
			expect(await indexContents(r, 'README.md')).toBe('alpha\nbeta\ngamma\n');
			expect(await worktreeContents(r, 'README.md')).toBe('alpha\nbeta\ngamma\n');
			expect(await indexContents(r, 'added.txt')).toBe(null);
			expect(await worktreeContents(r, 'added.txt')).toBe(null);
			expect(await worktreeContents(r, 'untracked.txt')).toBe(null);
			expect(await worktreeContents(r, 'nested/deep.txt')).toBe(null);
			expect(await lsFiles(r)).toEqual(['README.md', 'hello.ts', 'src.txt']);
		});

		it('discardAll keeps a recreated file while still restoring everything else', async () => {
			const r = await createTrackedRepo();
			await recreateAfterStagedDelete(r);
			// An ordinary staged edit plus an untracked file, so the discard has real
			// work to do alongside the path it must leave alone. Only `hello.ts` is
			// staged: `add -A` would stage the recreated file back into the index and
			// end the state under test.
			await r.write('hello.ts', HELLO_V1);
			const add = await r.git(['add', 'hello.ts']);
			if (add.code !== 0) throw new Error(add.stderr);
			await r.write('untracked.txt', 'untracked\n');
			const adapter = engine.adapter(r);
			expect(await porcelainStatus(r)).toEqual([
				{ x: 'M', y: ' ', path: 'hello.ts' },
				...RECREATED_STATUS,
				{ x: '?', y: '?', path: 'untracked.txt' }
			]);

			await adapter.discardAll();

			// Every other change is discarded, and the recreated file survives: its
			// content is in neither the index nor HEAD, so restoring "everything"
			// from them is what destroys it. The staged deletion also survives the
			// restore, which is why the file is left looking deleted-with-a-copy.
			expect(await worktreeContents(r, 'src.txt')).toBe(RECREATED_WORKTREE);
			expect(await worktreeContents(r, 'hello.ts')).toBe(HELLO_V0);
			expect(await worktreeContents(r, 'untracked.txt')).toBe(null);
			expect(await porcelainStatus(r)).toEqual(RECREATED_STATUS);
		});
	});

	describe(`${engine.name} — error propagation`, () => {
		it.skipIf(
			process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0),
			'skipped on Windows (no POSIX mode bits) and as root (read-only permissions do not block writes)'
		)('discardChanges surfaces a failed restore as an error instead of a silent no-op', async () => {
			const r = await createTrackedRepo();
			await r.write('sub/mod.txt', 'base line\n');
			const add = await r.git(['add', '-A']);
			if (add.code !== 0) throw new Error(add.stderr);
			const commit = await r.git(['commit', '-m', 'base']);
			if (commit.code !== 0) throw new Error(commit.stderr);
			await r.write('sub/mod.txt', 'changed line\n');
			// A read-only file inside a read-only directory defeats both engines'
			// overwrite strategies (direct write for isomorphic-git, unlink for git).
			chmodSync(path.join(r.path, 'sub', 'mod.txt'), 0o444);
			chmodSync(path.join(r.path, 'sub'), 0o555);
			try {
				const adapter = engine.adapter(r);
				await expect(adapter.discardChanges('sub/mod.txt', { staged: false })).rejects.toThrow();
				// The worktree copy must survive a failed discard.
				expect(await worktreeContents(r, 'sub/mod.txt')).toBe('changed line\n');
			} finally {
				chmodSync(path.join(r.path, 'sub', 'mod.txt'), 0o644);
				chmodSync(path.join(r.path, 'sub'), 0o755);
			}
		});
	});
}
