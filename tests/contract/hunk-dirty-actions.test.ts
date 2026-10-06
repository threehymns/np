import './rune-setup';

import { expect } from 'bun:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { Text } from '../../packages/core/node_modules/@codemirror/state';
import { Chunk } from '../../packages/core/node_modules/@codemirror/merge';
import { DocumentSession } from '../../packages/core/src/document.svelte';
import { applyHunkAction, type HunkRange } from '../../packages/core/src/plugins/git/commands';
import { Repository } from '../../packages/core/src/project/repository.svelte';
import type { AppState } from '../../packages/core/src/state.svelte';
import type { FileOrigin, Storage } from '@np/core';
import type { VCSAdapter } from '@np/core/project/vcs';
import { IsomorphicGitAdapter, browserHandleRegistry } from '@np/adapters-browser';
import { SpawnGitAdapter, type GitFileAccess } from '../../apps/desktop/src/renderer/SpawnGitAdapter';
import { NodeDirectoryHandle } from './node-fs-handle';
import { toURI } from '@np/core/storage';
import {
	TestRepo,
	createTrackedRepo,
	describe,
	it,
	indexContents,
	porcelainStatus,
	runGit,
	workingTreeContents
} from './harness';

const nodeFileAccess: GitFileAccess = {
	readFile: (path) => readFile(path),
	writeFile: (path, content) => writeFile(path, content),
	deleteEntry: (path) => rm(path, { force: true })
};

interface Engine {
	name: string;
	adapter(r: TestRepo): VCSAdapter;
	rootOrigin(r: TestRepo): FileOrigin;
}

const spawnEngine: Engine = {
	name: 'SpawnGitAdapter (real git)',
	adapter(r) {
		return new SpawnGitAdapter(
			{ scheme: 'file', path: r.path, name: 'repo' },
			(workingDir, args) => runGit(workingDir, r.env, args),
			nodeFileAccess
		);
	},
	rootOrigin(r) {
		return { scheme: 'file', path: r.path, name: 'repo' };
	}
};

const isomorphicEngine: Engine = {
	name: 'IsomorphicGitAdapter (isomorphic-git over node fs)',
	adapter(r) {
		const repoOrigin: FileOrigin = { scheme: 'browser', path: r.path, name: 'repo' };
		browserHandleRegistry.register(toURI(repoOrigin), new NodeDirectoryHandle('repo', r.path));
		return new IsomorphicGitAdapter(repoOrigin);
	},
	rootOrigin(r) {
		return { scheme: 'browser', path: r.path, name: 'repo' };
	}
};

/** node:fs-backed Storage so DocumentSessions read/write the real throwaway repo. */
function repoStorage(): Storage {
	return {
		pickFile: async () => null,
		pickDirectory: async () => null,
		saveFile: async (content: string, existingOrigin?: FileOrigin) => {
			if (!existingOrigin) throw new Error('contract storage: saving without an origin');
			await writeFile(existingOrigin.path, content, 'utf8');
			return existingOrigin;
		},
		readFile: async (origin: FileOrigin) => readFile(origin.path, 'utf8'),
		readDirectory: async () => [],
		verifyPermission: async () => true,
		queryPermission: async () => 'granted',
		createFile: async () => {
			throw new Error('contract storage: createFile not implemented');
		},
		createDirectory: async () => {
			throw new Error('contract storage: createDirectory not implemented');
		},
		deleteEntry: async () => {},
		renameEntry: async () => {
			throw new Error('contract storage: renameEntry not implemented');
		}
	} as unknown as Storage;
}

function docOrigin(r: TestRepo, filepath: string): FileOrigin {
	return { scheme: 'file', path: `${r.path}/${filepath}`, name: filepath.split('/').pop()! };
}

