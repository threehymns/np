import "../../../../tests/contract/rune-setup";
import { describe, it, expect, mock, beforeAll } from "bun:test";
import { EditorState } from "@codemirror/state";
import { history, historyField, undo, undoDepth } from "@codemirror/commands";
import type { FileOrigin } from "../storage";
import { toURI } from "../storage";
import type { SearchMatch, FileSearchResult } from "./types";
import {
	computeLineStarts,
	FileExcerptMap,
	buildExcerptMapForContent,
	isExcerptMapStale,
	buildReplaceAllEditsForFile,
	applyEditsToDocumentSession,
	applyEditToFile,
	applyReplaceAll,
	undoReplaceAll
} from "./excerpt";
import { DocumentSession } from "../document.svelte";

let WorkspaceClass: typeof import("../workspace.svelte").Workspace;

beforeAll(async () => {
	mock.module("svelte/reactivity", () => ({
		SvelteMap: Map,
		SvelteSet: Set
	}));

	const wsMod = await import("../workspace.svelte");
	WorkspaceClass = wsMod.Workspace;
});

const rootOrigin: FileOrigin = { scheme: "file", path: "/test-project", name: "test-project" };

function createMockStorage(files: Record<string, string> = {}) {
	return {
		readFile: mock(async (origin: FileOrigin) => {
			const uri = toURI(origin);
			if (uri in files) return files[uri];
			const directPath = origin.path;
			if (directPath in files) return files[directPath];
			throw { name: "NotFoundError" };
		}),
		readDirectory: mock(async () => []),
		pickFile: mock(async () => null),
		pickDirectory: mock(async () => null),
		saveFile: mock(async (content: string, origin?: FileOrigin) => {
			// A save with an origin writes that file in place.
			if (!origin) return null;
			const uri = toURI(origin);
			const key = uri in files ? uri : origin.path in files ? origin.path : uri;
			files[key] = content;
			return origin;
		}),
		createFile: mock(async () => {}),
		createDirectory: mock(async () => {}),
		deleteEntry: mock(async () => {}),
		renameEntry: mock(async (o: FileOrigin) => o)
	};
}

function createTestWorkspace(storage: any) {
	const ws = new WorkspaceClass(
		storage,
		() => ({} as any),
		{
			saveOpenFiles: mock(async () => {}),
			loadOpenFiles: mock(async () => []),
			saveExpandedPaths: mock(async () => {}),
			loadExpandedPaths: mock(async () => [])
		} as any
	);
	return ws;
}

