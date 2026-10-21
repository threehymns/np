import "../../../../tests/contract/rune-setup";
import { describe, it, expect, mock, beforeAll } from "bun:test";
import type { FileOrigin } from "../storage";
import { toURI } from "../storage";
import { MemorySessionPersistence } from "../persistence";
import type { Worktree } from "../project/worktree.svelte";
import type { TypeScriptSearchEngine } from "./engine";

let WorktreeClass: typeof import("../project/worktree.svelte").Worktree;
let TypeScriptSearchEngineClass: typeof import("./engine").TypeScriptSearchEngine;
let WorkspaceClass: typeof import("../workspace.svelte").Workspace;
let ProjectClass: typeof import("../project/project.svelte").Project;

beforeAll(async () => {
	mock.module("svelte/reactivity", () => ({
		SvelteMap: Map,
		SvelteSet: Set
	}));

	const wtMod = await import("../project/worktree.svelte");
	WorktreeClass = wtMod.Worktree;

	const searchMod = await import("./engine");
	TypeScriptSearchEngineClass = searchMod.TypeScriptSearchEngine;

	const wsMod = await import("../workspace.svelte");
	WorkspaceClass = wsMod.Workspace;

	const projMod = await import("../project/project.svelte");
	ProjectClass = projMod.Project;
});

const rootOrigin: FileOrigin = { scheme: "file", path: "/test-project", name: "test-project" };

function createMockStorage(files: Record<string, string> = {}) {
	return {
		readFile: mock(async (origin: FileOrigin) => {
			const uri = toURI(origin);
			if (uri in files) return files[uri];
			const directPath = origin.path;
			if (directPath in files) return files[directPath];
			if (origin.name === ".gitignore") {
				const gitignorePath = `${origin.path}`;
				if (gitignorePath in files) return files[gitignorePath];
				throw { name: "NotFoundError" };
			}
			throw { name: "NotFoundError" };
		}),
		readDirectory: mock(async (origin: FileOrigin) => {
			const prefix = origin.path;
			const dirEntries: any[] = [];
			const seen = new Set<string>();

			for (const p of Object.keys(files)) {
				const rel = p.startsWith("file://") ? p.slice(7) : p;
				if (rel.startsWith(prefix + "/")) {
					const rest = rel.slice(prefix.length + 1);
					const parts = rest.split("/");
					const name = parts[0];
					if (!seen.has(name)) {
						seen.add(name);
						const isDir = parts.length > 1;
						dirEntries.push({
							name,
							kind: isDir ? ("directory" as const) : ("file" as const),
							origin: { scheme: "file", path: `${prefix}/${name}`, name }
						});
					}
				}
			}
			return dirEntries;
		}),
		pickFile: mock(async () => null),
		pickDirectory: mock(async () => null),
		saveFile: mock(async () => null),
		createFile: mock(async () => {}),
		createDirectory: mock(async () => {}),
		deleteEntry: mock(async () => {}),
		renameEntry: mock(async (o: FileOrigin) => o)
	};
}