function deriveHunks(origContent: string, modContent: string): HunkRange[] {
	const origText = Text.of(origContent.split(/\r?\n/));
	const modText = Text.of(modContent.split(/\r?\n/));
	const chunks = Chunk.build(origText, modText);
	return chunks.map((c) => ({
		fromA: c.fromA,
		toA: c.toA,
		fromB: c.fromB,
		toB: c.toB
	}));
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

/**
 * Command context for dirty-hunk actions: the repository plus collaborators
 * closing over the bound working-copy Document, mirroring the Git plugin's
 * production wiring (in-memory reads, in-memory discard edits). Alerts throw
 * unless the test opts into collecting them, so a silent no-op is proven by
 * the absence of a throw.
 */
function createDirtyContext(
	r: TestRepo,
	adapter: VCSAdapter,
	doc: DocumentSession | undefined,
	filepath: string,
	alerts?: string[]
) {
	const repository = new Repository(
		{ scheme: 'file', path: r.path, name: 'repo' },
		() => adapter
	);
	const appState = {
		getWorkspace: () => ({ project: { repository } }),
		alert: async (msg: string) => {
			if (alerts) {
				alerts.push(msg);
				return;
			}
			throw new Error(`Unexpected alert dialog: ${msg}`);
		},
		confirm: async () => false,
		getDiffNavigator: () => undefined,
		getWorkingCopyContent: (fp: string) => {
			if (fp !== filepath || !doc) return undefined;
			return { content: doc.content };
		},
		applyWorkingTreeEdit: (fp: string, content: string) => {
			if (fp !== filepath || !doc) return false;
			if (doc.content === content) return true;
			doc.content = content;
			return true;
		}
	} as unknown as AppState;
	return { repository, appState };
}

for (const engine of [spawnEngine, isomorphicEngine]) {
	describe(`${engine.name} — hunk actions on unsaved edits (#273)`, () => {
		it('stages the hunk as it currently reads, leaving the unsaved edit on disk untouched', async () => {
			const r = await createTrackedRepo();
			await r.write('app.ts', 'a\nb\nc\n');
			await commitAll(r, 'base commit');
			await r.write('app.ts', 'a\nB\nc\n');

			const adapter = engine.adapter(r);
			const doc = new DocumentSession(
				repoStorage(),
				'a\nB\nc\n',
				docOrigin(r, 'app.ts')
			);
			// Unsaved Working-copy pane edit inside the hunk: no save-first gate.
			doc.content = 'a\nB edited\nc\n';
			const { repository, appState } = createDirtyContext(r, adapter, doc, 'app.ts');
			await repository.refresh();

			const change = repository.changes.find((c) => !c.staged);
			expect(change).toBeDefined();
			const diffDetail = await repository.getFileDiff('app.ts', { staged: false });
			const hunks = deriveHunks(diffDetail!.originalContent, diffDetail!.modifiedContent);
			expect(hunks).toHaveLength(1);

			await applyHunkAction(appState, change!, hunks[0], 'stage');

			// External behavior: index holds the hunk as currently read,
			// disk still holds the saved snapshot, the Document keeps typing.
			expect(await indexContents(r, 'app.ts')).toBe('a\nB edited\nc\n');
			expect(await workingTreeContents(r, 'app.ts')).toBe('a\nB\nc\n');
			expect(doc.content).toBe('a\nB edited\nc\n');
			expect(doc.isModified).toBe(true);
			expect(await porcelainStatus(r)).toEqual([{ x: 'M', y: 'M', path: 'app.ts' }]);
		});

		it('unstages base text to the index while keeping other in-memory edits', async () => {
			const r = await createTrackedRepo();
			await r.write('app.ts', 'a\nb\nc\n');
			await commitAll(r, 'base commit');
			await r.write('app.ts', 'a\nB\nc\n');
			await stageAll(r);

			const adapter = engine.adapter(r);
			const doc = new DocumentSession(
				repoStorage(),
				'a\nB\nc\n',
				docOrigin(r, 'app.ts')
			);
			doc.content = 'a\nB\nc\npane edit\n';
			const { repository, appState } = createDirtyContext(r, adapter, doc, 'app.ts');
			await repository.refresh();

			const stagedChange = repository.changes.find((c) => c.staged);
			expect(stagedChange).toBeDefined();
			const diffDetail = await repository.getFileDiff('app.ts', { staged: true });
			const hunks = deriveHunks(diffDetail!.originalContent, diffDetail!.modifiedContent);
			expect(hunks).toHaveLength(1);

			await applyHunkAction(appState, stagedChange!, hunks[0], 'unstage');

			expect(await indexContents(r, 'app.ts')).toBe('a\nb\nc\n');
			expect(await workingTreeContents(r, 'app.ts')).toBe('a\nB\nc\n');
			expect(doc.content).toBe('a\nB\nc\npane edit\n');
			// The single staged hunk fully reverted: nothing staged remains,
			// the saved working tree shows as unstaged, and the pane edit
			// lives only in memory.
			expect(await porcelainStatus(r)).toEqual([{ x: ' ', y: 'M', path: 'app.ts' }]);
		});

		it('discards a hunk as an in-memory edit, then persists it through save', async () => {
			const r = await createTrackedRepo();
			await r.write('app.ts', 'a\nb\nc\n');
			await commitAll(r, 'base commit');
			await r.write('app.ts', 'a\nB\nc\n');

			const adapter = engine.adapter(r);
			const doc = new DocumentSession(
				repoStorage(),
				'a\nB\nc\n',
				docOrigin(r, 'app.ts')
			);
			doc.content = 'a\nB\nc\nEXTRA\n';
			const { repository, appState } = createDirtyContext(r, adapter, doc, 'app.ts');
			await repository.refresh();

			const change = repository.changes.find((c) => !c.staged);
			const diffDetail = await repository.getFileDiff('app.ts', { staged: false });
			const hunks = deriveHunks(diffDetail!.originalContent, diffDetail!.modifiedContent);
			expect(hunks).toHaveLength(1);

			await applyHunkAction(appState, change!, hunks[0], 'discard');

			// In-memory revert: base text restored for the hunk, the pane
			// edit survives, and neither the disk nor the index moves.
			expect(doc.content).toBe('a\nb\nc\nEXTRA\n');
			expect(await workingTreeContents(r, 'app.ts')).toBe('a\nB\nc\n');
			expect(await indexContents(r, 'app.ts')).toBe('a\nb\nc\n');
			expect(await porcelainStatus(r)).toEqual([{ x: ' ', y: 'M', path: 'app.ts' }]);

			// Saving persists the in-memory revert through the normal path.
			expect(await doc.save({ coveredByRoot: true })).toBe(true);
			expect(await workingTreeContents(r, 'app.ts')).toBe('a\nb\nc\nEXTRA\n');
			expect(await indexContents(r, 'app.ts')).toBe('a\nb\nc\n');
		});

		it('lands a staged hunk below an unsaved insertion on the intended lines', async () => {
			const r = await createTrackedRepo();
			const base = 'l1\nl2\nl3\nl4\nl5\nl6\n';
			const edited = 'l1\nl2\nl3\nl4\nL5\nl6\n';
			await r.write('app.ts', base);
			await commitAll(r, 'base commit');
			await r.write('app.ts', edited);

			const adapter = engine.adapter(r);
			const doc = new DocumentSession(repoStorage(), edited, docOrigin(r, 'app.ts'));
			// Unsaved insertion above the hunk shifts every snapshot offset below it.
			doc.content = 'X\nY\nl1\nl2\nl3\nl4\nL5\nl6\n';
			const { repository, appState } = createDirtyContext(r, adapter, doc, 'app.ts');
			await repository.refresh();

			const change = repository.changes.find((c) => !c.staged);
			const diffDetail = await repository.getFileDiff('app.ts', { staged: false });
			const hunks = deriveHunks(diffDetail!.originalContent, diffDetail!.modifiedContent);
			expect(hunks).toHaveLength(1);

			await applyHunkAction(appState, change!, hunks[0], 'stage');

			// Only the hunk's line reaches the index, at its original
			// position; the unsaved insertion never leaks into the index,
			// and the disk keeps the saved snapshot. Index and disk agree,
			// so the change reads as staged-only; the insertion is invisible
			// to git until the Document is saved.
			expect(await indexContents(r, 'app.ts')).toBe(edited);
			expect(await workingTreeContents(r, 'app.ts')).toBe(edited);
			expect(doc.content).toBe('X\nY\nl1\nl2\nl3\nl4\nL5\nl6\n');
			expect(await porcelainStatus(r)).toEqual([{ x: 'M', y: ' ', path: 'app.ts' }]);
		});

		it('treats a stale hunk range as a silent no-op', async () => {
			const r = await createTrackedRepo();
			await r.write('app.ts', 'a\nb\nc\n');
			await commitAll(r, 'base commit');
			await r.write('app.ts', 'a\nB\nc\n');

			const adapter = engine.adapter(r);
			const doc = new DocumentSession(repoStorage(), 'a\nB\nc\n', docOrigin(r, 'app.ts'));
			const { repository, appState } = createDirtyContext(r, adapter, doc, 'app.ts');
			await repository.refresh();

			const change = repository.changes.find((c) => !c.staged);
			expect(change).toBeDefined();

			// A control built from an older, longer snapshot: matches nothing.
			await applyHunkAction(
				appState,
				change!,
				{ fromA: 0, toA: 1, fromB: 999, toB: 1005 },
				'stage'
			);

			expect(await indexContents(r, 'app.ts')).toBe('a\nb\nc\n');
			expect(await workingTreeContents(r, 'app.ts')).toBe('a\nB\nc\n');
			expect(doc.content).toBe('a\nB\nc\n');
			expect(await porcelainStatus(r)).toEqual([{ x: ' ', y: 'M', path: 'app.ts' }]);
		});

		it('restores prior index content and reports when the index write fails', async () => {
			const r = await createTrackedRepo();
			await r.write('app.ts', 'a\nb\nc\n');
			await commitAll(r, 'base commit');
			await r.write('app.ts', 'a\nB\nc\n');

			const realAdapter = engine.adapter(r);
			// Fail the first index write, then delegate: the rollback write
			// must restore the prior index content through the real engine.
			// Object.create keeps the prototype methods; the own property
			// shadows only updateIndexContent.
			const adapter: VCSAdapter = Object.create(realAdapter);
			let calls = 0;
			adapter.updateIndexContent = async (filepath: string, content: string) => {
				calls++;
				if (calls === 1) throw new Error('simulated index failure');
				return realAdapter.updateIndexContent!(filepath, content);
			};

			const doc = new DocumentSession(repoStorage(), 'a\nB\nc\n', docOrigin(r, 'app.ts'));
			doc.content = 'a\nB edited\nc\n';
			const alerts: string[] = [];
			const { repository, appState } = createDirtyContext(r, adapter, doc, 'app.ts', alerts);
			await repository.refresh();

			const change = repository.changes.find((c) => !c.staged);
			const diffDetail = await repository.getFileDiff('app.ts', { staged: false });
			const hunks = deriveHunks(diffDetail!.originalContent, diffDetail!.modifiedContent);

			await applyHunkAction(appState, change!, hunks[0], 'stage');

			expect(calls).toBe(2);
			expect(alerts).toHaveLength(1);
			expect(alerts[0]).toContain('simulated index failure');
			// The index is never left half-written: prior content restored.
			expect(await indexContents(r, 'app.ts')).toBe('a\nb\nc\n');
			expect(await workingTreeContents(r, 'app.ts')).toBe('a\nB\nc\n');
			expect(doc.content).toBe('a\nB edited\nc\n');
		});
	});
}
