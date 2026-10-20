import './rune-setup';

import { expect, mock, beforeAll } from 'bun:test';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { Text } from '../../packages/core/node_modules/@codemirror/state';
import { Chunk } from '../../packages/core/node_modules/@codemirror/merge';
import { DocumentSession } from '../../packages/core/src/document.svelte';
import { Repository } from '../../packages/core/src/project/repository.svelte';
import { MemorySessionPersistence } from '../../packages/core/src/persistence';
import {
	ensureSplitDocument,
	isOriginalOnly,
	resolveSplitRightContent
} from '../../packages/ui/src/components/diff-split-binding';
import type { FileOrigin, Storage, VCSAdapter } from '@np/core';
import { toURI } from '@np/core/storage';
import { IsomorphicGitAdapter, browserHandleRegistry } from '@np/adapters-browser';
import { SpawnGitAdapter, type GitFileAccess } from '../../apps/desktop/src/renderer/SpawnGitAdapter';
import { NodeDirectoryHandle } from './node-fs-handle';
import {
	TestRepo,
	createTrackedRepo,
	describe,
	it,
	indexContents,
	porcelainStatus,
	runGit,
	seedCommit,
	workingTreeContents
} from './harness';

const nodeFileAccess: GitFileAccess = {
	readFile: (path) => readFile(path),
	writeFile: (path, content) => writeFile(path, content),
	deleteEntry: (path) => rm(path, { force: true })
};

// Workspace, PluginHost, and the Git registration pull the `svelte` runtime
// (untrack/state), which only resolves through the test mock — so they load
// dynamically after the mocks register, mirroring the core unit-test pattern.
let WorkspaceClass: typeof import('../../packages/core/src/workspace.svelte').Workspace;
let PluginHostClass: typeof import('../../packages/core/src/plugins/host.svelte').PluginHost;
let gitRegistration: typeof import('../../packages/core/src/plugins/git/registration').gitRegistration;
let DIALOGS_SERVICE_KEY: typeof import('../../packages/core/src/plugins/services').DIALOGS_SERVICE_KEY;
beforeAll(async () => {
	mock.module('svelte', () => ({
		getContext: () => null,
		setContext: () => {},
		hasContext: () => false,
		getAllContexts: () => new Map(),
		untrack: (fn: any) => fn(),
		tick: async () => {}
	}));
	mock.module('svelte/reactivity', () => ({
		SvelteMap: Map,
		SvelteSet: Set
	}));
	WorkspaceClass = (await import('../../packages/core/src/workspace.svelte')).Workspace;
	PluginHostClass = (await import('../../packages/core/src/plugins/host.svelte')).PluginHost;
	gitRegistration = (await import('../../packages/core/src/plugins/git/registration')).gitRegistration;
	DIALOGS_SERVICE_KEY = (await import('../../packages/core/src/plugins/services')).DIALOGS_SERVICE_KEY;
});

interface Engine {
	name: string;
	scheme: string;
	adapter(r: TestRepo): VCSAdapter;
	rootOrigin(r: TestRepo): FileOrigin;
}