describe("Excerpt-to-file offset mapping (Issue #336)", () => {
	it("maps excerpt coordinates to file coordinates for single match with context", () => {
		const fileContent = "line 0\nline 1\nconst target = 'findme';\nline 3\nline 4";
		const match: SearchMatch = {
			line: 3,
			column: 17,
			offset: 30, // 'findme'
			matchLength: 6,
			lineText: "const target = 'findme';",
			contextBefore: [{ line: 2, text: "line 1" }],
			contextAfter: [{ line: 4, text: "line 3" }]
		};

		const map = new FileExcerptMap("src/index.ts", { scheme: "file", path: "/test-project/src/index.ts", name: "index.ts" }, fileContent, [match], { contextLines: 1 });

		// Should have 1 merged excerpt segment covering lines 2..4
		expect(map.excerpts.length).toBe(1);
		const segment = map.excerpts[0];
		expect(segment.startLine).toBe(2);
		expect(segment.endLine).toBe(4);

		// Buffer text should match lines 2..4
		const expectedText = "line 1\nconst target = 'findme';\nline 3\n";
		expect(map.bufferText).toBe(expectedText);

		// Offset of 'findme' in file is 30.
		// Start of segment in file is start of line 2 (offset 7).
		// So offset of 'findme' in buffer should be 30 - 7 = 23.
		const excerptOffset = map.fileOffsetToExcerptOffset(30);
		expect(excerptOffset).toBe(23);
		expect(map.bufferText.slice(excerptOffset!, excerptOffset! + 6)).toBe("findme");

		// Reverse mapping
		expect(map.excerptOffsetToFileOffset(23)).toBe(30);

		// Map edit: user changes 'findme' to 'replaced'
		const mappedEdit = map.mapExcerptEditToFileEdit({ from: 23, to: 29, insert: "replaced" });
		expect(mappedEdit).toEqual({ from: 30, to: 36, insert: "replaced" });
	});

	it("merges adjacent matches into a continuous excerpt and maps coordinates correctly", () => {
		// "foofoo" has adjacent matches at 0..3 and 3..6
		const fileContent = "foofoo is here\nsecond line";
		const match1: SearchMatch = {
			line: 1,
			column: 1,
			offset: 0,
			matchLength: 3,
			lineText: "foofoo is here",
			contextBefore: [],
			contextAfter: [{ line: 2, text: "second line" }]
		};
		const match2: SearchMatch = {
			line: 1,
			column: 4,
			offset: 3,
			matchLength: 3,
			lineText: "foofoo is here",
			contextBefore: [],
			contextAfter: [{ line: 2, text: "second line" }]
		};

		const map = new FileExcerptMap("test.txt", { scheme: "file", path: "/test.txt", name: "test.txt" }, fileContent, [match1, match2]);

		// Both matches merged into 1 excerpt
		expect(map.excerpts.length).toBe(1);
		expect(map.excerpts[0].matches.length).toBe(2);

		// Coordinates
		expect(map.excerptOffsetToFileOffset(0)).toBe(0);
		expect(map.excerptOffsetToFileOffset(3)).toBe(3);
		expect(map.excerptOffsetToFileOffset(6)).toBe(6);

		expect(map.fileOffsetToExcerptOffset(0)).toBe(0);
		expect(map.fileOffsetToExcerptOffset(3)).toBe(3);
		expect(map.fileOffsetToExcerptOffset(6)).toBe(6);

		// Replace-all edits for adjacent matches
		const edits = buildReplaceAllEditsForFile([match1, match2], "bar");
		expect(edits).toEqual([
			{ from: 0, to: 3, insert: "bar" },
			{ from: 3, to: 6, insert: "bar" }
		]);
	});

	it("merges overlapping matches into a continuous excerpt without duplicate ranges", () => {
		const fileContent = "aaaa is here";
		const match1: SearchMatch = {
			line: 1,
			column: 1,
			offset: 0,
			matchLength: 2,
			lineText: "aaaa is here",
			contextBefore: [],
			contextAfter: []
		};
		const match2: SearchMatch = {
			line: 1,
			column: 2,
			offset: 1,
			matchLength: 2,
			lineText: "aaaa is here",
			contextBefore: [],
			contextAfter: []
		};

		const map = new FileExcerptMap("test.txt", { scheme: "file", path: "/test.txt", name: "test.txt" }, fileContent, [match1, match2]);
		expect(map.excerpts.length).toBe(1);

		// When building replace-all edits, overlapping match2 is skipped so ranges do not overlap
		const edits = buildReplaceAllEditsForFile([match1, match2], "xyz");
		expect(edits).toEqual([
			{ from: 0, to: 2, insert: "xyz" }
		]);
	});

	it("merges matches on adjacent lines with overlapping context into a single excerpt", () => {
		const fileContent = "line 1\nmatch A\nmatch B\nline 4";
		const matchA: SearchMatch = {
			line: 2,
			column: 1,
			offset: 7,
			matchLength: 7,
			lineText: "match A",
			contextBefore: [{ line: 1, text: "line 1" }],
			contextAfter: [{ line: 3, text: "match B" }]
		};
		const matchB: SearchMatch = {
			line: 3,
			column: 1,
			offset: 15,
			matchLength: 7,
			lineText: "match B",
			contextBefore: [{ line: 2, text: "match A" }],
			contextAfter: [{ line: 4, text: "line 4" }]
		};

		const map = new FileExcerptMap("test.txt", { scheme: "file", path: "/test.txt", name: "test.txt" }, fileContent, [matchA, matchB]);

		// Context overlaps: should form 1 continuous segment covering lines 1..4
		expect(map.excerpts.length).toBe(1);
		expect(map.excerpts[0].startLine).toBe(1);
		expect(map.excerpts[0].endLine).toBe(4);
		expect(map.bufferText).toBe(fileContent);

		// Edits in buffer map 1:1
		const editA = map.mapExcerptEditToFileEdit({ from: 7, to: 14, insert: "REPLACED_A" });
		expect(editA).toEqual({ from: 7, to: 14, insert: "REPLACED_A" });

		const editB = map.mapExcerptEditToFileEdit({ from: 15, to: 22, insert: "REPLACED_B" });
		expect(editB).toEqual({ from: 15, to: 22, insert: "REPLACED_B" });
	});

	it("handles non-overlapping distant excerpts with separator and translates offsets correctly", () => {
		const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
		lines[4] = "match near top";
		lines[54] = "match near bottom";
		const fileContent = lines.join("\n");

		const match1: SearchMatch = {
			line: 5,
			column: 1,
			offset: fileContent.indexOf("match near top"),
			matchLength: 14,
			lineText: "match near top",
			contextBefore: [{ line: 4, text: lines[3] }],
			contextAfter: [{ line: 6, text: lines[5] }]
		};

		const match2: SearchMatch = {
			line: 55,
			column: 1,
			offset: fileContent.indexOf("match near bottom"),
			matchLength: 17,
			lineText: "match near bottom",
			contextBefore: [{ line: 54, text: lines[53] }],
			contextAfter: [{ line: 56, text: lines[55] }]
		};

		const map = new FileExcerptMap("test.txt", { scheme: "file", path: "/test.txt", name: "test.txt" }, fileContent, [match1, match2], { separator: "\n---\n" });

		// Should have 2 separate excerpts
		expect(map.excerpts.length).toBe(2);

		// Excerpt 1 mapping
		const excerpt1 = map.excerpts[0];
		expect(excerpt1.startLine).toBe(4);
		expect(excerpt1.endLine).toBe(6);
		const match1ExcerptOffset = map.fileOffsetToExcerptOffset(match1.offset);
		expect(match1ExcerptOffset).not.toBeNull();
		expect(map.excerptOffsetToFileOffset(match1ExcerptOffset!)).toBe(match1.offset);

		// Excerpt 2 mapping
		const excerpt2 = map.excerpts[1];
		expect(excerpt2.startLine).toBe(54);
		expect(excerpt2.endLine).toBe(56);
		const match2ExcerptOffset = map.fileOffsetToExcerptOffset(match2.offset);
		expect(match2ExcerptOffset).not.toBeNull();
		expect(map.excerptOffsetToFileOffset(match2ExcerptOffset!)).toBe(match2.offset);

		// Separator offset should return null
		const separatorOffset = excerpt1.bufferEnd + 1;
		expect(map.excerptOffsetToFileOffset(separatorOffset)).toBeNull();
	});

	it("editing text in results buffer updates the corresponding source file at the right offset", () => {
		const fileContent = "function greet() {\n  const message = 'hello world';\n  return message;\n}";
		const storage = createMockStorage({ "/test-project/greet.ts": fileContent });
		const workspace = createTestWorkspace(storage);
		const origin: FileOrigin = { scheme: "file", path: "/test-project/greet.ts", name: "greet.ts" };

		const doc = new DocumentSession(storage, fileContent, origin);
		doc.markPermissionGranted();
		workspace.documents.push(doc);

		const match: SearchMatch = {
			line: 2,
			column: 20,
			offset: 38, // 'hello' in 'hello world'
			matchLength: 5,
			lineText: "  const message = 'hello world';",
			contextBefore: [{ line: 1, text: "function greet() {" }],
			contextAfter: [{ line: 3, text: "  return message;" }]
		};

		const map = new FileExcerptMap("greet.ts", origin, fileContent, [match], { contextLines: 1 });

		// Suppose user types in the results buffer: changes 'hello' to 'howdy'
		// In excerpt buffer: find offset of 'hello'
		const excerptStart = map.fileOffsetToExcerptOffset(38)!;
		expect(map.bufferText.slice(excerptStart, excerptStart + 5)).toBe("hello");

		// User edits excerpt: { from: excerptStart, to: excerptStart + 5, insert: "howdy" }
		const fileEdit = map.mapExcerptEditToFileEdit({
			from: excerptStart,
			to: excerptStart + 5,
			insert: "howdy"
		});

		expect(fileEdit).not.toBeNull();
		expect(fileEdit).toEqual({ from: 38, to: 43, insert: "howdy" });

		// Apply edit to source file DocumentSession
		applyEditsToDocumentSession(doc, [fileEdit!], workspace);

		expect(doc.content).toBe("function greet() {\n  const message = 'howdy world';\n  return message;\n}");
		expect(doc.isModified).toBe(true);
	});

	it("handles multiple matches on the same line correctly", () => {
		const fileContent = "const sum = add(foo, foo);";
		const match1: SearchMatch = {
			line: 1,
			column: 17,
			offset: 16,
			matchLength: 3,
			lineText: fileContent,
			contextBefore: [],
			contextAfter: []
		};
		const match2: SearchMatch = {
			line: 1,
			column: 22,
			offset: 21,
			matchLength: 3,
			lineText: fileContent,
			contextBefore: [],
			contextAfter: []
		};

		const map = new FileExcerptMap("calc.ts", { scheme: "file", path: "/calc.ts", name: "calc.ts" }, fileContent, [match1, match2]);
		expect(map.excerpts.length).toBe(1);

		const edits = buildReplaceAllEditsForFile([match1, match2], "bar");
		expect(edits).toEqual([
			{ from: 16, to: 19, insert: "bar" },
			{ from: 21, to: 24, insert: "bar" }
		]);

		const storage = createMockStorage({ "/calc.ts": fileContent });
		const workspace = createTestWorkspace(storage);
		const origin: FileOrigin = { scheme: "file", path: "/calc.ts", name: "calc.ts" };
		const doc = new DocumentSession(storage, fileContent, origin);
		doc.markPermissionGranted();
		workspace.documents.push(doc);

		applyEditsToDocumentSession(doc, edits, workspace);
		expect(doc.content).toBe("const sum = add(bar, bar);");
	});
});

