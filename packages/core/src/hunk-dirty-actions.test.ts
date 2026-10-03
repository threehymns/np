import "../../../tests/contract/rune-setup";
import { describe, it, expect, mock } from "bun:test";
import { Text } from "@codemirror/state";
import { Chunk } from "@codemirror/merge";
import {
	applyHunkAction,
	clampHunkPos,
	documentOriginForFilepath,
	findDirtyDocument,
	liveHunkCoversRange,
	mapStaleHunkRange,
	type DirtyDocumentLike,
	type GitCommandContext,
	type HunkRange
} from "./plugins/git/commands";
import type { GitChange, VCSAdapter } from "./project/vcs";
import type { FileOrigin } from "./storage";

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
}

function createDirtyHarness(options: {
	adapter?: Partial<VCSAdapter>;
	docContent?: string;
	docIsModified?: boolean;
	bindDoc?: boolean;
}): DirtyHarness {
	const alerts: string[] = [];
	const indexWrites: string[] = [];
	const fileWrites: string[] = [];
	const appliedEdits: string[] = [];
	const root: FileOrigin = { scheme: "file", path: "/repo", name: "repo" };
	const doc: FakeDoc | undefined =
		options.bindDoc === false
			? undefined
			: {
					origin: documentOriginForFilepath(root, "test.txt"),
					content: options.docContent ?? "",
					isModified: options.docIsModified ?? false
				};
	const adapter: Partial<VCSAdapter> = {
		updateIndexContent: mock(async (_file: string, content: string) => {
			indexWrites.push(content);
		}),
		updateFileContent: mock(async (_file: string, content: string) => {
			fileWrites.push(content);
		}),
		...(options.adapter ?? {})
	};
	const repository = {
		adapter,
		isBusy: false,
		refresh: mock(async () => {}),
		getFileDiff: async (filepath: string, _options?: unknown) => {
			if (adapter.getFileDiff) {
				return await adapter.getFileDiff(filepath, _options as never);
			}
			return null;
		}
	};
	const ctx: GitCommandContext = {
		getWorkspace: () => ({ project: { repository } }) as never,
		alert: mock(async (msg: string) => {
			alerts.push(msg);
		}),
		confirm: mock(async () => false),
		getDiffNavigator: () => undefined,
		getWorkingCopyContent: (filepath: string) => {
			if (filepath !== "test.txt" || !doc) return undefined;
			return { content: doc.content };
		},
		applyWorkingTreeEdit: (filepath: string, content: string) => {
			if (filepath !== "test.txt" || !doc) return false;
			if (doc.content === content) return true;
			doc.content = content;
			doc.isModified = true;
			appliedEdits.push(content);
			return true;
		}
	};
	return { ctx, repository, alerts, indexWrites, fileWrites, appliedEdits, doc };
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

function snapshotHunks(originalContent: string, modifiedContent: string): HunkRange[] {
	const origText = Text.of(originalContent.split(/\r?\n/));
	const modText = Text.of(modifiedContent.split(/\r?\n/));
	return Chunk.build(origText, modText).map((c) => ({
		fromA: c.fromA,
		toA: c.toA,
		fromB: c.fromB,
		toB: c.toB
	}));
}

describe("hunk actions on unsaved edits (#273)", () => {
	it("stages the hunk as it currently reads, including unsaved edits inside the hunk", async () => {
		const originalContent = "a\nb\nc\n";
		const snapshotModified = "a\nB\nc\n";
		const { ctx, repository, alerts, indexWrites, fileWrites, doc } = createDirtyHarness({
			docContent: "a\nB edited\nc\n",
			docIsModified: true
		});
		const change = createTestChange({
			originalContent,
			modifiedContent: snapshotModified,
			stagedContent: originalContent
		});
		const [hunk] = snapshotHunks(originalContent, snapshotModified);

		await applyHunkAction(ctx, change, hunk, "stage");

		expect(alerts).toHaveLength(0);
		// The pane edit inside the hunk is staged; nothing touches the disk.
		expect(indexWrites).toEqual(["a\nB edited\nc\n"]);
		expect(fileWrites).toHaveLength(0);
		expect(doc!.content).toBe("a\nB edited\nc\n");
		expect(repository.refresh).toHaveBeenCalled();
	});

	it("keeps the clean path byte-identical when the bound Document is unmodified", async () => {
		const originalContent = "line1\nline2\nline3\n";
		const snapshotModified = "line1\nline2 edited\nline3\n";
		const change = createTestChange({
			originalContent,
			modifiedContent: snapshotModified,
			stagedContent: originalContent
		});
		const [hunk] = snapshotHunks(originalContent, snapshotModified);

		const bound = createDirtyHarness({ docContent: snapshotModified, docIsModified: false });
		await applyHunkAction(bound.ctx, change, hunk, "stage");

		const unbound = createDirtyHarness({ bindDoc: false });
		await applyHunkAction(unbound.ctx, change, hunk, "stage");

		expect(bound.indexWrites).toEqual(unbound.indexWrites);
		expect(bound.indexWrites).toEqual([snapshotModified]);
		expect(bound.alerts).toHaveLength(0);
	});

	it("maps edits above the hunk through current text so the action lands on the intended lines", async () => {
		const originalContent = "l1\nl2\nl3\nl4\nl5\nl6\n";
		const snapshotModified = "l1\nl2\nl3\nl4\nL5\nl6\n";
		// Two unsaved lines inserted above the hunk shift every snapshot offset below them.
		const docContent = "X\nY\nl1\nl2\nl3\nl4\nL5\nl6\n";
		const { ctx, alerts, indexWrites, fileWrites } = createDirtyHarness({
			docContent,
			docIsModified: true
		});
		const change = createTestChange({
			originalContent,
			modifiedContent: snapshotModified,
			stagedContent: originalContent
		});
		const [hunk] = snapshotHunks(originalContent, snapshotModified);

		await applyHunkAction(ctx, change, hunk, "stage");

		expect(alerts).toHaveLength(0);
		expect(fileWrites).toHaveLength(0);
		// Only the hunk's line is staged, at its original position; the
		// unsaved insertion above never leaks into the index.
		expect(indexWrites).toEqual(["l1\nl2\nl3\nl4\nL5\nl6\n"]);
	});

	it("treats a hunk range outside the snapshot bounds as a silent no-op", async () => {
		const { ctx, repository, alerts, indexWrites, fileWrites } = createDirtyHarness({
			docContent: "a\nB\nc\n",
			docIsModified: false
		});
		const change = createTestChange({
			originalContent: "a\nb\nc\n",
			modifiedContent: "a\nB\nc\n",
			stagedContent: "a\nb\nc\n"
		});

		await applyHunkAction(
			ctx,
			change,
			{ fromA: 0, toA: 1, fromB: 999, toB: 1005 },
			"stage"
		);

		expect(indexWrites).toHaveLength(0);
		expect(fileWrites).toHaveLength(0);
		expect(alerts).toHaveLength(0);
		expect(repository.refresh).not.toHaveBeenCalled();
	});

	it("treats a hunk whose lines were already reverted by typing as a silent no-op", async () => {
		const originalContent = "a\nb\nc\n";
		const snapshotModified = "a\nB\nc\n";
		const { ctx, repository, alerts, indexWrites, fileWrites } = createDirtyHarness({
			// The reviewer manually reverted the hunk in the pane without saving.
			docContent: "a\nb\nc\n",
			docIsModified: true
		});
		const change = createTestChange({
			originalContent,
			modifiedContent: snapshotModified,
			stagedContent: originalContent
		});
		const [hunk] = snapshotHunks(originalContent, snapshotModified);

		await applyHunkAction(ctx, change, hunk, "stage");

		expect(indexWrites).toHaveLength(0);
		expect(fileWrites).toHaveLength(0);
		expect(alerts).toHaveLength(0);
		expect(repository.refresh).not.toHaveBeenCalled();
	});

	it("unstages base text to the index while keeping other in-memory edits", async () => {
		const originalContent = "a\nb\nc\n";
		const indexContent = "a\nB\nc\n";
		const { ctx, alerts, indexWrites, fileWrites, appliedEdits, doc } = createDirtyHarness({
			// Working tree: staged hunk text plus an unsaved pane edit below it.
			docContent: "a\nB\nc\npane edit\n",
			docIsModified: true
		});
		const change = createTestChange({
			staged: true,
			originalContent,
			modifiedContent: indexContent,
			stagedContent: indexContent
		});
		const [hunk] = snapshotHunks(originalContent, indexContent);

		await applyHunkAction(ctx, change, hunk, "unstage");

		expect(alerts).toHaveLength(0);
		expect(indexWrites).toEqual([originalContent]);
		// Unstage never writes the working tree: the Document keeps both the
		// hunk text and the pane edit, and the disk is untouched.
		expect(appliedEdits).toHaveLength(0);
		expect(fileWrites).toHaveLength(0);
		expect(doc!.content).toBe("a\nB\nc\npane edit\n");
	});

	it("discards an unstaged hunk as an in-memory edit without touching the disk", async () => {
		const originalContent = "a\nb\nc\n";
		const snapshotModified = "a\nB\nc\n";
		const { ctx, alerts, indexWrites, fileWrites, appliedEdits, doc } = createDirtyHarness({
			docContent: "a\nB\nc\nEXTRA\n",
			docIsModified: true
		});
		const change = createTestChange({
			originalContent,
			modifiedContent: snapshotModified,
			stagedContent: originalContent
		});
		const [hunk] = snapshotHunks(originalContent, snapshotModified);

		await applyHunkAction(ctx, change, hunk, "discard");

		expect(alerts).toHaveLength(0);
		// Base text restored for the hunk; the unrelated pane edit survives
		// in memory; the index and the disk never move.
		expect(appliedEdits).toEqual(["a\nb\nc\nEXTRA\n"]);
		expect(doc!.content).toBe("a\nb\nc\nEXTRA\n");
		expect(indexWrites).toHaveLength(0);
		expect(fileWrites).toHaveLength(0);
	});

	it("discards through the bound Document even when it starts clean", async () => {
		const originalContent = "a\nb\nc\n";
		const snapshotModified = "a\nB\nc\n";
		const { ctx, fileWrites, appliedEdits, doc } = createDirtyHarness({
			docContent: snapshotModified,
			docIsModified: false
		});
		const change = createTestChange({
			originalContent,
			modifiedContent: snapshotModified,
			stagedContent: originalContent
		});
		const [hunk] = snapshotHunks(originalContent, snapshotModified);

		await applyHunkAction(ctx, change, hunk, "discard");

		expect(appliedEdits).toEqual([originalContent]);
		expect(doc!.content).toBe(originalContent);
		expect(fileWrites).toHaveLength(0);
	});

	it("falls back to the disk write when no Document is bound", async () => {
		const originalContent = "a\nb\nc\n";
		const snapshotModified = "a\nB\nc\n";
		const { ctx, fileWrites, appliedEdits } = createDirtyHarness({ bindDoc: false });
		const change = createTestChange({
			originalContent,
			modifiedContent: snapshotModified,
			stagedContent: originalContent
		});
		const [hunk] = snapshotHunks(originalContent, snapshotModified);

		await applyHunkAction(ctx, change, hunk, "discard");

		expect(appliedEdits).toHaveLength(0);
		expect(fileWrites).toEqual([originalContent]);
	});

	it("restores prior index content and reports when a dirty stage write fails", async () => {
		const indexCalls: string[] = [];
		const { ctx, alerts } = createDirtyHarness({
			docContent: "a\nB edited\nc\n",
			docIsModified: true,
			adapter: {
				updateIndexContent: mock(async (_file: string, content: string) => {
					indexCalls.push(content);
					if (indexCalls.length === 1) throw new Error("index locked");
				})
			}
		});
		const change = createTestChange({
			originalContent: "a\nb\nc\n",
			modifiedContent: "a\nB\nc\n",
			stagedContent: "a\nb\nc\n"
		});
		const [hunk] = snapshotHunks("a\nb\nc\n", "a\nB\nc\n");

		await applyHunkAction(ctx, change, hunk, "stage");

		expect(indexCalls).toEqual(["a\nB edited\nc\n", "a\nb\nc\n"]);
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toContain("index locked");
	});

	it("restores prior index content and reports when an unstage write fails", async () => {
		const indexCalls: string[] = [];
		const { ctx, alerts } = createDirtyHarness({
			docContent: "a\nB\nc\npane edit\n",
			docIsModified: true,
			adapter: {
				updateIndexContent: mock(async (_file: string, content: string) => {
					indexCalls.push(content);
					if (indexCalls.length === 1) throw new Error("index locked");
				})
			}
		});
		const change = createTestChange({
			staged: true,
			originalContent: "a\nb\nc\n",
			modifiedContent: "a\nB\nc\n",
			stagedContent: "a\nB\nc\n"
		});
		const [hunk] = snapshotHunks("a\nb\nc\n", "a\nB\nc\n");

		await applyHunkAction(ctx, change, hunk, "unstage");

		expect(indexCalls).toEqual(["a\nb\nc\n", "a\nB\nc\n"]);
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toContain("index locked");
	});

	it("leaves the missing-content fallback untouched when a Document is bound", async () => {
		const { ctx, alerts, indexWrites } = createDirtyHarness({
			docContent: "whatever\n",
			docIsModified: true,
			adapter: {
				updateIndexContent: mock(async () => {}),
				updateFileContent: mock(async () => {})
			}
		});
		const change = createTestChange({
			originalContent: undefined,
			modifiedContent: undefined,
			stagedContent: undefined
		});

		await applyHunkAction(ctx, change, { fromA: 0, toA: 1, fromB: 0, toB: 1 }, "stage");

		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toContain("missing diff content for test.txt");
		expect(indexWrites).toHaveLength(0);
	});
});

describe("dirty-hunk range helpers (#273)", () => {
	const root: FileOrigin = { scheme: "file", path: "/repo", name: "repo" };

	it("builds the workspace origin the same way the diff binding does", () => {
		expect(documentOriginForFilepath(root, "src/a.ts")).toEqual({
			scheme: "file",
			path: "/repo/src/a.ts",
			name: "a.ts"
		});
	});

	it("finds the bound Document by URI and misses without a root or documents", () => {
		const doc: FakeDoc = {
			origin: documentOriginForFilepath(root, "src/a.ts"),
			content: "x",
			isModified: false
		};
		expect(findDirtyDocument([doc], root, "src/a.ts")).toBe(doc);
		expect(findDirtyDocument([doc], root, "src/other.ts")).toBeUndefined();
		expect(findDirtyDocument([doc], null, "src/a.ts")).toBeUndefined();
		expect(findDirtyDocument(undefined, root, "src/a.ts")).toBeUndefined();
	});

	it("clamps positions into live text", () => {
		expect(clampHunkPos(-3, 10)).toBe(0);
		expect(clampHunkPos(4, 10)).toBe(4);
		expect(clampHunkPos(10, 10)).toBe(10);
		expect(clampHunkPos(999, 10)).toBe(10);
	});

	it("maps a snapshot range past an insertion above the hunk", () => {
		const snapshot = Text.of("l1\nl2\nl3\n".split(/\r?\n/));
		const current = Text.of("X\nY\nl1\nl2\nl3\n".split(/\r?\n/));
		// Snapshot hunk covering "l2\n" (offsets 3..6); the insertion shifts it by 4.
		const mapped = mapStaleHunkRange({ fromA: 3, toA: 6, fromB: 3, toB: 6 }, snapshot, current);
		expect(mapped.fromA).toBe(3);
		expect(mapped.toA).toBe(6);
		expect(current.sliceString(mapped.fromB, mapped.toB)).toBe("l2\n");
	});

	it("clamps a mapped end that runs past shortened live text", () => {
		const snapshot = Text.of("a\nb\nc\n".split(/\r?\n/));
		const current = Text.of("a\nb".split(/\r?\n/));
		const mapped = mapStaleHunkRange(
			{ fromA: 4, toA: 6, fromB: 4, toB: 6 },
			snapshot,
			current
		);
		expect(mapped.toB).toBeLessThanOrEqual(current.length);
		expect(mapped.fromB).toBeLessThanOrEqual(mapped.toB);
	});

	it("detects live coverage for ranges, points, and stale gaps", () => {
		const origText = Text.of("a\nb\nc\n".split(/\r?\n/));
		const modText = Text.of("a\nB\nc\n".split(/\r?\n/));
		const chunks = Chunk.build(origText, modText);
		expect(chunks).toHaveLength(1);
		const [chunk] = chunks;
		expect(liveHunkCoversRange(chunks, chunk.fromB, chunk.toB)).toBe(true);
		// Insertion point inside the live chunk still counts as covered.
		expect(liveHunkCoversRange(chunks, chunk.fromB, chunk.fromB)).toBe(true);
		// A range in unchanged text matches nothing.
		expect(liveHunkCoversRange(chunks, 0, 0)).toBe(false);
		expect(liveHunkCoversRange([], chunk.fromB, chunk.toB)).toBe(false);
	});
});
