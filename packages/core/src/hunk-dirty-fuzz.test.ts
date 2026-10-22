import "../../../tests/contract/rune-setup";
import { describe, it, expect, mock } from "bun:test";
import { Text } from "@codemirror/state";
import { Chunk } from "@codemirror/merge";
import {
	applyHunkAction,
	clampHunkPos,
	liveHunkCoversRange,
	mapStaleHunkRange,
	documentOriginForFilepath,
	type DirtyDocumentLike,
	type GitCommandContext,
	type HunkRange
} from "./plugins/git/commands";
import { mapRange } from "./commands.svelte";
import type { GitChange, VCSAdapter } from "./project/vcs";
import type { FileOrigin } from "./storage";

/**
 * Deterministic invariant fuzzer for dirty Hunk Actions (#274).
 *
 * Crosses unsaved-edit positions (above / inside / below the hunk) and edit
 * kinds (insert / delete / modify) with hunk operations (stage / unstage /
 * discard). Every run asserts the two invariants from the spec: in-memory
 * edits outside the targeted hunk range are preserved, and index byte changes
 * stay confined to the hunk's mapped range. Stale hunks (user reverted the
 * lines) must no-op silently: no writes, no alert, and no `refresh()`.
 *
 * Seeded and reproducible: failures print seed, positions, and operation.
 * - `FUZZ_SEED` base seed (default 274001).
 * - `FUZZ_CASES` apply-level cases per operation (default 40).
 * - `FUZZ_ONLY_CASE` replay a single apply-level case index within its op.
 * - `FUZZ_PURE_CASES` pure-helper vectors (default 200).
 * - `FUZZ_PURE_ONLY` replay a single pure-helper vector.
 * Replay example: `FUZZ_SEED=274001 FUZZ_ONLY_CASE=7 bun test
 * packages/core/src/hunk-dirty-fuzz.test.ts --preload
 * ./tests/contract/rune-setup.ts -t "stage fuzzer"`.
 *
 * Scope: stage/unstage cover the index-write path, discard covers the
 * unstaged working-tree path through the bound Document. Staged-scope discard
 * (index-plus-working-tree revert) keeps its existing targeted tests.
 */

type SnapshotKind = "replace" | "insert" | "delete";
type EditPos = "above" | "inside" | "below";
type EditKind = "insert" | "delete" | "modify";
type HunkOp = "stage" | "unstage" | "discard";

const BASE_SEED = Number(process.env.FUZZ_SEED ?? 274001);
const CASES_PER_OP = Number(process.env.FUZZ_CASES ?? 40);
const ONLY_CASE =
	process.env.FUZZ_ONLY_CASE !== undefined ? Number(process.env.FUZZ_ONLY_CASE) : undefined;
const PURE_VECTORS = Number(process.env.FUZZ_PURE_CASES ?? 200);
const PURE_ONLY =
	process.env.FUZZ_PURE_ONLY !== undefined ? Number(process.env.FUZZ_PURE_ONLY) : undefined;

const OP_SALT: Record<HunkOp, number> = { stage: 0x51a6e, unstage: 0x457a6e, discard: 0xd15ca2d };
const POSITIONS: EditPos[] = ["above", "inside", "below"];
const KINDS: EditKind[] = ["insert", "delete", "modify"];
const SNAPSHOTS: SnapshotKind[] = ["replace", "insert", "delete"];

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

function snapshotHunks(originalContent: string, modifiedContent: string): HunkRange[] {
	const chunks = Chunk.build(textOf(originalContent), textOf(modifiedContent));
	return chunks.map((c) => ({ fromA: c.fromA, toA: c.toA, fromB: c.fromB, toB: c.toB }));
}

interface FakeDoc extends DirtyDocumentLike {
	content: string;
	isModified: boolean;
	origin: FileOrigin | null;
}

interface DirtyHarness {
	ctx: GitCommandContext;
	repository: {
		adapter: Partial<VCSAdapter>;
		isBusy: boolean;
		refresh: ReturnType<typeof mock>;
		getFileDiff: (filepath: string, options?: unknown) => Promise<unknown>;
	};
	alerts: string[];
	indexWrites: string[];
	fileWrites: string[];
	appliedEdits: string[];
	doc: FakeDoc | undefined;
	refreshCalls: () => number;
}

