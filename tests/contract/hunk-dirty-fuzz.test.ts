import './rune-setup';

import { expect } from 'bun:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { Text } from '../../packages/core/node_modules/@codemirror/state';
import { Chunk } from '../../packages/core/node_modules/@codemirror/merge';
import { DocumentSession } from '../../packages/core/src/document.svelte';
import {
	applyHunkAction,
	liveHunkCoversRange,
	mapStaleHunkRange,
	type HunkRange
} from '../../packages/core/src/plugins/git/commands';
import { mapRange } from '../../packages/core/src/commands.svelte';
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

/**
 * Contract invariant fuzzer for dirty Hunk Actions (#274).
 *
 * Crosses unsaved-edit positions (above / inside / below the hunk) and edit
 * kinds (insert / delete) with hunk operations (stage / unstage / discard)
 * over throwaway repositories on both real engines. Every run asserts the
 * two invariants externally: the in-memory Document keeps edits outside the
 * targeted hunk range, and real index bytes change only inside the hunk's
 * mapped range. Discard asserts the pre-save/post-save distinction: disk
 * holds the snapshot until the in-memory revert is saved through the normal
 * path. A stale hunk (reviewer reverted the lines by typing) is a silent
 * no-op: index, disk, and Document bytes unchanged with no alert.
 *
 * Seeded and reproducible: failures print seed, positions, and operation.
 * - `FUZZ_SEED` base seed (default 274001); varies the hunk line and markers.
 * - `FUZZ_ONLY_CONTRACT_CASE` replay a single enumerated case index (0-5).
 * Replay example: `FUZZ_SEED=274001 FUZZ_ONLY_CONTRACT_CASE=2 bun test
 * tests/contract/hunk-dirty-fuzz.test.ts --preload ./tests/contract/rune-setup.ts`.
 */

type HunkOp = 'stage' | 'unstage' | 'discard';
type EditPos = 'above' | 'inside' | 'below';
type EditKind = 'insert' | 'delete';

const BASE_SEED = Number(process.env.FUZZ_SEED ?? 274001);
const ONLY_CASE =
	process.env.FUZZ_ONLY_CONTRACT_CASE !== undefined
		? Number(process.env.FUZZ_ONLY_CONTRACT_CASE)
		: undefined;
const POSITIONS: EditPos[] = ['above', 'inside', 'below'];
const OP_SALT: Record<HunkOp, number> = { stage: 0x51a6e, unstage: 0x457a6e, discard: 0xd15ca2d };

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function textOf(content: string): Text {
	return Text.of(content.split(/\r?\n/));
}

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
	const chunks = Chunk.build(textOf(origContent), textOf(modContent));
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

function baseLines(): string[] {
	return ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'];
}

/** Whole-line unsaved edit at a position relative to the snapshot hunk line. */
function applyEdit(snapLines: string[], hunkLine: number, pos: EditPos, kind: EditKind, marker: string): string[] {
	const out = [...snapLines];
	if (pos === 'above') {
		if (kind === 'insert') out.splice(hunkLine, 0, marker);
		else out.splice(Math.max(0, hunkLine - 1), 1);
	} else if (pos === 'below') {
		if (kind === 'insert') out.push(marker);
		else out.splice(out.length - 1, 1);
	} else {
		const target = Math.min(hunkLine, out.length - 1);
		if (kind === 'insert') out.splice(target, 0, marker);
		else out.splice(target, 1);
	}
	return out;
}

interface ContractVector {
	pos: EditPos;
	kind: EditKind;
	hunkLine: number;
	marker: string;
}

function contractVectorFor(seed: number, op: HunkOp, index: number): ContractVector {
	const rand = mulberry32(((seed ^ OP_SALT[op]) + Math.imul(index + 1, 0x9e3779b9)) >>> 0);
	return {
		pos: POSITIONS[index % POSITIONS.length],
		kind: index < POSITIONS.length ? 'insert' : 'delete',
		hunkLine: 1 + Math.floor(rand() * 4),
		marker: `Q${seed % 1000}x${index}`
	};
}

