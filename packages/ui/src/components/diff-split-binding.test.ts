import "../../../../tests/contract/rune-setup";
import { describe, it, expect } from "bun:test";
import { DocumentSession } from "../../../core/src/document.svelte";
import type { FileOrigin } from "../../../core/src/storage";
import { createMockStorage } from "../../../../tests/mock-storage";
import {
	originForDiffFilepath,
	findBoundDocument,
	isSplitWorkingCopyEditable,
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

describe("diff split Working-copy binding (#269)", () => {
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
	});
});