function createDirtyHarness(docContent: string, docIsModified: boolean): DirtyHarness {
	const alerts: string[] = [];
	const indexWrites: string[] = [];
	const fileWrites: string[] = [];
	const appliedEdits: string[] = [];
	const root: FileOrigin = { scheme: "file", path: "/repo", name: "repo" };
	const doc: FakeDoc = {
		origin: documentOriginForFilepath(root, "test.txt"),
		content: docContent,
		isModified: docIsModified
	};
	const refresh = mock(async () => {});
	const ctx: GitCommandContext = {
		getWorkspace: () => ({ project: { repository } }) as never,
		alert: mock(async (msg: string) => {
			alerts.push(msg);
		}),
		confirm: mock(async () => false),
		getDiffNavigator: () => undefined,
		getWorkingCopyContent: (filepath: string) => {
			if (filepath !== "test.txt") return undefined;
			return { content: doc.content };
		},
		applyWorkingTreeEdit: (filepath: string, content: string) => {
			if (filepath !== "test.txt") return false;
			if (doc.content === content) return true;
			doc.content = content;
			doc.isModified = true;
			appliedEdits.push(content);
			return true;
		}
	};
	const repository = {
		adapter: {
			updateIndexContent: mock(async (_file: string, content: string) => {
				indexWrites.push(content);
			}),
			updateFileContent: mock(async (_file: string, content: string) => {
				fileWrites.push(content);
			})
		} as Partial<VCSAdapter>,
		isBusy: false,
		refresh,
		getFileDiff: async () => null
	};
	return {
		ctx,
		repository,
		alerts,
		indexWrites,
		fileWrites,
		appliedEdits,
		doc,
		refreshCalls: () => refresh.mock.calls.length
	};
}

function createTestChange(overrides: Partial<GitChange> = {}): GitChange {
	return {
		filepath: "test.txt",
		status: "M",
		additions: 1,
		deletions: 0,
		diff: "",
		staged: false,
		originalContent: "a",
		modifiedContent: "b",
		...overrides
	};
}

function baseLines(): string[] {
	return ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8"];
}

function applySnapshot(lines: string[], kind: SnapshotKind, hunkLine: number): string[] {
	const out = [...lines];
	if (kind === "replace") out[hunkLine] = `L${hunkLine + 1}`;
	else if (kind === "insert") out.splice(hunkLine, 0, "S");
	else out.splice(hunkLine, 1);
	return out;
}

interface AppliedEdit {
	curLines: string[];
	kindApplied: EditKind;
	targetLine: number;
}

/** Whole-line unsaved edit at a position relative to the snapshot hunk line. */
function applyEdit(
	snapLines: string[],
	hunkLine: number,
	pos: EditPos,
	kind: EditKind,
	marker: string
): AppliedEdit {
	const out = [...snapLines];
	let target: number;
	if (pos === "above") {
		target = Math.max(0, hunkLine - 1);
		if (kind === "insert") {
			out.splice(hunkLine, 0, marker);
			target = hunkLine;
		} else if (kind === "delete") {
			out.splice(target, 1);
		} else {
			out[target] = `${out[target]}${marker}`;
		}
	} else if (pos === "below") {
		if (kind === "insert") {
			target = out.length;
			out.push(marker);
		} else {
			target = out.length - 1;
			if (kind === "delete") out.splice(target, 1);
			else out[target] = `${out[target]}${marker}`;
		}
	} else {
		// Inside: the hunk line itself (for a deletion hunk, the line now
		// covering the deletion point). Insert lands at the hunk start edge.
		target = Math.min(hunkLine, out.length - 1);
		if (kind === "insert") out.splice(target, 0, marker);
		else if (kind === "delete") out.splice(target, 1);
		else out[target] = `${out[target]}${marker}`;
	}
	return { curLines: out, kindApplied: kind, targetLine: target };
}

interface ApplyVector {
	snapshotKind: SnapshotKind;
	hunkLine: number;
	editPos: EditPos;
	editKind: EditKind;
}