describe("Replace-all across results with per-file undo (Issue #336)", () => {
	it("replaces all occurrences across multiple files in one action", async () => {
		const files: Record<string, string> = {
			"/test-project/fileA.ts": "const x = 'target';\nconst y = 'target';",
			"/test-project/fileB.ts": "console.log('target');"
		};
		const storage = createMockStorage(files);
		const workspace = createTestWorkspace(storage);

		const originA: FileOrigin = { scheme: "file", path: "/test-project/fileA.ts", name: "fileA.ts" };
		const originB: FileOrigin = { scheme: "file", path: "/test-project/fileB.ts", name: "fileB.ts" };

		const fileResults: FileSearchResult[] = [
			{
				filepath: "fileA.ts",
				origin: originA,
				matches: [
					{ line: 1, column: 12, offset: 11, matchLength: 6, lineText: "const x = 'target';", contextBefore: [], contextAfter: [] },
					{ line: 2, column: 12, offset: 31, matchLength: 6, lineText: "const y = 'target';", contextBefore: [], contextAfter: [] }
				]
			},
			{
				filepath: "fileB.ts",
				origin: originB,
				matches: [
					{ line: 1, column: 14, offset: 13, matchLength: 6, lineText: "console.log('target');", contextBefore: [], contextAfter: [] }
				]
			}
		];

		const res = await applyReplaceAll({
			workspace,
			fileResults,
			replacement: "REPLACED"
		});

		expect(res.modifiedFiles).toEqual(["fileA.ts", "fileB.ts"]);
		expect(res.totalReplacements).toBe(3);

		// A file that is not open is written. It does not become a document
		// and it does not become a tab: a replace-all that opened a tab for
		// every file it changed buried the user's window in tabs.
		expect(workspace.documents.length).toBe(0);
		expect(workspace.tabs.length).toBe(0);
		expect(files["/test-project/fileA.ts"]).toBe("const x = 'REPLACED';\nconst y = 'REPLACED';");
		expect(files["/test-project/fileB.ts"]).toBe("console.log('REPLACED');");
	});

	it("replaces a match whose text differs from the query pattern", async () => {
		// A regular expression query matches text the pattern does not spell
		// out. Replace-all works from the match itself, so the replacement
		// lands on the matched text and not on the pattern.
		const files: Record<string, string> = {
			"/test-project/regex.ts": "const value = foo123bar;"
		};
		const storage = createMockStorage(files);
		const workspace = createTestWorkspace(storage);

		const origin: FileOrigin = {
			scheme: "file",
			path: "/test-project/regex.ts",
			name: "regex.ts"
		};
		const fileResults: FileSearchResult[] = [
			{
				filepath: "regex.ts",
				origin,
				matches: [
					{
						line: 1,
						column: 15,
						offset: 14,
						matchLength: 9,
						lineText: "const value = foo123bar;",
						contextBefore: [],
						contextAfter: []
					}
				]
			}
		];

		const res = await applyReplaceAll({
			workspace,
			fileResults,
			replacement: "X"
		});

		expect(res.totalReplacements).toBe(1);
		expect(files["/test-project/regex.ts"]).toBe("const value = X;");
	});

	it("skips a match whose text no longer sits at the recorded offset", async () => {
		// The document moved on since the search ran: the offset now points
		// at other text, so the match is skipped instead of overwriting it.
		const files: Record<string, string> = {
			"/test-project/moved.ts": "alpha XXXX gamma"
		};
		const storage = createMockStorage(files);
		const workspace = createTestWorkspace(storage);

		const origin: FileOrigin = {
			scheme: "file",
			path: "/test-project/moved.ts",
			name: "moved.ts"
		};
		const fileResults: FileSearchResult[] = [
			{
				filepath: "moved.ts",
				origin,
				matches: [
					{
						line: 1,
						column: 7,
						offset: 6,
						matchLength: 4,
						lineText: "alpha beta gamma",
						contextBefore: [],
						contextAfter: []
					}
				]
			}
		];

		const res = await applyReplaceAll({
			workspace,
			fileResults,
			replacement: "X"
		});

		expect(res.totalReplacements).toBe(0);
		expect(files["/test-project/moved.ts"]).toBe("alpha XXXX gamma");
	});

	it("applies an edit to a file that is not open, without opening it", async () => {
		// The results are the editor for the files they show, so an edit
		// made there changes the file itself. A replace operation never
		// opens a tab.
		const files: Record<string, string> = {
			"/test-project/closed.ts": "alpha target beta"
		};
		const storage = createMockStorage(files);
		const origin: FileOrigin = {
			scheme: "file",
			path: "/test-project/closed.ts",
			name: "closed.ts"
		};

		await applyEditToFile({
			storage: storage as any,
			origin,
			content: files["/test-project/closed.ts"],
			edit: { from: 6, to: 12, insert: "REPLACED" }
		});

		expect(files["/test-project/closed.ts"]).toBe("alpha REPLACED beta");
	});

	it("undo after replace-all puts every file the operation changed back", async () => {
		const files: Record<string, string> = {
			"/test-project/fileA.ts": "alpha target beta",
			"/test-project/fileB.ts": "gamma target delta"
		};
		const storage = createMockStorage(files);
		const workspace = createTestWorkspace(storage);

		const originA: FileOrigin = { scheme: "file", path: "/test-project/fileA.ts", name: "fileA.ts" };
		const originB: FileOrigin = { scheme: "file", path: "/test-project/fileB.ts", name: "fileB.ts" };

		const fileResults: FileSearchResult[] = [
			{
				filepath: "fileA.ts",
				origin: originA,
				matches: [{ line: 1, column: 7, offset: 6, matchLength: 6, lineText: "alpha target beta", contextBefore: [], contextAfter: [] }]
			},
			{
				filepath: "fileB.ts",
				origin: originB,
				matches: [{ line: 1, column: 7, offset: 6, matchLength: 6, lineText: "gamma target delta", contextBefore: [], contextAfter: [] }]
			}
		];

		const res = await applyReplaceAll({
			workspace,
			fileResults,
			replacement: "replacement"
		});

		expect(files["/test-project/fileA.ts"]).toBe("alpha replacement beta");
		expect(files["/test-project/fileB.ts"]).toBe("gamma replacement delta");

		// One undo puts every file the operation changed back.
		await undoReplaceAll(res.undo, workspace);

		expect(files["/test-project/fileA.ts"]).toBe("alpha target beta");
		expect(files["/test-project/fileB.ts"]).toBe("gamma target delta");
	});

	it("undo after replace-all puts an open document back the way it was", async () => {
		const storage = createMockStorage({ "/test-project/open.ts": "alpha target beta" });
		const workspace = createTestWorkspace(storage);

		const origin: FileOrigin = { scheme: "file", path: "/test-project/open.ts", name: "open.ts" };
		// The file is open, so the change belongs to its document.
		const doc = new DocumentSession(storage, "alpha target beta", origin);
		workspace.documents.push(doc);

		const fileResults: FileSearchResult[] = [
			{
				filepath: "open.ts",
				origin,
				matches: [{ line: 1, column: 7, offset: 6, matchLength: 6, lineText: "alpha target beta", contextBefore: [], contextAfter: [] }]
			}
		];

		const res = await applyReplaceAll({
			workspace,
			fileResults,
			replacement: "replacement"
		});

		expect(doc.content).toBe("alpha replacement beta");
		// An open document is not written behind the user's back.
		expect(storage.saveFile).not.toHaveBeenCalled();

		await undoReplaceAll(res.undo, workspace);

		expect(doc.content).toBe("alpha target beta");
	});

	it("files with unsaved changes accept replace edits without warnings", async () => {
		const storage = createMockStorage({
			"/test-project/dirty.ts": "original on disk"
		});
		const workspace = createTestWorkspace(storage);

		const origin: FileOrigin = { scheme: "file", path: "/test-project/dirty.ts", name: "dirty.ts" };
		// Pre-open file and make it dirty
		const doc = new DocumentSession(storage, "original on disk", origin);
		doc.content = "dirty unsaved target content";
		workspace.documents.push(doc);

		expect(doc.isModified).toBe(true);

		const fileResults: FileSearchResult[] = [
			{
				filepath: "dirty.ts",
				origin,
				matches: [{ line: 1, column: 15, offset: 14, matchLength: 6, lineText: "dirty unsaved target content", contextBefore: [], contextAfter: [] }]
			}
		];

		// Replace-all must succeed without warnings or modal popups
		await applyReplaceAll({
			workspace,
			fileResults,
			replacement: "REPLACED"
		});

		expect(doc.content).toBe("dirty unsaved REPLACED content");
		// File remains dirty
		expect(doc.isModified).toBe(true);

		// Per-file undo restores the dirty unsaved state
		const state = EditorState.fromJSON(doc.editorState, { extensions: [history()] }, { history: historyField });
		let undoneState: EditorState | null = null;
		undo({
			state,
			dispatch: (tr) => {
				undoneState = tr.state;
			}
		});
		expect(undoneState!.doc.toString()).toBe("dirty unsaved target content");
	});

	it("no modal or summary appears on replace-all", async () => {
		let modalTriggered = false;
		// Spy on global alerts/modals
		const originalAlert = (globalThis as any).alert;
		const originalConfirm = (globalThis as any).confirm;
		(globalThis as any).alert = () => { modalTriggered = true; };
		(globalThis as any).confirm = () => { modalTriggered = true; return true; };

		try {
			const storage = createMockStorage({ "/test-project/a.ts": "test" });
			const workspace = createTestWorkspace(storage);

			await applyReplaceAll({
				workspace,
				fileResults: [],
				replacement: "new"
			});

			expect(modalTriggered).toBe(false);
		} finally {
			(globalThis as any).alert = originalAlert;
			(globalThis as any).confirm = originalConfirm;
		}
	});

	it("rebuilds a stale editor state from the current document content before applying edits", async () => {
		const storage = createMockStorage({
			"/test-project/stale.ts": "aaa target bbb"
		});
		const workspace = createTestWorkspace(storage);

		const origin: FileOrigin = { scheme: "file", path: "/test-project/stale.ts", name: "stale.ts" };
		const doc = new DocumentSession(storage, "aaa target bbb", origin);
		workspace.documents.push(doc);

		// Simulate the main editor holding a live EditorState, then the document
		// content moving on without it (an external content update that only
		// touched doc.content). Edit offsets below are computed against the
		// current content, not the stale state.
		doc.editorState = EditorState.create({ doc: "aaa target bbb" });
		doc.content = "aaa TARGET bbb (edited elsewhere)";

		applyEditsToDocumentSession(doc, [{ from: 4, to: 10, insert: "REPLACED" }], workspace);

		expect(doc.content).toBe("aaa REPLACED bbb (edited elsewhere)");
	});
});

