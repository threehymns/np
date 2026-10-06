import "../../../../tests/contract/rune-setup";
import { describe, it, expect } from "bun:test";
import { DocumentSession, type FileOrigin } from "@np/core";
import { diffOriginForFilepath, findBoundDocument as coreFindBoundDocument } from "@np/core";
import { createMockStorage } from "../../../../tests/mock-storage";
import {
	originForDiffFilepath,
	findBoundDocument,
	isSplitWorkingCopyEditable,
	isOriginalOnly,
	computeLiveHunks,
	createLiveHunkMemo,
	hasGitChangeChanged,
	resolveSplitRightContent,
	isDiffHeaderDirty,
	ensureSplitDocument
} from "./diff-split-binding";

const root: FileOrigin = { scheme: "file", path: "/projects/np", name: "np" };

function makeDoc(content: string, filepath: string): DocumentSession {
	const storage = createMockStorage();
	return new DocumentSession(storage, content, originForDiffFilepath(root, filepath));
}

function makeChange(filepath: string, status: "M" | "A" | "D" | "U" = "M") {
	return {
		filepath,
		status,
		additions: 1,
		deletions: 0,
		diff: "",
		staged: false
	};
}

function makeCombinedChange(filepath: string) {
	return {
		...makeChange(filepath, "M"),
		staged: false,
		combined: true
	};
}