function caseIndices(): number[] {
	const all = [0, 1, 2, 3, 4, 5];
	return ONLY_CASE !== undefined ? all.filter((i) => i === ONLY_CASE) : all;
}

function caseLabel(op: HunkOp, index: number, v: ContractVector): string {
	return (
		`seed=${BASE_SEED} op=${op} case=${index} hunkLine=${v.hunkLine} ` +
		`edit=${v.kind}-${v.pos} marker=${v.marker}`
	);
}

function replayHint(): string {
	return (
		`replay with FUZZ_SEED=${BASE_SEED} FUZZ_ONLY_CONTRACT_CASE=<case> ` +
		`bun test tests/contract/hunk-dirty-fuzz.test.ts --preload ./tests/contract/rune-setup.ts`
	);
}

async function runContractCase(engine: Engine, op: HunkOp, index: number): Promise<void> {
	const v = contractVectorFor(BASE_SEED, op, index);
	const label = caseLabel(op, index, v);
	try {
		const r = await createTrackedRepo();
		const base = `${baseLines().join('\n')}\n`;
		const snapLines = [...baseLines()];
		snapLines[v.hunkLine] = `L${v.hunkLine + 1}`;
		const snap = `${snapLines.join('\n')}\n`;
		await r.write('app.ts', base);
		await commitAll(r, 'base commit');
		await r.write('app.ts', snap);
		if (op === 'unstage') await stageAll(r);

		const curLines = applyEdit(snapLines, v.hunkLine, v.pos, v.kind, v.marker);
		const cur = `${curLines.join('\n')}\n`;

		const adapter = engine.adapter(r);
		const doc = new DocumentSession(repoStorage(), snap, docOrigin(r, 'app.ts'));
		doc.content = cur;
		const { repository, appState } = createDirtyContext(r, adapter, doc, 'app.ts');
		await repository.refresh();

		const change = repository.changes.find((c) => (op === 'unstage' ? c.staged : !c.staged));
		expect(change).toBeDefined();
		const diffDetail = await repository.getFileDiff(
			'app.ts',
			op === 'unstage' ? { staged: true } : { staged: false }
		);
		const hunks = deriveHunks(diffDetail!.originalContent, diffDetail!.modifiedContent);
		expect(hunks).toHaveLength(1);

		const origText = textOf(diffDetail!.originalContent);
		const snapText = textOf(diffDetail!.modifiedContent);
		const curText = textOf(cur);
		const dirtyActive = op !== 'unstage' && cur !== diffDetail!.modifiedContent;
		const effHunk = dirtyActive
			? mapStaleHunkRange(hunks[0], snapText, curText)
			: hunks[0];
		const modText = dirtyActive ? curText : snapText;
		const live = Chunk.build(origText, modText);
		const covers = liveHunkCoversRange(live, effHunk.fromB, effHunk.toB);
		expect(covers).toBe(true);

		if (op === 'stage') {
			const stagedBefore = (await indexContents(r, 'app.ts')) ?? '';
			const stagedText = textOf(stagedBefore);
			const indexRange = mapRange(effHunk.fromA, effHunk.toA, origText, stagedText);
			const replacement = curText.sliceString(effHunk.fromB, effHunk.toB);
			const expected =
				stagedText.sliceString(0, indexRange.from) +
				replacement +
				stagedText.sliceString(indexRange.to);

			await applyHunkAction(appState, change!, hunks[0], 'stage');

			expect(await indexContents(r, 'app.ts')).toBe(expected);
			expect(await workingTreeContents(r, 'app.ts')).toBe(snap);
			expect(doc.content).toBe(cur);
			expect(doc.isModified).toBe(true);
			const indexAfter = (await indexContents(r, 'app.ts')) ?? '';
			const diskAfter = (await workingTreeContents(r, 'app.ts')) ?? '';
			expect(await porcelainStatus(r)).toEqual(
				indexAfter === diskAfter
					? [{ x: 'M', y: ' ', path: 'app.ts' }]
					: [{ x: 'M', y: 'M', path: 'app.ts' }]
			);
		} else if (op === 'unstage') {
			await applyHunkAction(appState, change!, hunks[0], 'unstage');

			expect(await indexContents(r, 'app.ts')).toBe(base);
			expect(await workingTreeContents(r, 'app.ts')).toBe(snap);
			expect(doc.content).toBe(cur);
			expect(await porcelainStatus(r)).toEqual([{ x: ' ', y: 'M', path: 'app.ts' }]);
		} else {
			const stagedBefore = (await indexContents(r, 'app.ts')) ?? '';
			const stagedText = textOf(stagedBefore);
			const indexRange = mapRange(effHunk.fromA, effHunk.toA, origText, stagedText);
			const replacement = stagedText.sliceString(indexRange.from, indexRange.to);
			const expected =
				curText.sliceString(0, effHunk.fromB) +
				replacement +
				curText.sliceString(effHunk.toB);

			await applyHunkAction(appState, change!, hunks[0], 'discard');

			// In-memory revert: disk still holds the snapshot until save.
			expect(doc.content).toBe(expected);
			expect(await workingTreeContents(r, 'app.ts')).toBe(snap);
			expect(await indexContents(r, 'app.ts')).toBe(base);
			expect(await porcelainStatus(r)).toEqual([{ x: ' ', y: 'M', path: 'app.ts' }]);

			// Saving persists the in-memory revert through the normal path.
			expect(await doc.save({ coveredByRoot: true })).toBe(true);
			expect(await workingTreeContents(r, 'app.ts')).toBe(doc.content);
		}
	} catch (e) {
		throw new Error(`${label}. ${replayHint()}\n${(e as Error).message}`);
	}
}