describe("SearchBackend seam & v1 TypeScript search engine (Issue #334)", () => {
	it("streams grouped-by-file results with context lines for literal query", async () => {
		const storage = createMockStorage({
			"/test-project/src/index.ts": "line 1\nconst target = 'findme';\nline 3\nline 4",
			"/test-project/README.md": "# Title\nNothing here\nFooter"
		});
		const wt = new WorktreeClass(rootOrigin, { storage });
		await wt.scan();

		const engine = new TypeScriptSearchEngineClass(wt);
		const stream = engine.search({ pattern: "findme" });

		const results: any[] = [];
		for await (const result of stream) {
			results.push(result);
		}

		expect(results.length).toBe(1);
		expect(results[0].filepath).toBe("src/index.ts");
		expect(results[0].matches.length).toBe(1);

		const match = results[0].matches[0];
		expect(match.line).toBe(2);
		expect(match.column).toBe(17);
		expect(match.lineText).toBe("const target = 'findme';");
		expect(match.matchLength).toBe(6);
		expect(match.contextBefore).toEqual([{ line: 1, text: "line 1" }]);
		expect(match.contextAfter).toEqual([{ line: 3, text: "line 3" }]);

		expect(stream.progress.scannedFiles).toBe(2);
		expect(stream.progress.matchedFiles).toBe(1);
		expect(stream.progress.totalMatches).toBe(1);
		expect(stream.progress.truncated).toBe(false);
	});

	it("the engine only reads the Worktree snapshot and never walks the disk itself", async () => {
		const storage = createMockStorage({
			"/test-project/a.txt": "search target in a",
			"/test-project/b.txt": "search target in b"
		});
		const wt = new WorktreeClass(rootOrigin, { storage });
		await wt.scan();

		// Reset readDirectory call counter from initial scan
		storage.readDirectory.mockClear();

		const engine = new TypeScriptSearchEngineClass(wt);
		const stream = engine.search({ pattern: "search target" });
		const results = await stream.all();

		expect(results.length).toBe(2);
		// Zero directory walks during search
		expect(storage.readDirectory.mock.calls.length).toBe(0);
	});

	it("respects .gitignore and never returns ignored files", async () => {
		const storage = createMockStorage({
			"/test-project/.gitignore": "*.secret\nignored-folder/\n",
			"/test-project/visible.txt": "target keyword",
			"/test-project/passwords.secret": "target keyword",
			"/test-project/ignored-folder/file.txt": "target keyword"
		});
		const wt = new WorktreeClass(rootOrigin, { storage });
		await wt.scan();

		const engine = new TypeScriptSearchEngineClass(wt);
		const results = await engine.search({ pattern: "target keyword" }).all();

		const paths = results.map((r) => r.filepath);
		expect(paths).toContain("visible.txt");
		expect(paths).not.toContain("passwords.secret");
		expect(paths).not.toContain("ignored-folder/file.txt");
	});

	it("never returns node_modules or build output", async () => {
		const storage = createMockStorage({
			"/test-project/src/app.ts": "target",
			"/test-project/node_modules/dep/index.js": "target",
			"/test-project/dist/bundle.js": "target",
			"/test-project/build/output.js": "target",
			"/test-project/.svelte-kit/generated/root.svelte": "target"
		});
		const wt = new WorktreeClass(rootOrigin, { storage });
		await wt.scan();

		const engine = new TypeScriptSearchEngineClass(wt);
		const results = await engine.search({ pattern: "target" }).all();

		const paths = results.map((r) => r.filepath);
		expect(paths).toEqual(["src/app.ts"]);
	});

	it("caps results with visible truncation notice when match limit is reached", async () => {
		const storage = createMockStorage({
			"/test-project/file1.txt": "match match match match match", // 5 matches
			"/test-project/file2.txt": "match match match match match"  // 5 matches
		});
		const wt = new WorktreeClass(rootOrigin, { storage });
		await wt.scan();

		const engine = new TypeScriptSearchEngineClass(wt);
		// Cap at 4 matches max
		const stream = engine.search({ pattern: "match" }, { maxMatches: 4 });
		const results = await stream.all();

		const totalMatches = results.reduce((sum, r) => sum + r.matches.length, 0);
		expect(totalMatches).toBe(4);
		expect(stream.progress.truncated).toBe(true);
		expect(stream.progress.truncationReason).toBe("matches");
	});

	it("caps results with visible truncation notice when file limit is reached", async () => {
		const files: Record<string, string> = {};
		for (let i = 1; i <= 10; i++) {
			files[`/test-project/file${i}.txt`] = `hit ${i}`;
		}
		const storage = createMockStorage(files);
		const wt = new WorktreeClass(rootOrigin, { storage });
		await wt.scan();

		const engine = new TypeScriptSearchEngineClass(wt);
		// Cap at 3 files scanned max
		const stream = engine.search({ pattern: "hit" }, { maxFiles: 3 });
		const results = await stream.all();

		expect(stream.progress.scannedFiles).toBe(3);
		expect(stream.progress.truncated).toBe(true);
		expect(stream.progress.truncationReason).toBe("files");
		expect(results.length).toBeLessThanOrEqual(3);
	});

	it("skips binary files during cheap sniff phase", async () => {
		const storage = createMockStorage({
			"/test-project/text.txt": "plain searchtarget text",
			"/test-project/binary.bin": "\0\0some binary searchtarget data"
		});
		const wt = new WorktreeClass(rootOrigin, { storage });
		await wt.scan();

		const engine = new TypeScriptSearchEngineClass(wt);
		const results = await engine.search({ pattern: "searchtarget" }).all();

		expect(results.length).toBe(1);
		expect(results[0].filepath).toBe("text.txt");
	});

	it("caches file content across queries for persistent in-process speed", async () => {
		const storage = createMockStorage({
			"/test-project/code.ts": "hello world"
		});
		const wt = new WorktreeClass(rootOrigin, { storage });
		await wt.scan();

		const engine = new TypeScriptSearchEngineClass(wt);

		// First search reads storage
		await engine.search({ pattern: "hello" }).all();
		const callsAfterFirst = storage.readFile.mock.calls.length;

		// Second search on unchanged snapshot uses in-process cache
		const res2 = await engine.search({ pattern: "world" }).all();
		expect(res2.length).toBe(1);
		expect(storage.readFile.mock.calls.length).toBe(callsAfterFirst);
	});

	it("supports abort signal to cancel search in flight", async () => {
		const files: Record<string, string> = {};
		for (let i = 1; i <= 20; i++) {
			files[`/test-project/file${i}.txt`] = `common query text ${i}`;
		}
		const storage = createMockStorage(files);
		const wt = new WorktreeClass(rootOrigin, { storage });
		await wt.scan();

		const engine = new TypeScriptSearchEngineClass(wt);
		const ac = new AbortController();

		const stream = engine.search({ pattern: "common" }, { signal: ac.signal });
		const results: any[] = [];

		for await (const r of stream) {
			results.push(r);
			ac.abort(); // Cancel after receiving first result
		}

		expect(results.length).toBe(1);
	});
});