describe("Excerpt map stays in sync after direct edits (Issue #336)", () => {
	const twoExcerptOrigin: FileOrigin = {
		scheme: "file",
		path: "/test-project/src/two.ts",
		name: "two.ts"
	};

	function makeTwoExcerptMap() {
		const fileContent = [
			"const alpha = 'findme';",
			"filler one",
			"filler two",
			"filler three",
			"filler four",
			"filler five",
			"filler six",
			"const beta = 'findme';",
			"filler eight"
		].join("\n");
		const offset1 = fileContent.indexOf("findme");
		const offset2 = fileContent.indexOf("findme", offset1 + 1);
		const match1: SearchMatch = {
			line: 1,
			column: 16,
			offset: offset1,
			matchLength: 6,
			lineText: "const alpha = 'findme';",
			contextBefore: [],
			contextAfter: [{ line: 2, text: "filler one" }]
		};
		const match2: SearchMatch = {
			line: 8,
			column: 15,
			offset: offset2,
			matchLength: 6,
			lineText: "const beta = 'findme';",
			contextBefore: [{ line: 7, text: "filler six" }],
			contextAfter: [{ line: 9, text: "filler eight" }]
		};
		const map = new FileExcerptMap("src/two.ts", twoExcerptOrigin, fileContent, [match1, match2], {
			contextLines: 1
		});
		// The two matches are far enough apart to form separate excerpts.
		expect(map.excerpts.length).toBe(2);
		return { map, fileContent, match1, match2, offset1, offset2 };
	}

	it("maps later excerpts through shifted bounds after an insertion", () => {
		const { map, fileContent, match1, match2, offset1, offset2 } = makeTwoExcerptMap();

		// First edit: insert "XYZ" right before "findme" in the first excerpt.
		const buf1 = map.fileOffsetToExcerptOffset(offset1);
		expect(buf1).not.toBeNull();
		const excerptEdit1 = { from: buf1!, to: buf1!, insert: "XYZ" };
		const fileEdit1 = map.mapExcerptEditToFileEdit(excerptEdit1);
		expect(fileEdit1).toEqual({ from: offset1, to: offset1, insert: "XYZ" });
		map.applyExcerptEdit(excerptEdit1, fileEdit1);

		// The second match moved +3 in both buffer and file.
		const shiftedOffset2 = offset2 + 3;
		const buf2 = map.fileOffsetToExcerptOffset(shiftedOffset2);
		expect(buf2).not.toBeNull();
		expect(map.bufferText.slice(buf2!, buf2! + 6)).toBe("findme");
		const fileEdit2 = map.mapExcerptEditToFileEdit({
			from: buf2!,
			to: buf2! + 6,
			insert: "REPLACED"
		});
		expect(fileEdit2).toEqual({ from: shiftedOffset2, to: shiftedOffset2 + 6, insert: "REPLACED" });

		// A freshly built map over the post-edit file content agrees with the synced map.
		const newFileContent = fileContent.slice(0, offset1) + "XYZ" + fileContent.slice(offset1);
		const fresh = new FileExcerptMap(
			"src/two.ts",
			twoExcerptOrigin,
			newFileContent,
			[
				{ ...match1, offset: offset1 + 3, lineText: "const alpha = 'XYZfindme';" },
				{ ...match2, offset: offset2 + 3 }
			],
			{ contextLines: 1 }
		);
		expect(map.bufferText).toBe(fresh.bufferText);
		expect(map.excerpts[1].fileStart).toBe(fresh.excerpts[1].fileStart);
		expect(map.excerpts[1].bufferStart).toBe(fresh.excerpts[1].bufferStart);
	});

	it("shrinks later segment bounds after a deletion", () => {
		const { map, offset1, offset2 } = makeTwoExcerptMap();

		// Delete the first 3 chars of "findme" in the first excerpt.
		const buf1 = map.fileOffsetToExcerptOffset(offset1)!;
		const excerptEdit = { from: buf1, to: buf1 + 3, insert: "" };
		const fileEdit = map.mapExcerptEditToFileEdit(excerptEdit);
		expect(fileEdit).toEqual({ from: offset1, to: offset1 + 3, insert: "" });
		map.applyExcerptEdit(excerptEdit, fileEdit);

		// The second match moved -3; mapping a later edit must follow it.
		const shiftedOffset2 = offset2 - 3;
		const buf2 = map.fileOffsetToExcerptOffset(shiftedOffset2)!;
		expect(map.bufferText.slice(buf2, buf2 + 3)).toBe("fin");
		expect(map.mapExcerptEditToFileEdit({ from: buf2, to: buf2 + 3, insert: "XY" })).toEqual({
			from: shiftedOffset2,
			to: shiftedOffset2 + 3,
			insert: "XY"
		});
	});

	it("grows the owning segment on insertion at an excerpt boundary", () => {
		const { map } = makeTwoExcerptMap();
		const first = map.excerpts[0];

		// Insert two chars at the very end of the first excerpt.
		const atEnd = { from: first.bufferEnd, to: first.bufferEnd, insert: "ZZ" };
		const fileEditEnd = map.mapExcerptEditToFileEdit(atEnd);
		expect(fileEditEnd).not.toBeNull();
		map.applyExcerptEdit(atEnd, fileEditEnd);

		// The owning segment grew; the insertion is inside it.
		expect(map.excerpts[0].bufferEnd).toBe(first.bufferEnd);
		expect(map.bufferText.slice(first.bufferEnd - 2, first.bufferEnd)).toBe("ZZ");
		// The second excerpt shifted by the insertion length.
		expect(map.excerpts[1].bufferStart).toBeGreaterThan(first.bufferEnd);

		// Insert two chars at the very start of the second excerpt.
		const second = map.excerpts[1];
		const atStart = { from: second.bufferStart, to: second.bufferStart, insert: "YY" };
		const fileEditStart = map.mapExcerptEditToFileEdit(atStart);
		expect(fileEditStart).not.toBeNull();
		const secondEndBefore = second.bufferEnd;
		map.applyExcerptEdit(atStart, fileEditStart);

		expect(map.excerpts[1].bufferStart).toBe(second.bufferStart);
		expect(map.excerpts[1].bufferEnd).toBe(secondEndBefore + 2);
		expect(map.bufferText.slice(second.bufferStart, second.bufferStart + 2)).toBe("YY");
	});

	it("returns null for an edit spanning two segments", () => {
		const { map } = makeTwoExcerptMap();

		// Select-and-delete from inside the first excerpt to inside the second:
		// mapping the endpoints independently would delete the hidden file text
		// between the excerpts, so the whole edit is dropped.
		const edit = {
			from: map.excerpts[0].bufferEnd - 2,
			to: map.excerpts[1].bufferStart + 2,
			insert: ""
		};
		expect(map.mapExcerptEditToFileEdit(edit)).toBeNull();
	});

	it("returns null for an edit starting in a separator and ending in a segment", () => {
		const { map } = makeTwoExcerptMap();

		const edit = {
			from: map.excerpts[0].bufferEnd + 1,
			to: map.excerpts[1].bufferStart + 2,
			insert: "x"
		};
		expect(map.mapExcerptEditToFileEdit(edit)).toBeNull();
	});

	it("still maps edits fully inside one segment, including at its edges", () => {
		const { map, offset1 } = makeTwoExcerptMap();

		const seg = map.excerpts[0];
		// Insertion exactly at the segment end boundary stays in the segment.
		const fileEdit = map.mapExcerptEditToFileEdit({
			from: seg.bufferEnd,
			to: seg.bufferEnd,
			insert: "!"
		});
		expect(fileEdit).not.toBeNull();
		expect(fileEdit!.from).toBe(seg.fileEnd);
		expect(fileEdit!.to).toBe(seg.fileEnd);

		// A replacement covering the whole segment still maps.
		const whole = map.mapExcerptEditToFileEdit({
			from: seg.bufferStart,
			to: seg.bufferEnd,
			insert: "replaced"
		});
		expect(whole).toEqual({
			from: seg.fileStart,
			to: seg.fileEnd,
			insert: "replaced"
		});
		expect(offset1).toBeGreaterThanOrEqual(seg.fileStart);
	});

	it("leaves file bounds untouched when the edit lands in a separator", () => {
		const { map, offset2 } = makeTwoExcerptMap();
		const origBufferStart2 = map.excerpts[1].bufferStart;
		const origFileStart2 = map.excerpts[1].fileStart;

		// Edit strictly inside the separator: it maps to no file edit.
		const sepFrom = map.excerpts[0].bufferEnd;
		const sepTo = map.excerpts[1].bufferStart;
		expect(sepTo - sepFrom).toBe("\n---\n".length);
		const edit = { from: sepFrom + 1, to: sepTo - 1, insert: "" };
		const fileEdit = map.mapExcerptEditToFileEdit(edit);
		expect(fileEdit).toBeNull();
		map.applyExcerptEdit(edit, fileEdit);

		// Buffer bounds shifted by -3, file bounds unchanged.
		expect(map.excerpts[1].bufferStart).toBe(origBufferStart2 - 3);
		expect(map.excerpts[1].fileStart).toBe(origFileStart2);

		// A later edit in the second excerpt still targets the original file offset.
		const buf2 = map.fileOffsetToExcerptOffset(offset2)!;
		expect(map.mapExcerptEditToFileEdit({ from: buf2, to: buf2 + 6, insert: "X" })).toEqual({
			from: offset2,
			to: offset2 + 6,
			insert: "X"
		});
	});

	it("keeps mappings stable for same-length replacements", () => {
		const { map, offset1, offset2 } = makeTwoExcerptMap();
		const origBufferStart2 = map.excerpts[1].bufferStart;
		const origFileStart2 = map.excerpts[1].fileStart;

		const buf1 = map.fileOffsetToExcerptOffset(offset1)!;
		const excerptEdit = { from: buf1, to: buf1 + 6, insert: "replac" };
		const fileEdit = map.mapExcerptEditToFileEdit(excerptEdit)!;
		map.applyExcerptEdit(excerptEdit, fileEdit);

		expect(map.excerpts[1].bufferStart).toBe(origBufferStart2);
		expect(map.excerpts[1].fileStart).toBe(origFileStart2);
		const buf2 = map.fileOffsetToExcerptOffset(offset2)!;
		expect(map.mapExcerptEditToFileEdit({ from: buf2, to: buf2 + 6, insert: "Y" })).toEqual({
			from: offset2,
			to: offset2 + 6,
			insert: "Y"
		});
	});

	it("stays consistent across several sequential edits like repeated keystrokes", () => {
		const { map, offset1, offset2 } = makeTwoExcerptMap();

		// Three single-character insertions at the start of the first excerpt,
		// mapping and applying each in turn like the update listener does.
		let shift = 0;
		for (const ch of ["a", "b", "c"]) {
			const buf = map.fileOffsetToExcerptOffset(offset1 + shift)!;
			const excerptEdit = { from: buf, to: buf, insert: ch };
			const fileEdit = map.mapExcerptEditToFileEdit(excerptEdit);
			expect(fileEdit).not.toBeNull();
			map.applyExcerptEdit(excerptEdit, fileEdit);
			shift += 1;
		}

		const shiftedOffset2 = offset2 + 3;
		const buf2 = map.fileOffsetToExcerptOffset(shiftedOffset2)!;
		expect(map.bufferText.slice(buf2, buf2 + 6)).toBe("findme");
		expect(map.mapExcerptEditToFileEdit({ from: buf2, to: buf2 + 6, insert: "Z" })).toEqual({
			from: shiftedOffset2,
			to: shiftedOffset2 + 6,
			insert: "Z"
		});
	});

	it("produces no file edit at all for a rejected cross-segment edit", () => {
		const { map } = makeTwoExcerptMap();

		// The edit spans the hidden file text between the two excerpts, so it
		// is rejected as a whole: no file edit is produced, so nothing is
		// written to the file.
		const edit = {
			from: map.excerpts[0].bufferEnd - 2,
			to: map.excerpts[1].bufferStart + 2,
			insert: ""
		};
		expect(map.mapExcerptEditsToFileEdits([edit])).toEqual([]);
	});
});