for (const engine of [spawnEngine, isomorphicEngine]) {
	describe(`${engine.name} — dirty hunk-action invariant fuzz (#274)`, () => {
		it('stage fuzzer stages the mapped hunk and preserves outside edits', async () => {
			for (const i of caseIndices()) {
				await runContractCase(engine, 'stage', i);
			}
		});

		it('unstage fuzzer reverts the hunk and preserves outside edits', async () => {
			for (const i of caseIndices()) {
				await runContractCase(engine, 'unstage', i);
			}
		});

		it('discard fuzzer reverts in memory and persists through save', async () => {
			for (const i of caseIndices()) {
				await runContractCase(engine, 'discard', i);
			}
		});

		it('treats a hunk reverted by typing as a silent no-op', async () => {
			const alerts: string[] = [];
			try {
				const r = await createTrackedRepo();
				await r.write('app.ts', 'a\nb\nc\n');
				await commitAll(r, 'base commit');
				await r.write('app.ts', 'a\nB\nc\n');

				const adapter = engine.adapter(r);
				const doc = new DocumentSession(repoStorage(), 'a\nB\nc\n', docOrigin(r, 'app.ts'));
				// Reviewer reverted the hunk in the pane without saving.
				doc.content = 'a\nb\nc\n';
				const { repository, appState } = createDirtyContext(r, adapter, doc, 'app.ts', alerts);
				await repository.refresh();

				const change = repository.changes.find((c) => !c.staged);
				expect(change).toBeDefined();
				const diffDetail = await repository.getFileDiff('app.ts', { staged: false });
				const hunks = deriveHunks(diffDetail!.originalContent, diffDetail!.modifiedContent);
				expect(hunks).toHaveLength(1);

				await applyHunkAction(appState, change!, hunks[0], 'stage');

				expect(alerts).toHaveLength(0);
				expect(await indexContents(r, 'app.ts')).toBe('a\nb\nc\n');
				expect(await workingTreeContents(r, 'app.ts')).toBe('a\nB\nc\n');
				expect(doc.content).toBe('a\nb\nc\n');
				expect(await porcelainStatus(r)).toEqual([{ x: ' ', y: 'M', path: 'app.ts' }]);
			} catch (e) {
				throw new Error(`seed=${BASE_SEED} stale-noop. ${replayHint()}\n${(e as Error).message}`);
			}
		});
	});
}