describe("diff split Working-copy binding (#269)", () => {
	describe("shared lookup identity (review de-dup)", () => {
		it("resolves through the same core lookup as Hunk Actions", () => {
			expect(findBoundDocument).toBe(coreFindBoundDocument);
			expect(originForDiffFilepath).toBe(diffOriginForFilepath);
		});
	});
	describe("originForDiffFilepath", () => {
		it("builds the workspace origin the same way openFileInRegularTab does", () => {
			expect(originForDiffFilepath(root, "src/a.ts")).toEqual({
				scheme: "file",
				path: "/projects/np/src/a.ts",
				name: "a.ts"
			});
		});

		it("uses the basename for nested paths", () => {
			expect(originForDiffFilepath(root, "docs/nested/b.md").name).toBe("b.md");
		});
	});

	describe("findBoundDocument", () => {
		it("returns undefined when no document is open for the filepath", () => {
			expect(findBoundDocument([], new Map(), root, "src/a.ts")).toBeUndefined();
		});

		it("reuses the already-open tab Document by URI (single source of truth)", () => {
			const doc = makeDoc("tab content", "src/a.ts");
			expect(findBoundDocument([doc], new Map(), root, "src/a.ts")).toBe(doc);
		});

		it("prefers the explicitly bound id after a Save As origin change", () => {
			const doc = makeDoc("content", "src/a.ts");
			// Save As moved the Document to a new origin; the stale filepath
			// URI no longer matches, but the id binding keeps the pane bound.
			doc.origin = { scheme: "file", path: "/projects/np/renamed.ts", name: "renamed.ts" };
			const ids = new Map([["src/a.ts", doc.id]]);
			expect(findBoundDocument([doc], ids, root, "src/a.ts")).toBe(doc);
		});

		it("prunes stale ids and falls back to a URI match", () => {
			const doc = makeDoc("content", "src/a.ts");
			const ids = new Map([["src/a.ts", "gone-id"]]);
			expect(findBoundDocument([doc], ids, root, "src/a.ts")).toBe(doc);
			expect(ids.has("src/a.ts")).toBe(false);
		});

		it("returns undefined without a workspace root", () => {
			const doc = makeDoc("content", "src/a.ts");
			expect(findBoundDocument([doc], new Map(), null, "src/a.ts")).toBeUndefined();
		});
	});

	describe("isSplitWorkingCopyEditable", () => {
		it("is editable when a shared Document is bound", () => {
			for (const status of ["M", "A", "U"] as const) {
				expect(isSplitWorkingCopyEditable(status, makeDoc("x", "f.ts"))).toBe(true);
			}
		});

		it("is read-only without a bound Document", () => {
			expect(isSplitWorkingCopyEditable("M", undefined)).toBe(false);
		});

		it("keeps deleted files read-only even when a Document exists", () => {
			expect(isSplitWorkingCopyEditable("D", makeDoc("x", "f.ts"))).toBe(false);
		});
	});

	describe("resolveSplitRightContent (Document -> pane)", () => {
		it("reads live Document content so tab keystrokes appear in the pane", () => {
			const doc = makeDoc("snapshot", "src/a.ts");
			doc.content = "tab keystrokes";
			expect(resolveSplitRightContent(doc, "snapshot")).toBe("tab keystrokes");
		});

		it("falls back to the git snapshot string when unbound", () => {
			expect(resolveSplitRightContent(undefined, "snapshot")).toBe("snapshot");
		});

		it("is empty when neither Document nor snapshot exists", () => {
			expect(resolveSplitRightContent(undefined, undefined)).toBe("");
		});
	});

	describe("isDiffHeaderDirty (agrees with the tab header)", () => {
		it("is clean for an unmodified Document", () => {
			expect(isDiffHeaderDirty(makeDoc("same", "src/a.ts"))).toBe(false);
		});

		it("is dirty after an in-memory edit, matching Document.isModified", () => {
			const doc = makeDoc("saved", "src/a.ts");
			doc.content = "edited";
			expect(doc.isModified).toBe(true);
			expect(isDiffHeaderDirty(doc)).toBe(doc.isModified);
		});

		it("is clean when unbound", () => {
			expect(isDiffHeaderDirty(undefined)).toBe(false);
		});
	});

	describe("ensureSplitDocument", () => {
		function makeScope(documents: DocumentSession[] = []) {
			const storage = createMockStorage();
			return {
				scope: {
					documents,
					storage,
					rootOrigin: root,
					coversOrigin: () => true
				},
				storage
			};
		}

		it("creates a clean Document from the snapshot without opening a tab", () => {
			const { scope } = makeScope();
			const ids = new Map<string, string>();
			const doc = ensureSplitDocument(scope, ids, makeChange("src/a.ts"), "working\ntree\n");
			expect(doc).toBeDefined();
			expect(doc!.content).toBe("working\ntree\n");
			expect(doc!.isModified).toBe(false);
			expect(doc!.origin).toEqual(originForDiffFilepath(root, "src/a.ts"));
			expect(ids.get("src/a.ts")).toBe(doc!.id);
			expect(scope.documents).toContain(doc!);
		});

		it("reuses the open Document without overwriting unsaved tab edits", () => {
			const open = makeDoc("saved", "src/a.ts");
			open.content = "unsaved tab edits";
			const { scope } = makeScope([open]);
			const ids = new Map<string, string>();
			const doc = ensureSplitDocument(scope, ids, makeChange("src/a.ts"), "stale snapshot");
			expect(doc).toBe(open);
			expect(doc!.content).toBe("unsaved tab edits");
			expect(scope.documents.length).toBe(1);
		});

		it("creates nothing for deleted files", () => {
			const { scope } = makeScope();
			expect(ensureSplitDocument(scope, new Map(), makeChange("src/gone.ts", "D"), "")).toBeUndefined();
			expect(scope.documents.length).toBe(0);
		});

		it("waits for the diff to load instead of binding an empty placeholder", () => {
			const { scope } = makeScope();
			expect(ensureSplitDocument(scope, new Map(), makeChange("src/a.ts"), undefined)).toBeUndefined();
			expect(scope.documents.length).toBe(0);
		});

		it("creates nothing without a workspace root", () => {
			const storage = createMockStorage();
			const scope = { documents: [] as DocumentSession[], storage, rootOrigin: null, coversOrigin: () => false };
			expect(ensureSplitDocument(scope, new Map(), makeChange("src/a.ts"), "x")).toBeUndefined();
		});

		it("binds untracked files from working-tree content (editable)", () => {
			const { scope } = makeScope();
			const ids = new Map<string, string>();
			const doc = ensureSplitDocument(scope, ids, makeChange("new.txt", "U"), "draft content\n");
			expect(doc).toBeDefined();
			expect(doc!.content).toBe("draft content\n");
			expect(isSplitWorkingCopyEditable("U", doc)).toBe(true);
		});

		it("binds combined staged-plus-unstaged files without touching the index", () => {
			const { scope } = makeScope();
			const ids = new Map<string, string>();
			const doc = ensureSplitDocument(scope, ids, makeCombinedChange("src/a.ts"), "working tree\n");
			expect(doc).toBeDefined();
			// Binding only creates the working-tree Document; the module owns
			// no adapter and performs no index write, so typing through it can
			// only ever land in working-tree content.
			expect(isSplitWorkingCopyEditable("M", doc)).toBe(true);
			expect(ids.get("src/a.ts")).toBe(doc!.id);
		});

		it("keeps unsaved pane edits when a refresh delivers a new snapshot", () => {
			const { scope } = makeScope();
			const ids = new Map<string, string>();
			const doc = ensureSplitDocument(scope, ids, makeChange("src/a.ts"), "base working tree\n")!;
			doc.content = "unsaved pane edits\n";
			// A refresh cleared the diff cache and re-fetched: same filepath,
			// new snapshot object. The bound Document (and its edits) win.
			const rebound = ensureSplitDocument(scope, ids, makeChange("src/a.ts"), "base working tree\n");
			expect(rebound).toBe(doc);
			expect(rebound!.content).toBe("unsaved pane edits\n");
			expect(resolveSplitRightContent(rebound, "base working tree\n")).toBe("unsaved pane edits\n");
		});

		it("reloads a clean bound Document when repository content changes", () => {
			const { scope } = makeScope();
			const ids = new Map<string, string>();
			const doc = ensureSplitDocument(scope, ids, makeChange("src/a.ts"), "base working tree\n")!;
			expect(doc.isModified).toBe(false);
			const rebound = ensureSplitDocument(scope, ids, makeChange("src/a.ts"), "new working tree\n");
			expect(rebound).toBe(doc);
			expect(rebound!.content).toBe("new working tree\n");
			expect(rebound!.isModified).toBe(false);
		});

		it("preserves dirty edits when repository content changes", () => {
			const { scope } = makeScope();
			const ids = new Map<string, string>();
			const doc = ensureSplitDocument(scope, ids, makeChange("src/a.ts"), "base working tree\n")!;
			doc.content = "unsaved pane edits\n";
			expect(doc.isModified).toBe(true);
			const rebound = ensureSplitDocument(scope, ids, makeChange("src/a.ts"), "new working tree\n");
			expect(rebound).toBe(doc);
			expect(rebound!.content).toBe("unsaved pane edits\n");
		});
	});

	describe("isOriginalOnly (deleted files, #272)", () => {
		it("renders the Original pane only for deleted files", () => {
			expect(isOriginalOnly("D")).toBe(true);
		});

		it("keeps the working-copy surface for every other status", () => {
			for (const status of ["M", "A", "U"] as const) {
				expect(isOriginalOnly(status)).toBe(false);
			}
		});
	});

	describe("computeLiveHunks (refresh-safe display hunks, #272)", () => {
		it("reports no hunks for identical content", () => {
			expect(computeLiveHunks("a\nb\n", "a\nb\n")).toHaveLength(0);
		});

		it("reports no hunks for the empty-baseline fallback (empty vs empty)", () => {
			expect(computeLiveHunks("", "")).toHaveLength(0);
		});

		it("derives hunks from live Document content, not the stored snapshot", () => {
			const original = "line1\nline2\nline3\n";
			const snapshot = "line1\nline2\nline3\n";
			const edited = "line1\nline2 edited\nline3\n";
			// Snapshot is clean: no hunks.
			expect(computeLiveHunks(original, snapshot)).toHaveLength(0);
			// The same base against unsaved pane edits: one hunk, positioned
			// in the live text.
			const live = computeLiveHunks(original, edited);
			expect(live).toHaveLength(1);
			expect(live[0].fromB).toBeLessThan(live[0].toB);
		});

		it("shifts hunks below an edit above them", () => {
			const original = "a\nb\nc\nd\ne\nf\ng\nh\n";
			const before = computeLiveHunks(original, original.replace("g\n", "G edited\n"));
			// Insert two lines at the top: the hunk around the g edit moves down.
			const after = computeLiveHunks(original, "x\ny\n" + original.replace("g\n", "G edited\n"));
			expect(before).toHaveLength(1);
			const lastAfter = after[after.length - 1];
			expect(lastAfter.fromB).toBeGreaterThan(before[0].fromB);
		});
	});

	describe("hasGitChangeChanged (value compare; fresh spread per render)", () => {
		function change(overrides = {}) {
			return {
				filepath: "src/a.ts",
				status: "M",
				additions: 1,
				deletions: 0,
				diff: "@@ -1 +1 @@",
				staged: false,
				combined: undefined,
				originalContent: "a\n",
				modifiedContent: "b\n",
				stagedContent: undefined,
				...overrides
			} as Parameters<typeof hasGitChangeChanged>[0];
		}

		it("returns false for distinct objects with identical values (spread copy)", () => {
			const prev = change();
			const next = { ...prev };
			expect(next).not.toBe(prev as object);
			expect(hasGitChangeChanged(prev, next)).toBe(false);
		});

		it("returns true when rendered content actually changes", () => {
			const prev = change();
			expect(hasGitChangeChanged(prev, change({ modifiedContent: "c\n" }))).toBe(true);
			expect(hasGitChangeChanged(prev, change({ originalContent: "z\n" }))).toBe(true);
			expect(hasGitChangeChanged(prev, change({ stagedContent: "s\n" }))).toBe(true);
			expect(hasGitChangeChanged(prev, change({ diff: "@@ -2 +2 @@" }))).toBe(true);
		});

		it("returns true when staging scope changes", () => {
			const prev = change();
			expect(hasGitChangeChanged(prev, change({ staged: true }))).toBe(true);
			expect(hasGitChangeChanged(prev, change({ combined: true }))).toBe(true);
			expect(hasGitChangeChanged(prev, change({ status: "A" }))).toBe(true);
		});
	});

	describe("createLiveHunkMemo (per-file hunk cache; typing lag)", () => {
		it("reuses cached hunks when inputs are unchanged", () => {
			const memo = createLiveHunkMemo();
			const first = memo.getOrCompute("a.ts", "a\nb\n", "a\nB\n");
			const second = memo.getOrCompute("a.ts", "a\nb\n", "a\nB\n");
			expect(second).toBe(first);
		});

		it("recomputes only the file whose content changed", () => {
			const memo = createLiveHunkMemo();
			const aBefore = memo.getOrCompute("a.ts", "a\n", "A\n");
			const bBefore = memo.getOrCompute("b.ts", "x\n", "X\n");
			// Keystroke in a.ts only: b.ts must return the identical chunk array.
			const bAfter = memo.getOrCompute("b.ts", "x\n", "X\n");
			const aAfter = memo.getOrCompute("a.ts", "a\n", "A edited\n");
			expect(bAfter).toBe(bBefore);
			expect(aAfter).not.toBe(aBefore);
		});

		it("prunes files that left the view", () => {
			const memo = createLiveHunkMemo();
			memo.getOrCompute("a.ts", "a\n", "A\n");
			memo.getOrCompute("gone.ts", "g\n", "G\n");
			expect(memo.size()).toBe(2);
			memo.prune(new Set(["a.ts"]));
			expect(memo.size()).toBe(1);
		});
	});
});