const spawnEngine: Engine = {
	name: 'SpawnGitAdapter (real git)',
	scheme: 'file',
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
	scheme: 'browser',
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

async function stageAll(r: TestRepo): Promise<void> {
	const res = await r.git(['add', '-A']);
	if (res.code !== 0) throw new Error(res.stderr);
}

async function commitAll(r: TestRepo, message: string): Promise<void> {
	await stageAll(r);
	const res = await r.git(['commit', '-m', message]);
	if (res.code !== 0) throw new Error(res.stderr);
}

function liveHunks(original: string, effectiveModified: string) {
	return Chunk.build(Text.of(original.split(/\r?\n/)), Text.of(effectiveModified.split(/\r?\n/)));
}

for (const engine of [spawnEngine, isomorphicEngine]) {
	describe(`${engine.name} — refresh-safe diff pane edits plus staged and file-edge semantics (#272)`, () => {
		it('refresh re-derives status around unsaved pane edits without overwriting them', async () => {
			const r = await createTrackedRepo();
			await r.write('app.ts', 'line1\nline2\nline3\n');
			await commitAll(r, 'base commit');
			await r.write('app.ts', 'line1\nline2 working\nline3\n');

			const adapter = engine.adapter(r);
			const repository = new Repository(engine.rootOrigin(r), () => adapter);
			await repository.refresh();
			const detail = await repository.getFileDiff('app.ts', { staged: false });
			expect(detail).not.toBeNull();

			// Bind the Working-copy pane Document (tab-less) and type without saving.
			const storage = repoStorage();
			const documents: DocumentSession[] = [];
			const boundIds = new Map<string, string>();
			const scope = {
				documents,
				storage,
				rootOrigin: engine.rootOrigin(r),
				coversOrigin: () => true
			};
			const doc = ensureSplitDocument(
				scope,
				boundIds,
				{ filepath: 'app.ts', status: 'M', additions: 1, deletions: 0, diff: '', staged: false },
				detail!.modifiedContent
			);
			expect(doc).toBeDefined();
			doc!.content = 'line1\nline2 working\nline3 pane edit\n';

			// External change plus refresh: stage an unrelated file so the
			// change list genuinely re-derives.
			await r.write('other.txt', 'other\n');
			await r.git(['add', 'other.txt']);
			await repository.refresh();

			// External behavior: Document keeps the typing; disk and index are
			// untouched by the refresh; status re-derived around the edits.
			expect(doc!.content).toBe('line1\nline2 working\nline3 pane edit\n');
			expect(resolveSplitRightContent(doc, detail!.modifiedContent)).toBe(doc!.content);
			expect(await workingTreeContents(r, 'app.ts')).toBe('line1\nline2 working\nline3\n');
			expect(await indexContents(r, 'app.ts')).toBe('line1\nline2\nline3\n');
			expect(repository.changes.some((c) => c.filepath === 'other.txt' && c.staged)).toBe(true);

			// Hunks re-derive around the edits: the stored snapshot is clean
			// against the base while the live text carries the pane edit.
			const fresh = await repository.getFileDiff('app.ts', { staged: false });
			const snapshotHunks = liveHunks(fresh!.originalContent, fresh!.modifiedContent);
			const live = liveHunks(fresh!.originalContent, doc!.content);
			expect(snapshotHunks.length).toBeGreaterThan(0);
			// The pane edit starts where the snapshot's working tree ends its
			// changed region: live hunks cover it, snapshot hunks do not.
			const paneEditOffset = 'line1\nline2 working\n'.length;
			expect(live.some((h) => h.fromB <= paneEditOffset && paneEditOffset <= h.toB)).toBe(true);
			// The live changed region extends past every snapshot hunk: the
			// re-derived diff grew around the pane edit.
			const snapshotMaxToB = Math.max(...snapshotHunks.map((h) => h.toB));
			expect(live.some((h) => h.toB > snapshotMaxToB)).toBe(true);
		});

		it('typing in a staged-only file never moves the index; saving creates an unstaged modification', async () => {
			const r = await createTrackedRepo();
			await r.write('app.ts', 'base\n');
			await commitAll(r, 'base commit');
			await r.write('app.ts', 'staged edit\n');
			await stageAll(r);

			const adapter = engine.adapter(r);
			const repository = new Repository(engine.rootOrigin(r), () => adapter);
			await repository.refresh();
			const detail = await repository.getFileDiff('app.ts', { staged: true });
			expect(detail).not.toBeNull();

			const storage = repoStorage();
			const doc = new DocumentSession(storage, detail!.modifiedContent, docOrigin(r, 'app.ts'));
			// Typing: in-memory only.
			doc.content = 'staged edit\npane edit\n';

			// External behavior before save: neither file bytes nor index bytes move.
			expect(await workingTreeContents(r, 'app.ts')).toBe('staged edit\n');
			expect(await indexContents(r, 'app.ts')).toBe('staged edit\n');

			// Saving writes the working tree through the standard file-save
			// path; the index is never touched by typing or saving.
			expect(await doc.save({ coveredByRoot: true })).toBe(true);
			expect(await workingTreeContents(r, 'app.ts')).toBe('staged edit\npane edit\n');
			expect(await indexContents(r, 'app.ts')).toBe('staged edit\n');

			await repository.refresh();
			expect(await porcelainStatus(r)).toEqual([{ x: 'M', y: 'M', path: 'app.ts' }]);
		});

		it('typing in a combined file grows the unstaged portion; the index never moves', async () => {
			const r = await createTrackedRepo();
			await r.write('app.ts', 'base\n');
			await commitAll(r, 'base commit');
			await r.write('app.ts', 'staged part\n');
			await stageAll(r);
			await r.write('app.ts', 'staged part\nunstaged part\n');

			const adapter = engine.adapter(r);
			const repository = new Repository(engine.rootOrigin(r), () => adapter);
			await repository.refresh();
			const unstaged = await repository.getFileDiff('app.ts', { staged: false });
			expect(unstaged).not.toBeNull();
			expect(unstaged!.originalContent).toBe('staged part\n');

			const storage = repoStorage();
			const doc = new DocumentSession(storage, unstaged!.modifiedContent, docOrigin(r, 'app.ts'));
			doc.content = 'staged part\nunstaged part\npane edit\n';

			expect(await indexContents(r, 'app.ts')).toBe('staged part\n');

			expect(await doc.save({ coveredByRoot: true })).toBe(true);
			expect(await indexContents(r, 'app.ts')).toBe('staged part\n');
			expect(await workingTreeContents(r, 'app.ts')).toBe('staged part\nunstaged part\npane edit\n');

			await repository.refresh();
			expect(await porcelainStatus(r)).toEqual([{ x: 'M', y: 'M', path: 'app.ts' }]);
			const after = await repository.getFileDiff('app.ts', { staged: false });
			// The unstaged side grew: it still starts from the staged content
			// and now carries both the earlier and the pane edits.
			expect(after!.originalContent).toBe('staged part\n');
			expect(after!.modifiedContent).toBe('staged part\nunstaged part\npane edit\n');
		});

		it('an untracked file round-trips pane edits through save with the index untouched', async () => {
			const r = await createTrackedRepo();
			await seedCommit(r);
			await r.write('new.txt', 'draft line\n');

			const adapter = engine.adapter(r);
			const repository = new Repository(engine.rootOrigin(r), () => adapter);
			await repository.refresh();
			const detail = await repository.getFileDiff('new.txt');
			expect(detail).not.toBeNull();
			// Empty baseline: no HEAD content, working tree is the only truth.
			expect(detail!.originalContent).toBe('');
			expect(detail!.modifiedContent).toBe('draft line\n');
			expect(isOriginalOnly('U')).toBe(false);

			const storage = repoStorage();
			const doc = new DocumentSession(storage, detail!.modifiedContent, docOrigin(r, 'new.txt'));
			doc.content = 'draft line\npane edit\n';
			expect(await indexContents(r, 'new.txt')).toBeNull();

			expect(await doc.save({ coveredByRoot: true })).toBe(true);
			expect(await workingTreeContents(r, 'new.txt')).toBe('draft line\npane edit\n');
			expect(await indexContents(r, 'new.txt')).toBeNull();

			await repository.refresh();
			expect(await porcelainStatus(r)).toEqual([{ x: '?', y: '?', path: 'new.txt' }]);
		});

		it('a deleted file keeps its original bytes with no working-copy surface', async () => {
			const r = await createTrackedRepo();
			await r.write('gone.txt', 'was here\n');
			await commitAll(r, 'base commit');
			await r.git(['rm', 'gone.txt']);

			const adapter = engine.adapter(r);
			const repository = new Repository(engine.rootOrigin(r), () => adapter);
			await repository.refresh();
			const deleted = repository.changes.find((c) => c.filepath === 'gone.txt');
			expect(deleted).toBeDefined();
			expect(deleted!.status).toBe('D');

			// No working-copy surface by construction: binding refuses.
			expect(isOriginalOnly(deleted!.status)).toBe(true);
			const storage = repoStorage();
			const documents: DocumentSession[] = [];
			expect(
				ensureSplitDocument(
					{ documents, storage, rootOrigin: engine.rootOrigin(r), coversOrigin: () => true },
					new Map(),
					deleted!,
					''
				)
			).toBeUndefined();
			expect(documents).toHaveLength(0);

			// External behavior: the index holds the deletion, the working
			// tree is gone, and nothing was written behind the change.
			expect(await indexContents(r, 'gone.txt')).toBeNull();
			expect(await workingTreeContents(r, 'gone.txt')).toBeNull();
			const detail = await repository.getFileDiff('gone.txt', { staged: true });
			expect(detail).not.toBeNull();
			expect(detail!.originalContent).toBe('was here\n');
		});

		it('a binary file keeps its bytes with the fallback presentation unchanged', async () => {
			const r = await createTrackedRepo();
			await seedCommit(r);
			const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x41, 0x42, 0x0a]);
			const { writeFile: writeRaw } = await import('node:fs/promises');
			const { join } = await import('node:path');
			await writeRaw(join(r.path, 'blob.bin'), bytes);

			const adapter = engine.adapter(r);
			const repository = new Repository(engine.rootOrigin(r), () => adapter);
			await repository.refresh();

			// The fallback never throws and never rewrites the file.
			const detail = await repository.getFileDiff('blob.bin');
			expect(detail).not.toBeNull();
			expect(await workingTreeContents(r, 'blob.bin')).not.toBeNull();
			const { readFile: readRaw } = await import('node:fs/promises');
			expect(await readRaw(join(r.path, 'blob.bin'))).toEqual(bytes);
		});

		it('branch switch with a dirty diff pane preserves the pane edits (carry-forward)', async () => {
			const r = await createTrackedRepo();
			await r.write('app.ts', 'base\n');
			await r.write('other.txt', 'other\n');
			await commitAll(r, 'base commit');
			await runGit(r.path, r.env, ['branch', 'feature']);
			await runGit(r.path, r.env, ['checkout', 'feature']);
			await r.write('other.txt', 'other on feature\n');
			await commitAll(r, 'feature commit');
			await runGit(r.path, r.env, ['checkout', 'main']);

			// Dirty working tree on main plus unsaved pane edits on top.
			await r.write('app.ts', 'dirty working tree\n');

			const storage = repoStorage();
			const host = new PluginHostClass();
			host.register(gitRegistration);
			host.provideService(DIALOGS_SERVICE_KEY, {
				alert: async () => {},
				confirm: async () => true
			});
			const ws = new WorkspaceClass(storage, () => engine.adapter(r), new MemorySessionPersistence(), host);
			await host.activate('git');
			const pickRoot = engine.rootOrigin(r);
			(storage as unknown as { pickDirectory: () => Promise<FileOrigin> }).pickDirectory = async () => pickRoot;
			await ws.openDirectory(pickRoot);
			expect(ws.project.repository).not.toBeNull();

			// Bind the diff pane tab-less, exactly as the Diff Viewer does,
			// then type without saving.
			const boundIds = new Map<string, string>();
			const scope = {
				documents: ws.documents,
				storage,
				rootOrigin: ws.project.rootOrigin,
				coversOrigin: (o: FileOrigin) => ws.project.coversOrigin(o)
			};
			const snapshot = await ws.project.repository!.getFileDiff('app.ts', { staged: false });
			const doc = ensureSplitDocument(
				scope,
				boundIds,
				{ filepath: 'app.ts', status: 'M', additions: 1, deletions: 0, diff: '', staged: false },
				snapshot!.modifiedContent
			);
			expect(doc).toBeDefined();
			ws.updateDocumentContent(doc!, 'dirty working tree\nunsaved pane edits\n');

			const result = await ws.switchBranch('feature');

			// External behavior: switched, edits preserved and still dirty
			// against the rebased baseline; disk carried the working tree.
			expect(result.status).toBe('switched');
			expect(doc!.content).toBe('dirty working tree\nunsaved pane edits\n');
			expect(doc!.isModified).toBe(true);
			expect(await workingTreeContents(r, 'app.ts')).toBe('dirty working tree\n');
			expect(await workingTreeContents(r, 'other.txt')).toBe('other on feature\n');
		});

		it('branch switch blocked by a conflict preserves dirty diff pane edits', async () => {
			const r = await createTrackedRepo();
			await r.write('app.ts', 'base\n');
			await commitAll(r, 'base commit');
			await runGit(r.path, r.env, ['branch', 'feature']);
			await runGit(r.path, r.env, ['checkout', 'feature']);
			await r.write('app.ts', 'feature version\n');
			await commitAll(r, 'feature commit');
			await runGit(r.path, r.env, ['checkout', 'main']);
			await r.write('app.ts', 'local dirty\n');

			const storage = repoStorage();
			const host = new PluginHostClass();
			host.register(gitRegistration);
			host.provideService(DIALOGS_SERVICE_KEY, {
				alert: async () => {},
				confirm: async () => true
			});
			const ws = new WorkspaceClass(storage, () => engine.adapter(r), new MemorySessionPersistence(), host);
			await host.activate('git');
			const pickRoot = engine.rootOrigin(r);
			(storage as unknown as { pickDirectory: () => Promise<FileOrigin> }).pickDirectory = async () => pickRoot;
			await ws.openDirectory(pickRoot);

			const boundIds = new Map<string, string>();
			const scope = {
				documents: ws.documents,
				storage,
				rootOrigin: ws.project.rootOrigin,
				coversOrigin: (o: FileOrigin) => ws.project.coversOrigin(o)
			};
			const snapshot = await ws.project.repository!.getFileDiff('app.ts', { staged: false });
			const doc = ensureSplitDocument(
				scope,
				boundIds,
				{ filepath: 'app.ts', status: 'M', additions: 1, deletions: 0, diff: '', staged: false },
				snapshot!.modifiedContent
			);
			ws.updateDocumentContent(doc!, 'local dirty\nunsaved pane edits\n');

			// The dirty pane joins the safety report, so the conflicting
			// switch reports instead of destroying work.
			const report = await ws.getBranchSafetyReport('feature');
			expect(report).not.toBeNull();
			expect(report!.canSwitch).toBe(false);
			expect(report!.unsavedFiles).toContain('app.ts');

			const result = await ws.switchBranch('feature');
			expect(result.status).toBe('blocked');
			expect(doc!.content).toBe('local dirty\nunsaved pane edits\n');
			expect(await workingTreeContents(r, 'app.ts')).toBe('local dirty\n');
		});
	});
}