/** Independent per-case vector: position/kind cycle for full coverage, RNG for snapshot shape. */
function applyVectorFor(seed: number, op: HunkOp, index: number): ApplyVector {
	const rand = mulberry32(((seed ^ OP_SALT[op]) + Math.imul(index + 1, 0x9e3779b9)) >>> 0);
	return {
		snapshotKind: SNAPSHOTS[Math.floor(rand() * SNAPSHOTS.length)],
		// Middle lines only so above/below targets always exist.
		hunkLine: 2 + Math.floor(rand() * 4),
		editPos: POSITIONS[index % POSITIONS.length],
		editKind: KINDS[Math.floor(index / POSITIONS.length) % KINDS.length]
	};
}

function caseLabel(
	op: HunkOp,
	index: number,
	v: ApplyVector,
	edit: AppliedEdit,
	effHunk: HunkRange,
	covers: boolean
): string {
	return (
		`seed=${BASE_SEED} op=${op} case=${index} snapshot=${v.snapshotKind}@line${v.hunkLine} ` +
		`edit=${edit.kindApplied}-${v.editPos}@line${edit.targetLine} ` +
		`effB=[${effHunk.fromB},${effHunk.toB}] covers=${covers}`
	);
}

function replayHint(op: HunkOp, index: number): string {
	return (
		`replay with FUZZ_SEED=${BASE_SEED} FUZZ_ONLY_CASE=${index} ` +
		`bun test packages/core/src/hunk-dirty-fuzz.test.ts --preload ./tests/contract/rune-setup.ts -t "${op} fuzzer"`
	);
}

async function runApplyCase(op: HunkOp, index: number): Promise<void> {
	const v = applyVectorFor(BASE_SEED, op, index);
	const orig = `${baseLines().join("\n")}\n`;
	const snap = `${applySnapshot(baseLines(), v.snapshotKind, v.hunkLine).join("\n")}\n`;
	const hunks = snapshotHunks(orig, snap);
	if (hunks.length !== 1) {
		throw new Error(
			`seed=${BASE_SEED} op=${op} case=${index}: expected a single snapshot hunk, got ${hunks.length}. ${replayHint(op, index)}`
		);
	}
	const [hunk] = hunks;
	const edit = applyEdit(
		snap.split("\n").slice(0, -1),
		v.hunkLine,
		v.editPos,
		v.editKind,
		`X${index}`
	);
	const cur = edit.curLines.length > 0 ? `${edit.curLines.join("\n")}\n` : "";
	const stagedContent = op === "unstage" ? snap : orig;
	const change = createTestChange({
		staged: op === "unstage",
		originalContent: orig,
		modifiedContent: snap,
		stagedContent
	});
	const harness = createDirtyHarness(cur, cur !== snap);

	const origText = textOf(orig);
	const snapText = textOf(snap);
	const curText = textOf(cur);
	const stagedText = textOf(stagedContent);
	// Mirror the content-resolution choke point: only the working-tree side
	// (unstaged scope) is ever substituted with Document content.
	const dirtyActive = op !== "unstage" && cur !== snap;
	const effHunk = dirtyActive ? mapStaleHunkRange(hunk, snapText, curText) : hunk;
	const modText = dirtyActive ? curText : snapText;
	const covers = liveHunkCoversRange(Chunk.build(origText, modText), effHunk.fromB, effHunk.toB);
	const label = caseLabel(op, index, v, edit, effHunk, covers);

	try {
		await applyHunkAction(harness.ctx, change, hunk, op);

		expect(harness.alerts).toHaveLength(0);
		if (!covers) {
			// Stale hunk: silent no-op with no refresh.
			expect(harness.indexWrites).toHaveLength(0);
			expect(harness.fileWrites).toHaveLength(0);
			expect(harness.appliedEdits).toHaveLength(0);
			expect(harness.doc!.content).toBe(cur);
			expect(harness.refreshCalls()).toBe(0);
			return;
		}

		expect(harness.refreshCalls()).toBe(1);
		if (op === "stage") {
			const indexRange = mapRange(effHunk.fromA, effHunk.toA, origText, stagedText);
			const replacement = curText.sliceString(effHunk.fromB, effHunk.toB);
			const expected =
				stagedText.sliceString(0, indexRange.from) +
				replacement +
				stagedText.sliceString(indexRange.to);
			expect(harness.indexWrites).toEqual([expected]);
			expect(harness.indexWrites[0].slice(0, indexRange.from)).toBe(
				stagedContent.slice(0, indexRange.from)
			);
			expect(harness.indexWrites[0].slice(indexRange.from + replacement.length)).toBe(
				stagedContent.slice(indexRange.to)
			);
			expect(harness.fileWrites).toHaveLength(0);
			expect(harness.appliedEdits).toHaveLength(0);
			expect(harness.doc!.content).toBe(cur);
		} else if (op === "unstage") {
			const indexRange = mapRange(effHunk.fromB, effHunk.toB, modText, stagedText);
			const replacement = origText.sliceString(effHunk.fromA, effHunk.toA);
			const expected =
				stagedText.sliceString(0, indexRange.from) +
				replacement +
				stagedText.sliceString(indexRange.to);
			expect(harness.indexWrites).toEqual([expected]);
			expect(harness.indexWrites[0].slice(0, indexRange.from)).toBe(
				stagedContent.slice(0, indexRange.from)
			);
			expect(harness.indexWrites[0].slice(indexRange.from + replacement.length)).toBe(
				stagedContent.slice(indexRange.to)
			);
			expect(harness.fileWrites).toHaveLength(0);
			expect(harness.appliedEdits).toHaveLength(0);
			expect(harness.doc!.content).toBe(cur);
		} else {
			const indexRange = mapRange(effHunk.fromA, effHunk.toA, origText, stagedText);
			const replacement = stagedText.sliceString(indexRange.from, indexRange.to);
			const expected =
				curText.sliceString(0, effHunk.fromB) +
				replacement +
				curText.sliceString(effHunk.toB);
			expect(harness.doc!.content).toBe(expected);
			expect(harness.doc!.content.slice(0, effHunk.fromB)).toBe(cur.slice(0, effHunk.fromB));
			expect(harness.doc!.content.slice(effHunk.fromB + replacement.length)).toBe(
				cur.slice(effHunk.toB)
			);
			expect(harness.indexWrites).toHaveLength(0);
			expect(harness.fileWrites).toHaveLength(0);
		}
	} catch (e) {
		throw new Error(`${label}. ${replayHint(op, index)}\n${(e as Error).message}`);
	}
}

