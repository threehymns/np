import './rune-setup';

import { expect } from 'bun:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { Text } from '@codemirror/state';
import { Chunk } from '@codemirror/merge';
import { applyHunkAction, type HunkRange } from '../../packages/core/src/commands.svelte';
import { Repository } from '../../packages/core/src/project/repository.svelte';
import type { AppState } from '../../packages/core/src/state.svelte';
import type { FileOrigin } from '@np/core/storage';
import { toURI } from '@np/core/storage';
import type { VCSAdapter } from '@np/core/project/vcs';
import { IsomorphicGitAdapter, browserHandleRegistry } from '@np/adapters-browser';
import { SpawnGitAdapter, type GitFileAccess } from '../../apps/desktop/src/renderer/SpawnGitAdapter';
import { NodeDirectoryHandle } from './node-fs-handle';
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

interface Engine {
	name: string;
	adapter(r: TestRepo): VCSAdapter;
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

function createTestContext(r: TestRepo, adapter: VCSAdapter) {
	const repoOrigin = origin(r);
	const repository = new Repository(repoOrigin, () => adapter);
	const appState = {
		workspace: {
			repository
		},
		dialogService: {
			alert: async (msg: string) => {
				throw new Error(`Unexpected alert dialog: ${msg}`);
			}
		}
	} as unknown as AppState;
	return { repository, appState };
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

const MULTI_SECTION_BASE = [
	'// Section 1: Header',
	'function getHeader() {',
	'  return "header-v1";',
	'}',
	'',
	'// Section 2: Middle shared content',
	'function getMiddle() {',
	'  return "middle-v1";',
	'}',
	'',
	'// Section 3: Footer',
	'function getFooter() {',
	'  return "footer-v1";',
	'}',
	''
].join('\n');

const MULTI_SECTION_EDITED = [
	'// Section 1: Header',
	'function getHeader() {',
	'  return "header-v2-EDITED";',
	'}',
	'',
	'// Section 2: Middle shared content',
	'function getMiddle() {',
	'  return "middle-v1";',
	'}',
	'',
	'// Section 3: Footer',
	'function getFooter() {',
	'  return "footer-v2-EDITED";',
	'}',
	''
].join('\n');

const MULTI_SECTION_STAGE_SECTION1 = [
	'// Section 1: Header',
	'function getHeader() {',
	'  return "header-v2-EDITED";',
	'}',
	'',
	'// Section 2: Middle shared content',
	'function getMiddle() {',
	'  return "middle-v1";',
	'}',
	'',
	'// Section 3: Footer',
	'function getFooter() {',
	'  return "footer-v1";',
	'}',
	''
].join('\n');

const MULTI_SECTION_STAGE_SECTION3 = [
	'// Section 1: Header',
	'function getHeader() {',
	'  return "header-v1";',
	'}',
	'',
	'// Section 2: Middle shared content',
	'function getMiddle() {',
	'  return "middle-v1";',
	'}',
	'',
	'// Section 3: Footer',
	'function getFooter() {',
	'  return "footer-v2-EDITED";',
	'}',
	''
].join('\n');

for (const engine of [spawnEngine, isomorphicEngine]) {
	describe(`${engine.name} — hunk-action composition contract tests`, () => {
		it('stages individual hunks of an unstaged change sequentially, splitting and updating the change list', async () => {
			const r = await createTrackedRepo();
			await r.write('app.ts', MULTI_SECTION_BASE);
			await commitAll(r, 'base commit');

			await r.write('app.ts', MULTI_SECTION_EDITED);

			const adapter = engine.adapter(r);
			const { repository, appState } = createTestContext(r, adapter);
			await repository.refresh();

			expect(repository.changes).toHaveLength(1);
			const initialChange = repository.changes[0];
			expect(initialChange.staged).toBe(false);

			const diffDetail = await repository.getFileDiff('app.ts', { staged: false });
			expect(diffDetail).not.toBeNull();
			const hunks = deriveHunks(diffDetail!.originalContent, diffDetail!.modifiedContent);
			expect(hunks).toHaveLength(2);

			// Stage the first hunk (Section 1 edit)
			await applyHunkAction(appState, initialChange, hunks[0], 'stage');

			// Oracle verification: Index has section 1 edit, worktree has both edits
			expect(await indexContents(r, 'app.ts')).toBe(MULTI_SECTION_STAGE_SECTION1);
			expect(await worktreeContents(r, 'app.ts')).toBe(MULTI_SECTION_EDITED);
			expect(await porcelainStatus(r)).toEqual([{ x: 'M', y: 'M', path: 'app.ts' }]);

			// Repository changes split: one staged change (section 1) and one unstaged change (section 3)
			expect(repository.changes).toHaveLength(2);
			const stagedChange = repository.changes.find((c) => c.staged);
			const remainingUnstagedChange = repository.changes.find((c) => !c.staged);
			expect(stagedChange).toBeDefined();
			expect(remainingUnstagedChange).toBeDefined();

			// Resolve diff on the remaining unstaged portion (diff against index)
			const remainingDiff = await repository.getFileDiff('app.ts', { staged: false });
			expect(remainingDiff).not.toBeNull();
			const remainingHunks = deriveHunks(remainingDiff!.originalContent, remainingDiff!.modifiedContent);
			expect(remainingHunks).toHaveLength(1);

			// Stage the remaining hunk (Section 3 edit)
			await applyHunkAction(appState, remainingUnstagedChange!, remainingHunks[0], 'stage');

			// Oracle verification: Index now has both edits, matching worktree
			expect(await indexContents(r, 'app.ts')).toBe(MULTI_SECTION_EDITED);
			expect(await worktreeContents(r, 'app.ts')).toBe(MULTI_SECTION_EDITED);
			expect(await porcelainStatus(r)).toEqual([{ x: 'M', y: ' ', path: 'app.ts' }]);

			// Repository changes now only contain a single staged change
			expect(repository.changes).toHaveLength(1);
			expect(repository.changes[0].staged).toBe(true);
		});

		it('unstages a single hunk from a fully staged multi-hunk modification', async () => {
			const r = await createTrackedRepo();
			await r.write('app.ts', MULTI_SECTION_BASE);
			await commitAll(r, 'base commit');

			await r.write('app.ts', MULTI_SECTION_EDITED);
			await stageAll(r);

			const adapter = engine.adapter(r);
			const { repository, appState } = createTestContext(r, adapter);
			await repository.refresh();

			expect(repository.changes).toHaveLength(1);
			const stagedChange = repository.changes[0];
			expect(stagedChange.staged).toBe(true);

			const diffDetail = await repository.getFileDiff('app.ts', { staged: true });
			expect(diffDetail).not.toBeNull();
			const hunks = deriveHunks(diffDetail!.originalContent, diffDetail!.modifiedContent);
			expect(hunks).toHaveLength(2);

			// Unstage the first hunk (Section 1 edit)
			await applyHunkAction(appState, stagedChange, hunks[0], 'unstage');

			// Oracle verification: Index now only has section 3 edit, section 1 is reverted to HEAD
			expect(await indexContents(r, 'app.ts')).toBe(MULTI_SECTION_STAGE_SECTION3);
			expect(await worktreeContents(r, 'app.ts')).toBe(MULTI_SECTION_EDITED);
			expect(await porcelainStatus(r)).toEqual([{ x: 'M', y: 'M', path: 'app.ts' }]);

			// Repository changes now list both staged (section 3) and unstaged (section 1) changes
			expect(repository.changes).toHaveLength(2);
			expect(repository.changes.some((c) => c.staged)).toBe(true);
			expect(repository.changes.some((c) => !c.staged)).toBe(true);
		});

		it('discards an unstaged hunk while strictly preserving other unstaged edits in the file', async () => {
			const r = await createTrackedRepo();
			await r.write('app.ts', MULTI_SECTION_BASE);
			await commitAll(r, 'base commit');

			await r.write('app.ts', MULTI_SECTION_EDITED);

			const adapter = engine.adapter(r);
			const { repository, appState } = createTestContext(r, adapter);
			await repository.refresh();

			const initialChange = repository.changes[0];
			const diffDetail = await repository.getFileDiff('app.ts', { staged: false });
			const hunks = deriveHunks(diffDetail!.originalContent, diffDetail!.modifiedContent);
			expect(hunks).toHaveLength(2);

			// Discard the first hunk (Section 1 edit)
			await applyHunkAction(appState, initialChange, hunks[0], 'discard');

			// Oracle verification: Worktree has section 1 reverted, but section 3 edit is preserved!
			expect(await worktreeContents(r, 'app.ts')).toBe(MULTI_SECTION_STAGE_SECTION3);
			expect(await indexContents(r, 'app.ts')).toBe(MULTI_SECTION_BASE);
			expect(await porcelainStatus(r)).toEqual([{ x: ' ', y: 'M', path: 'app.ts' }]);

			// Repository changes now report only 1 unstaged change
			expect(repository.changes).toHaveLength(1);
			expect(repository.changes[0].staged).toBe(false);
		});

		it('discards a staged hunk, reverting both index and worktree for that hunk while preserving other staged edits', async () => {
			const r = await createTrackedRepo();
			await r.write('app.ts', MULTI_SECTION_BASE);
			await commitAll(r, 'base commit');

			await r.write('app.ts', MULTI_SECTION_EDITED);
			await stageAll(r);

			const adapter = engine.adapter(r);
			const { repository, appState } = createTestContext(r, adapter);
			await repository.refresh();

			const stagedChange = repository.changes[0];
			const diffDetail = await repository.getFileDiff('app.ts', { staged: true });
			const hunks = deriveHunks(diffDetail!.originalContent, diffDetail!.modifiedContent);
			expect(hunks).toHaveLength(2);

			// Discard the first hunk from the staged change
			await applyHunkAction(appState, stagedChange, hunks[0], 'discard');

			// Oracle verification: Both index and worktree have section 1 reverted to HEAD, section 3 preserved
			expect(await indexContents(r, 'app.ts')).toBe(MULTI_SECTION_STAGE_SECTION3);
			expect(await worktreeContents(r, 'app.ts')).toBe(MULTI_SECTION_STAGE_SECTION3);
			expect(await porcelainStatus(r)).toEqual([{ x: 'M', y: ' ', path: 'app.ts' }]);

			expect(repository.changes).toHaveLength(1);
			expect(repository.changes[0].staged).toBe(true);
		});

		it('handles combined changes (staged + unstaged on same file) when staging or discarding at hunk granularity', async () => {
			const r = await createTrackedRepo();
			await r.write('app.ts', MULTI_SECTION_BASE);
			await commitAll(r, 'base commit');

			// Stage section 1 edit into index
			await r.write('app.ts', MULTI_SECTION_STAGE_SECTION1);
			await stageAll(r);

			// In worktree, add section 3 edit as an unstaged modification
			await r.write('app.ts', MULTI_SECTION_EDITED);

			const adapter = engine.adapter(r);
			const { repository, appState } = createTestContext(r, adapter);
			await repository.refresh();

			expect(await porcelainStatus(r)).toEqual([{ x: 'M', y: 'M', path: 'app.ts' }]);

			// Test discarding the unstaged hunk on a combined change
			const unstagedChange = repository.changes.find((c) => !c.staged);
			expect(unstagedChange).toBeDefined();

			const unstagedDiff = await repository.getFileDiff('app.ts', { staged: false });
			const unstagedHunks = deriveHunks(unstagedDiff!.originalContent, unstagedDiff!.modifiedContent);
			expect(unstagedHunks).toHaveLength(1);

			await applyHunkAction(appState, unstagedChange!, unstagedHunks[0], 'discard');

			// Worktree reverted to staged index content (MULTI_SECTION_STAGE_SECTION1)
			expect(await worktreeContents(r, 'app.ts')).toBe(MULTI_SECTION_STAGE_SECTION1);
			expect(await indexContents(r, 'app.ts')).toBe(MULTI_SECTION_STAGE_SECTION1);
			expect(await porcelainStatus(r)).toEqual([{ x: 'M', y: ' ', path: 'app.ts' }]);

			// Re-apply worktree edit and test staging the unstaged hunk on the combined change
			await r.write('app.ts', MULTI_SECTION_EDITED);
			await repository.refresh();

			const nextUnstagedChange = repository.changes.find((c) => !c.staged);
			const nextDiff = await repository.getFileDiff('app.ts', { staged: false });
			const nextHunks = deriveHunks(nextDiff!.originalContent, nextDiff!.modifiedContent);
			expect(nextHunks).toHaveLength(1);

			await applyHunkAction(appState, nextUnstagedChange!, nextHunks[0], 'stage');

			// Index and worktree now both have full MULTI_SECTION_EDITED
			expect(await indexContents(r, 'app.ts')).toBe(MULTI_SECTION_EDITED);
			expect(await worktreeContents(r, 'app.ts')).toBe(MULTI_SECTION_EDITED);
			expect(await porcelainStatus(r)).toEqual([{ x: 'M', y: ' ', path: 'app.ts' }]);
		});

		it('discards a staged hunk in a combined change, reverting the staged portion while preserving unstaged worktree edits', async () => {
			const r = await createTrackedRepo();
			await r.write('app.ts', MULTI_SECTION_BASE);
			await commitAll(r, 'base commit');

			// Stage section 1 edit into index
			await r.write('app.ts', MULTI_SECTION_STAGE_SECTION1);
			await stageAll(r);

			// In worktree, add section 3 edit as an unstaged modification
			await r.write('app.ts', MULTI_SECTION_EDITED);

			const adapter = engine.adapter(r);
			const { repository, appState } = createTestContext(r, adapter);
			await repository.refresh();

			expect(await porcelainStatus(r)).toEqual([{ x: 'M', y: 'M', path: 'app.ts' }]);

			// In combined view, the change represents both staged and unstaged edits
			const combinedChange = {
				filepath: 'app.ts',
				status: 'M' as const,
				additions: 2,
				deletions: 2,
				diff: '',
				staged: false,
				combined: true
			};

			const combinedDiff = await repository.getFileDiff('app.ts', undefined);
			const combinedHunks = deriveHunks(combinedDiff!.originalContent, combinedDiff!.modifiedContent);
			expect(combinedHunks).toHaveLength(2);

			// Discard the staged hunk (Hunk 0 = Section 1): reverts section 1 from index and worktree, preserves section 3 in worktree
			await applyHunkAction(appState, combinedChange, combinedHunks[0], 'discard');

			expect(await indexContents(r, 'app.ts')).toBe(MULTI_SECTION_BASE);
			expect(await worktreeContents(r, 'app.ts')).toBe(MULTI_SECTION_STAGE_SECTION3);
			expect(await porcelainStatus(r)).toEqual([{ x: ' ', y: 'M', path: 'app.ts' }]);

			expect(repository.changes).toHaveLength(1);
			expect(repository.changes[0].staged).toBe(false);
		});

		it('resolves diff on-demand from the real repository when change content fields are undefined', async () => {
			const r = await createTrackedRepo();
			await r.write('app.ts', MULTI_SECTION_BASE);
			await commitAll(r, 'base commit');

			await r.write('app.ts', MULTI_SECTION_EDITED);

			const adapter = engine.adapter(r);
			const { repository, appState } = createTestContext(r, adapter);
			await repository.refresh();

			// Construct change without pre-populated originalContent / modifiedContent
			const rawChange = {
				filepath: 'app.ts',
				status: 'M' as const,
				additions: 2,
				deletions: 2,
				diff: '',
				staged: false
			};

			const diffDetail = await repository.getFileDiff('app.ts', { staged: false });
			const hunks = deriveHunks(diffDetail!.originalContent, diffDetail!.modifiedContent);
			expect(hunks).toHaveLength(2);

			// Apply stage action with rawChange; applyHunkAction must lazy-fetch diff from repository
			await applyHunkAction(appState, rawChange, hunks[0], 'stage');

			expect(await indexContents(r, 'app.ts')).toBe(MULTI_SECTION_STAGE_SECTION1);
			expect(await worktreeContents(r, 'app.ts')).toBe(MULTI_SECTION_EDITED);
			expect(await porcelainStatus(r)).toEqual([{ x: 'M', y: 'M', path: 'app.ts' }]);
		});

		it('maintains correct offset mapping between diff coordinates and index coordinates when lines are inserted or deleted earlier', async () => {
			const r = await createTrackedRepo();
			const originalLines = [
				'alpha',
				'beta',
				'gamma',
				'delta',
				'epsilon'
			].join('\n') + '\n';
			await r.write('lines.txt', originalLines);
			await commitAll(r, 'base commit');

			// Stage an insertion of 3 lines at the top into the index
			const stagedLines = [
				'INSERTED_TOP_1',
				'INSERTED_TOP_2',
				'INSERTED_TOP_3',
				'alpha',
				'beta',
				'gamma',
				'delta',
				'epsilon'
			].join('\n') + '\n';
			await r.write('lines.txt', stagedLines);
			await stageAll(r);

			// Worktree modifies 'delta' -> 'delta_MODIFIED' at the bottom
			const worktreeLines = [
				'INSERTED_TOP_1',
				'INSERTED_TOP_2',
				'INSERTED_TOP_3',
				'alpha',
				'beta',
				'gamma',
				'delta_MODIFIED',
				'epsilon'
			].join('\n') + '\n';
			await r.write('lines.txt', worktreeLines);

			const adapter = engine.adapter(r);
			const { repository, appState } = createTestContext(r, adapter);
			await repository.refresh();

			const unstagedChange = repository.changes.find((c) => !c.staged);
			const diffDetail = await repository.getFileDiff('lines.txt', { staged: false });
			const hunks = deriveHunks(diffDetail!.originalContent, diffDetail!.modifiedContent);
			expect(hunks).toHaveLength(1);

			// Stage the bottom hunk; mapRange must map the offset into the index with the top insertions
			await applyHunkAction(appState, unstagedChange!, hunks[0], 'stage');

			expect(await indexContents(r, 'lines.txt')).toBe(worktreeLines);
			expect(await worktreeContents(r, 'lines.txt')).toBe(worktreeLines);
			expect(await porcelainStatus(r)).toEqual([{ x: 'M', y: ' ', path: 'lines.txt' }]);
		});

		it('handles multi-hunk interleaved additions, deletions, and replacements in arbitrary order', async () => {
			const r = await createTrackedRepo();
			const baseLines = [
				'line1',
				'line2',
				'ctx_a1',
				'ctx_a2',
				'ctx_a3',
				'ctx_a4',
				'line5_delete_me',
				'ctx_b1',
				'ctx_b2',
				'ctx_b3',
				'ctx_b4',
				'line8_replace_me',
				'line9',
				'line10'
			].join('\n') + '\n';
			await r.write('data.txt', baseLines);
			await commitAll(r, 'base commit');

			const modifiedLines = [
				'line1',
				'line2',
				'line2_inserted',
				'ctx_a1',
				'ctx_a2',
				'ctx_a3',
				'ctx_a4',
				'ctx_b1',
				'ctx_b2',
				'ctx_b3',
				'ctx_b4',
				'line8_REPLACED',
				'line9',
				'line10'
			].join('\n') + '\n';
			await r.write('data.txt', modifiedLines);

			const adapter = engine.adapter(r);
			const { repository, appState } = createTestContext(r, adapter);
			await repository.refresh();

			const diffDetail = await repository.getFileDiff('data.txt', { staged: false });
			const hunks = deriveHunks(diffDetail!.originalContent, diffDetail!.modifiedContent);
			expect(hunks).toHaveLength(3);

			// Stage Hunk 1 (the deletion of line5) first
			const initialChange = repository.changes[0];
			await applyHunkAction(appState, initialChange, hunks[1], 'stage');

			const expectedIndexAfterHunk1 = [
				'line1',
				'line2',
				'ctx_a1',
				'ctx_a2',
				'ctx_a3',
				'ctx_a4',
				'ctx_b1',
				'ctx_b2',
				'ctx_b3',
				'ctx_b4',
				'line8_replace_me',
				'line9',
				'line10'
			].join('\n') + '\n';

			expect(await indexContents(r, 'data.txt')).toBe(expectedIndexAfterHunk1);
			expect(await worktreeContents(r, 'data.txt')).toBe(modifiedLines);
			expect(await porcelainStatus(r)).toEqual([{ x: 'M', y: 'M', path: 'data.txt' }]);

			// Now stage Hunk 0 (the insertion after line2)
			const nextDiff = await repository.getFileDiff('data.txt', { staged: false });
			const nextHunks = deriveHunks(nextDiff!.originalContent, nextDiff!.modifiedContent);
			expect(nextHunks).toHaveLength(2);

			const currentUnstagedChange = repository.changes.find((c) => !c.staged);
			await applyHunkAction(appState, currentUnstagedChange!, nextHunks[0], 'stage');

			const expectedIndexAfterHunk0 = [
				'line1',
				'line2',
				'line2_inserted',
				'ctx_a1',
				'ctx_a2',
				'ctx_a3',
				'ctx_a4',
				'ctx_b1',
				'ctx_b2',
				'ctx_b3',
				'ctx_b4',
				'line8_replace_me',
				'line9',
				'line10'
			].join('\n') + '\n';

			expect(await indexContents(r, 'data.txt')).toBe(expectedIndexAfterHunk0);
			expect(await worktreeContents(r, 'data.txt')).toBe(modifiedLines);

			// Now unstage Hunk 1 (the deletion of line5) so line5 is restored in the index
			const stagedDiff = await repository.getFileDiff('data.txt', { staged: true });
			const stagedHunks = deriveHunks(stagedDiff!.originalContent, stagedDiff!.modifiedContent);
			expect(stagedHunks).toHaveLength(2);

			const currentStagedChange = repository.changes.find((c) => c.staged);
			// stagedHunks[1] corresponds to the deletion of line5 in HEAD vs Index
			await applyHunkAction(appState, currentStagedChange!, stagedHunks[1], 'unstage');

			const expectedIndexAfterUnstage = [
				'line1',
				'line2',
				'line2_inserted',
				'ctx_a1',
				'ctx_a2',
				'ctx_a3',
				'ctx_a4',
				'line5_delete_me',
				'ctx_b1',
				'ctx_b2',
				'ctx_b3',
				'ctx_b4',
				'line8_replace_me',
				'line9',
				'line10'
			].join('\n') + '\n';

			expect(await indexContents(r, 'data.txt')).toBe(expectedIndexAfterUnstage);
			expect(await worktreeContents(r, 'data.txt')).toBe(modifiedLines);
		});
	});
}