describe("Excerpt map follows the document it mirrors (Issue #336)", () => {
	const mirrorOrigin: FileOrigin = {
		scheme: "file",
		path: "/test-project/src/mirror.ts",
		name: "mirror.ts"
	};

	const originalContent = "const alpha = 'findme';\nconst beta = 'other';\n";

	function makeMirrorMap(content = originalContent) {
		const built = buildExcerptMapForContent(
			"src/mirror.ts",
			mirrorOrigin,
			content,
			{ pattern: "findme" }
		);
		expect(built).not.toBeNull();
		return built!;
	}

	it("reports a stale map when the document changed outside the excerpt view", () => {
		const built = makeMirrorMap();

		// The document moved on (an edit in the main editor): the map's file
		// offsets no longer describe the text the document holds.
		expect(isExcerptMapStale(built.map, "// a new first line\n" + originalContent)).toBe(true);
	});

	it("reports a fresh map while the document still holds the map's content", () => {
		const built = makeMirrorMap();
		expect(isExcerptMapStale(built.map, originalContent)).toBe(false);
	});

	it("reports a fresh map for a document that is not open", () => {
		const built = makeMirrorMap();
		expect(isExcerptMapStale(built.map, undefined)).toBe(false);
	});

	it("reports a fresh map right after the excerpt view applied its own edit", () => {
		const built = makeMirrorMap();

		const buf = built.map.fileOffsetToExcerptOffset(originalContent.indexOf("findme"))!;
		const excerptEdit = { from: buf, to: buf + 6, insert: "REPLACED" };
		const fileEdit = built.map.mapExcerptEditToFileEdit(excerptEdit)!;
		built.map.applyExcerptEdit(excerptEdit, fileEdit);

		// The document now holds exactly what the map holds, so the map is
		// not stale and the view must not rebuild itself.
		expect(built.map.fileContent).toBe(originalContent.replace("findme", "REPLACED"));
		expect(isExcerptMapStale(built.map, built.map.fileContent)).toBe(false);
	});

	it("rebuilds the map from the current content and re-derives the matches", () => {
		const built = makeMirrorMap();
		const staleOffset = built.matches[0].offset;

		// The document gained a line above the match: the old map's offsets
		// point at the wrong place, so the rebuilt map starts from the
		// current content and finds the match where it is now.
		const edited = "// a new first line\n" + originalContent;
		const rebuilt = makeMirrorMap(edited);

		expect(rebuilt.map.fileContent).toBe(edited);
		expect(rebuilt.matches.length).toBe(1);
		expect(rebuilt.matches[0].line).toBe(2);
		expect(rebuilt.matches[0].offset).toBe(staleOffset + "// a new first line\n".length);

		// The rebuilt map hands out offsets relative to the current content.
		const buf = rebuilt.map.fileOffsetToExcerptOffset(rebuilt.matches[0].offset)!;
		expect(rebuilt.map.bufferText.slice(buf, buf + 6)).toBe("findme");
		expect(rebuilt.map.mapExcerptEditToFileEdit({ from: buf, to: buf + 6, insert: "X" })).toEqual({
			from: rebuilt.matches[0].offset,
			to: rebuilt.matches[0].offset + 6,
			insert: "X"
		});
	});

	it("keeps the search's matches when the query is not a usable pattern", () => {
		const built = buildExcerptMapForContent(
			"src/mirror.ts",
			mirrorOrigin,
			originalContent,
			{ pattern: "(unclosed", isRegex: true }
		);
		expect(built).toBeNull();
	});
});