function caseIndices(): number[] {
	const all = Array.from({ length: CASES_PER_OP }, (_, i) => i);
	return ONLY_CASE !== undefined ? all.filter((i) => i === ONLY_CASE) : all;
}

describe("dirty hunk-action invariant fuzzer (#274)", () => {
	for (const op of ["stage", "unstage", "discard"] as HunkOp[]) {
		it(`${op} fuzzer preserves outside edits and confines index writes`, async () => {
			for (const i of caseIndices()) {
				await runApplyCase(op, i);
			}
		});
	}

	it("pins the collapsed-at-boundary coverage rule as acceptable", () => {
		// Live change "b"->"B" spans B offsets [2,4). A collapsed range at the
		// chunk end still counts as covered (it also matches collapsed
		// deletion chunks at the same point); a point past it does not.
		const origText = textOf("a\nb\nc\n");
		const modText = textOf("a\nB\nc\n");
		const [chunk] = Chunk.build(origText, modText);
		expect(liveHunkCoversRange([chunk], chunk.fromB, chunk.fromB)).toBe(true);
		expect(liveHunkCoversRange([chunk], chunk.toB, chunk.toB)).toBe(true);
		expect(liveHunkCoversRange([chunk], chunk.toB + 1, chunk.toB + 1)).toBe(false);
		expect(liveHunkCoversRange([chunk], 0, 0)).toBe(false);
		// Collapsed deletion chunks match at their point.
		const delOrig = textOf("a\nb\nc\nd\n");
		const delMod = textOf("a\nc\nd\n");
		const [del] = Chunk.build(delOrig, delMod);
		expect(del.fromB).toBe(del.toB);
		expect(liveHunkCoversRange([del], del.fromB, del.toB)).toBe(true);
		expect(liveHunkCoversRange([del], 0, 0)).toBe(false);
	});

	it("maps and covers random line edits with clamping and identity", () => {
		const indices = Array.from({ length: PURE_VECTORS }, (_, k) => k);
		const selected = PURE_ONLY !== undefined ? indices.filter((k) => k === PURE_ONLY) : indices;
		expect(selected.length).toBeGreaterThan(0);
		for (const k of selected) {
			const rand = mulberry32(((BASE_SEED ^ 0x1f022) + Math.imul(k + 1, 0x9e3779b9)) >>> 0);
			let detail = `seed=${BASE_SEED} pure=${k}`;
			try {
				const base = ["l1", "l2", "l3", "l4", "l5", "l6"];
				const snapAt = Math.floor(rand() * base.length);
				const snapPick = rand();
				const snapLines = [...base];
				if (snapPick < 0.4) snapLines[snapAt] = `M${k}`;
				else if (snapPick < 0.7) snapLines.splice(snapAt, 1);
				else snapLines.splice(snapAt, 0, `S${k}`);
				const curLines = [...snapLines];
				// Every seventh vector keeps the snapshot text verbatim to pin
				// the clean-path identity (mapped range equals hunk).
				const keepClean = k % 7 === 6;
				const curAt = Math.floor(rand() * (curLines.length + 1));
				const curPick = rand();
				if (!keepClean) {
					if (curPick < 0.4) curLines.splice(Math.min(curAt, curLines.length), 0, `P${k}`);
					else if (curPick < 0.7) {
						if (curLines.length > 1) curLines.splice(curAt % curLines.length, 1);
					} else {
						const target = curAt % curLines.length;
						curLines[target] = `${curLines[target]}_e${k}`;
					}
				}
				const origText = textOf(`${base.join("\n")}\n`);
				const snapText = textOf(`${snapLines.join("\n")}\n`);
				const curText = textOf(`${curLines.join("\n")}\n`);
				const snapChunks = Chunk.build(origText, snapText);
				expect(snapChunks.length).toBeGreaterThan(0);
				const picked = snapChunks[k % snapChunks.length];
				const probe = k % 4;
				const hunk: HunkRange =
					probe === 0
						? { fromA: picked.fromA, toA: picked.toA, fromB: picked.fromB, toB: picked.toB }
						: probe === 1
							? { fromA: picked.fromA, toA: picked.toA, fromB: picked.fromB, toB: picked.fromB }
							: probe === 2
								? { fromA: picked.fromA, toA: picked.toA, fromB: picked.toB, toB: picked.toB }
								: { fromA: picked.fromA, toA: picked.toA, fromB: picked.toB + 1, toB: picked.toB + 1 };
				const label =
					`seed=${BASE_SEED} pure=${k} probe=${["verbatim", "at-from", "at-to", "past-to"][probe]} ` +
					`hunkB=[${hunk.fromB},${hunk.toB}] snapLen=${snapText.length} curLen=${curText.length}. ` +
					`replay with FUZZ_SEED=${BASE_SEED} FUZZ_PURE_ONLY=${k} bun test ` +
					`packages/core/src/hunk-dirty-fuzz.test.ts --preload ./tests/contract/rune-setup.ts ` +
					`-t "random line edits"`;
				detail = label;

				const mapped = mapStaleHunkRange(hunk, snapText, curText);
				expect(mapped.fromB).toBeGreaterThanOrEqual(0);
				expect(mapped.toB).toBeLessThanOrEqual(curText.length);
				expect(mapped.fromB).toBeLessThanOrEqual(mapped.toB);
				expect(mapped.fromA).toBe(hunk.fromA);
				expect(mapped.toA).toBe(hunk.toA);
				if (snapText.toString() === curText.toString()) {
					expect(mapped.fromB).toBe(clampHunkPos(hunk.fromB, curText.length));
					expect(mapped.toB).toBe(clampHunkPos(hunk.toB, curText.length));
				}

				const live = Chunk.build(origText, curText);
				const covers = liveHunkCoversRange(live, mapped.fromB, mapped.toB);
				if (mapped.fromB < mapped.toB) {
					expect(covers).toBe(
						live.some((c) => mapped.fromB < c.toB && mapped.toB > c.fromB)
					);
				} else {
					expect(covers).toBe(
						live.some((c) => c.fromB <= mapped.fromB && mapped.fromB <= c.toB)
					);
				}
			} catch (e) {
				throw new Error(`${detail}\n${(e as Error).message}`);
			}
		}
	});
});