describe("Worktree snapshot contract (ADR 0032)", () => {
	it("keeps the whole project file set when a watcher triggers the rescan", async () => {
		const storage = createMockStorage({
			"/test-project/a.txt": "needle in a",
			"/test-project/sub/b.txt": "needle in b",
			"/test-project/sub/deep/c.txt": "needle in c"
		});
		const project = new ProjectClass(
			storage as any,
			() => ({} as any),
			new MemorySessionPersistence()
		);

		project.hasRootPermission = true;
		project.rootOrigin = rootOrigin;

		// The file explorer's scan, which is what the tree publishes.
		await project.projectTree.scan(rootOrigin);

		const engine = project.searchBackend;
		const afterTreeScan = (await engine.search({ pattern: "needle" }).all())
			.map((r) => r.filepath)
			.sort();
		expect(afterTreeScan).toEqual(["a.txt", "sub/b.txt", "sub/deep/c.txt"]);

		// A watcher rescan carries no options at all. It must publish the
		// same file set, or project search silently stops finding the
		// nested files.
		await project.worktree!.scan();

		const afterWatcherScan = (await engine.search({ pattern: "needle" }).all())
			.map((r) => r.filepath)
			.sort();
		expect(afterWatcherScan).toEqual(afterTreeScan);
		expect(afterWatcherScan).toEqual(["a.txt", "sub/b.txt", "sub/deep/c.txt"]);
	});
});

describe("Workspace and Project search tab integration", () => {
	it("Workspace opens search tab with type 'search'", () => {
		const storage = createMockStorage();
		const project = new ProjectClass(storage as any, () => ({} as any), {
			loadOpenFiles: mock(async () => []),
			saveOpenFiles: mock(async () => {}),
			loadActiveDocumentId: mock(async () => null),
			saveActiveDocumentId: mock(async () => {})
		} as any);

		const ws = new WorkspaceClass(storage as any, () => ({} as any), {
			loadOpenFiles: mock(async () => []),
			saveOpenFiles: mock(async () => {}),
			loadActiveDocumentId: mock(async () => null),
			saveActiveDocumentId: mock(async () => {})
		} as any);

		const tabId = ws.openSearchTab();
		expect(tabId).toBe("__project_search__");
		expect(ws.tabs.length).toBe(1);
		expect(ws.tabs[0].type).toBe("search");
		expect(ws.activeTabId).toBe("__project_search__");

		// Calling again is idempotent and activates existing tab
		const tabId2 = ws.openSearchTab();
		expect(tabId2).toBe("__project_search__");
		expect(ws.tabs.length).toBe(1);
	});

	it("Project exposes searchBackend wired to worktree", async () => {
		const storage = createMockStorage({
			"/test-project/foo.ts": "const x = 42;"
		});
		const project = new ProjectClass(storage as any, () => ({} as any), {
			loadOpenFiles: mock(async () => []),
			saveOpenFiles: mock(async () => {}),
			loadActiveDocumentId: mock(async () => null),
			saveActiveDocumentId: mock(async () => {})
		} as any);

		project.hasRootPermission = true;
		project.rootOrigin = rootOrigin;
		await project.worktree!.scan();

		expect(project.searchBackend).toBeDefined();
		const results = await project.searchBackend.search({ pattern: "42" }).all();
		expect(results.length).toBe(1);
		expect(results[0].filepath).toBe("foo.ts");
	});

	it("clicking a match opens the file at the line and column location", async () => {
		const storage = createMockStorage({
			"/test-project/main.ts": "line 1\nlet needle = 100;\nline 3"
		});
		const ws = new WorkspaceClass(storage as any, () => ({} as any), {
			loadOpenFiles: mock(async () => []),
			saveOpenFiles: mock(async () => {}),
			loadActiveDocumentId: mock(async () => null),
			saveActiveDocumentId: mock(async () => {})
		} as any);
		ws.project.hasRootPermission = true;
		ws.project.rootOrigin = rootOrigin;
		await ws.project.worktree!.scan();

		const stream = ws.project.searchBackend.search({ pattern: "needle" });
		const results = await stream.all();
		expect(results.length).toBe(1);

		const match = results[0].matches[0];
		const origin = results[0].origin;

		// Simulate jumping to match location
		const doc = await ws.openFile(origin);
		expect(doc).toBeDefined();
		if (doc) {
			doc.pendingLineToScroll = match.line;
			doc.pendingColumn = match.column;
			doc.pendingMatchLength = match.matchLength;
		}

		expect(doc!.pendingLineToScroll).toBe(2);
		expect(doc!.pendingColumn).toBe(5);
		expect(doc!.pendingMatchLength).toBe(6);
	});

	it("preserves search virtualTabType in session serialization", () => {
		const storage = createMockStorage();
		const ws = new WorkspaceClass(storage as any, () => ({} as any), {
			loadOpenFiles: mock(async () => []),
			saveOpenFiles: mock(async () => {}),
			loadActiveDocumentId: mock(async () => null),
			saveActiveDocumentId: mock(async () => {})
		} as any);

		ws.openSearchTab();
		const serialized = (ws as any).serializeWorkspace();

		expect(serialized.docs.length).toBe(1);
		expect(serialized.docs[0].virtualTabType).toBe("search");
		expect(serialized.docs[0].id).toBe("__project_search__");
	});
});
