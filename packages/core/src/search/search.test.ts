import "../../../../tests/contract/rune-setup";
import { describe, it, expect, mock, beforeAll } from "bun:test";
import type { FileOrigin } from "../storage";
import { toURI } from "../storage";
import { MemorySessionPersistence } from "../persistence";
import type { Worktree } from "../project/worktree.svelte";
import type { TypeScriptSearchEngine } from "./engine";

let WorktreeClass: typeof import("../project/worktree.svelte").Worktree;
let TypeScriptSearchEngineClass: typeof import("./engine").TypeScriptSearchEngine;
let SearchResultStreamClass: typeof import("./engine").SearchResultStream;
let WorkspaceClass: typeof import("../workspace.svelte").Workspace;
let ProjectClass: typeof import("../project/project.svelte").Project;
let SearchTabSessionClass: typeof import("./session.svelte").SearchTabSession;
let buildSearchRegexFn: typeof import("./engine").buildSearchRegex;
let findMatchesInContentFn: typeof import("./engine").findMatchesInContent;
let globToRegexFn: typeof import("./engine").globToRegex;
let parseGlobsFn: typeof import("./engine").parseGlobs;

beforeAll(async () => {
	mock.module("svelte/reactivity", () => ({
		SvelteMap: Map,
		SvelteSet: Set
	}));

	const wtMod = await import("../project/worktree.svelte");
	WorktreeClass = wtMod.Worktree;

	const searchMod = await import("./engine");
	TypeScriptSearchEngineClass = searchMod.TypeScriptSearchEngine;
	SearchResultStreamClass = searchMod.SearchResultStream;
	buildSearchRegexFn = searchMod.buildSearchRegex;
	findMatchesInContentFn = searchMod.findMatchesInContent;
	globToRegexFn = searchMod.globToRegex;
	parseGlobsFn = searchMod.parseGlobs;

	const sessionMod = await import("./session.svelte");
	SearchTabSessionClass = sessionMod.SearchTabSession;

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

	it("searches the live text a Document holds, not the disk", async () => {
		// A file changed in the results is unsaved: its text lives in a
		// Document. The search reads that text, so the results describe
		// what the user is looking at and a replace-all's re-run is not
		// stale.
		const storage = createMockStorage({
			"/test-project/src/index.ts": "the file on disk"
		});
		const wt = new WorktreeClass(rootOrigin, { storage });
		await wt.scan();

		const engine = new TypeScriptSearchEngineClass(wt);
		const origin: FileOrigin = {
			scheme: "file",
			path: "/test-project/src/index.ts",
			name: "index.ts"
		};

		const live = await engine.search(
			{ pattern: "target" },
			{ liveContent: (o) => (o.path === origin.path ? "alpha target beta" : undefined) }
		).all();

		expect(live).toHaveLength(1);
		expect(live[0].matches[0].lineText).toBe("alpha target beta");

		// The text on disk is not what the user sees, so it is not a match.
		expect(await engine.search({ pattern: "disk" }).all()).toHaveLength(1);
	});

	it("the shared file matcher reports the same matches as the engine search", async () => {
		const content = "line 1\nconst target = 'findme';\nline 3\nline 4";
		const storage = createMockStorage({ "/test-project/src/index.ts": content });
		const wt = new WorktreeClass(rootOrigin, { storage });
		await wt.scan();

		const engine = new TypeScriptSearchEngineClass(wt);
		const results = await engine.search({ pattern: "findme" }).all();

		// The excerpt view re-derives matches with the same matcher, so a
		// rebuilt excerpt reports the positions a fresh search would.
		const scan = findMatchesInContentFn(
			content,
			buildSearchRegexFn({ pattern: "findme" }),
			1,
			Number.POSITIVE_INFINITY
		);

		expect(scan.truncated).toBe(false);
		expect(scan.matches).toEqual(results[0].matches);
	});

	it("the shared file matcher stops at the match budget", () => {
		const scan = findMatchesInContentFn(
			"aaa\naaa\naaa",
			buildSearchRegexFn({ pattern: "aaa" }),
			1,
			2
		);

		expect(scan.matches.length).toBe(2);
		expect(scan.truncated).toBe(true);
	});

	it("the shared file matcher keeps offsets correct with CRLF line endings", () => {
		const scan = findMatchesInContentFn(
			"first\r\ntarget on second\r\nthird",
			buildSearchRegexFn({ pattern: "target" }),
			0,
			Number.POSITIVE_INFINITY
		);

		expect(scan.matches.length).toBe(1);
		// "first\r\n" is 7 chars, so the match on line 2 starts at offset 7.
		expect(scan.matches[0].offset).toBe(7);
		expect(scan.matches[0].line).toBe(2);
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

	it("stops when the project switches roots mid-search, instead of mixing two roots", async () => {
		const storageA = createMockStorage({
			"/root-a/one.txt": "needle",
			"/root-a/two.txt": "needle"
		});
		const storageB = createMockStorage({ "/root-b/other.txt": "needle" });
		const wtA = new WorktreeClass({ scheme: "file", path: "/root-a", name: "root-a" }, { storage: storageA });
		await wtA.scan();
		const wtB = new WorktreeClass({ scheme: "file", path: "/root-b", name: "root-b" }, { storage: storageB });
		await wtB.scan();

		const engine = new TypeScriptSearchEngineClass(wtA);
		// The scan above already read the .gitignore of the second root.
		const readsBeforeSearch = storageB.readFile.mock.calls.length;
		const stream = engine.search(
			{ pattern: "needle" },
			{
				onMatch: () => {
					// The project switched roots while the search was running.
					engine.attachToWorktree(wtB);
				}
			}
		);
		const results = await stream.all();

		// The search stops on the switch: the rest of the file list belongs
		// to the root the search started on, and reading it through the new
		// root's storage would mix the two roots.
		expect(results.map((r) => r.filepath)).toEqual(["one.txt"]);
		expect(storageB.readFile.mock.calls.length).toBe(readsBeforeSearch);
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

	it("cleans up external AbortSignal listener when stream is consumed with all()", async () => {
		const files: Record<string, string> = {
			"/test-project/file1.txt": "search text",
			"/test-project/file2.txt": "search text"
		};
		const storage = createMockStorage(files);
		const wt = new WorktreeClass(rootOrigin, { storage });
		await wt.scan();

		const engine = new TypeScriptSearchEngineClass(wt);
		const ac = new AbortController();
		let listenerCount = 0;
		const origAdd = ac.signal.addEventListener.bind(ac.signal);
		const origRemove = ac.signal.removeEventListener.bind(ac.signal);
		ac.signal.addEventListener = (type: string, listener: any, options?: any) => {
			if (type === "abort") listenerCount++;
			return origAdd(type, listener, options);
		};
		ac.signal.removeEventListener = (type: string, listener: any, options?: any) => {
			if (type === "abort") listenerCount--;
			return origRemove(type, listener, options);
		};

		const stream = engine.search({ pattern: "search" }, { signal: ac.signal });
		expect(listenerCount).toBe(1);

		const results = await stream.all();
		expect(results.length).toBe(2);
		expect(listenerCount).toBe(0);
	});

	it("cleans up external AbortSignal listener when stream is consumed with for-await", async () => {
		const files: Record<string, string> = {
			"/test-project/file1.txt": "search text"
		};
		const storage = createMockStorage(files);
		const wt = new WorktreeClass(rootOrigin, { storage });
		await wt.scan();

		const engine = new TypeScriptSearchEngineClass(wt);
		const ac = new AbortController();
		let listenerCount = 0;
		const origAdd = ac.signal.addEventListener.bind(ac.signal);
		const origRemove = ac.signal.removeEventListener.bind(ac.signal);
		ac.signal.addEventListener = (type: string, listener: any, options?: any) => {
			if (type === "abort") listenerCount++;
			return origAdd(type, listener, options);
		};
		ac.signal.removeEventListener = (type: string, listener: any, options?: any) => {
			if (type === "abort") listenerCount--;
			return origRemove(type, listener, options);
		};

		const stream = engine.search({ pattern: "search" }, { signal: ac.signal });
		expect(listenerCount).toBe(1);

		for await (const _item of stream) {
			// consuming stream
		}
		expect(listenerCount).toBe(0);
	});

	it("cleans up external AbortSignal listener when stream is cancelled", async () => {
		const files: Record<string, string> = {
			"/test-project/file1.txt": "search text"
		};
		const storage = createMockStorage(files);
		const wt = new WorktreeClass(rootOrigin, { storage });
		await wt.scan();

		const engine = new TypeScriptSearchEngineClass(wt);
		const ac = new AbortController();
		let listenerCount = 0;
		const origAdd = ac.signal.addEventListener.bind(ac.signal);
		const origRemove = ac.signal.removeEventListener.bind(ac.signal);
		ac.signal.addEventListener = (type: string, listener: any, options?: any) => {
			if (type === "abort") listenerCount++;
			return origAdd(type, listener, options);
		};
		ac.signal.removeEventListener = (type: string, listener: any, options?: any) => {
			if (type === "abort") listenerCount--;
			return origRemove(type, listener, options);
		};

		const stream = engine.search({ pattern: "search" }, { signal: ac.signal });
		expect(listenerCount).toBe(1);

		stream.cancel();
		expect(listenerCount).toBe(0);
	});

	it("cleans up external AbortSignal listener when SearchResultStream generator throws", async () => {
		const ac = new AbortController();
		let listenerCount = 0;
		const origAdd = ac.signal.addEventListener.bind(ac.signal);
		const origRemove = ac.signal.removeEventListener.bind(ac.signal);
		ac.signal.addEventListener = (type: string, listener: any, options?: any) => {
			if (type === "abort") listenerCount++;
			return origAdd(type, listener, options);
		};
		ac.signal.removeEventListener = (type: string, listener: any, options?: any) => {
			if (type === "abort") listenerCount--;
			return origRemove(type, listener, options);
		};

		const stream = new SearchResultStreamClass(
			async function* () {
				throw new Error("Generator failure");
			},
			ac.signal
		);
		expect(listenerCount).toBe(1);

		await expect(stream.all()).rejects.toThrow("Generator failure");
		expect(listenerCount).toBe(0);
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
	it("Workspace opens search tab with type 'search' and focuses on subsequent opens", async () => {
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
		expect(ws.searchTabFocusNonce).toBe(1);

		// Switch active tab to another document
		await ws.newFile();
		expect(ws.tabs.length).toBe(2);
		expect(ws.activeTabId).not.toBe("__project_search__");

		// Calling openSearchTab again focuses the existing search tab without duplicating it
		const tabId2 = ws.openSearchTab();
		expect(tabId2).toBe("__project_search__");
		expect(ws.tabs.length).toBe(2);
		expect(ws.activeTabId).toBe("__project_search__");
		expect(ws.searchTabFocusNonce).toBe(2);

		// Calling while already focused still increments focus nonce to refocus input
		ws.openSearchTab();
		expect(ws.searchTabFocusNonce).toBe(3);
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

describe("Query options: regex, case-sensitivity, whole-word, and globs (Issue #335)", () => {
	it("regex toggle enables pattern search with lookaround support", async () => {
		const storage = createMockStorage({
			"/test-project/src/calc.ts": "const width = 100px;\nconst height = 200px;\nconst name = 'test';",
			"/test-project/src/lookaround.ts": "function calculateTotal() {}\nconst total = calculateTotal();\nconst subtotal = 10;\ncolor:#fff;\ncolor:red;\nmargin-padding: 0;\npadding: 10em;"
		});
		const wt = new WorktreeClass(rootOrigin, { storage });
		await wt.scan();

		const engine = new TypeScriptSearchEngineClass(wt);

		// Basic regex matching digits followed by px
		const digitResults = await engine.search({ pattern: "\\d+px", isRegex: true }).all();
		expect(digitResults.length).toBe(1);
		expect(digitResults[0].filepath).toBe("src/calc.ts");
		expect(digitResults[0].matches.length).toBe(2);
		expect(digitResults[0].matches[0].lineText).toBe("const width = 100px;");
		expect(digitResults[0].matches[0].matchLength).toBe(5); // "100px"
		expect(digitResults[0].matches[1].lineText).toBe("const height = 200px;");
		expect(digitResults[0].matches[1].matchLength).toBe(5); // "200px"

		// Positive lookbehind: match identifier following function keyword
		const lookbehindResults = await engine.search({
			pattern: "(?<=function\\s+)[a-zA-Z0-9_]+",
			isRegex: true
		}).all();
		expect(lookbehindResults.length).toBe(1);
		expect(lookbehindResults[0].matches.length).toBe(1);
		const lbMatch = lookbehindResults[0].matches[0];
		expect(lbMatch.line).toBe(1);
		expect(lbMatch.lineText.slice(lbMatch.column - 1, lbMatch.column - 1 + lbMatch.matchLength)).toBe("calculateTotal");

		// Positive lookahead: match identifier immediately followed by opening parenthesis
		const lookaheadResults = await engine.search({
			pattern: "[a-zA-Z0-9_]+(?=\\s*\\(\\))",
			isRegex: true
		}).all();
		expect(lookaheadResults.length).toBe(1);
		expect(lookaheadResults[0].matches.length).toBe(2);
		expect(lookaheadResults[0].matches[0].lineText.slice(
			lookaheadResults[0].matches[0].column - 1,
			lookaheadResults[0].matches[0].column - 1 + lookaheadResults[0].matches[0].matchLength
		)).toBe("calculateTotal");

		// Negative lookahead: match color: not followed by #
		const negLookaheadResults = await engine.search({
			pattern: "color:(?!#)",
			isRegex: true
		}).all();
		expect(negLookaheadResults.length).toBe(1);
		expect(negLookaheadResults[0].matches.length).toBe(1);
		expect(negLookaheadResults[0].matches[0].lineText).toBe("color:red;");

		// Negative lookbehind: match padding not preceded by hyphen
		const negLookbehindResults = await engine.search({
			pattern: "(?<!-)padding",
			isRegex: true
		}).all();
		expect(negLookbehindResults.length).toBe(1);
		expect(negLookbehindResults[0].matches.length).toBe(1);
		expect(negLookbehindResults[0].matches[0].lineText).toBe("padding: 10em;");
	});

	it("anchored regexes pass the whole-file prefilter on non-first lines", async () => {
		const storage = createMockStorage({
			"/test-project/src/anchor.ts": "const unrelated = 1;\ntarget = 2;"
		});
		const wt = new WorktreeClass(rootOrigin, { storage });
		await wt.scan();

		const engine = new TypeScriptSearchEngineClass(wt);

		const results = await engine.search({ pattern: "^target", isRegex: true }).all();
		expect(results.length).toBe(1);
		expect(results[0].filepath).toBe("src/anchor.ts");
		expect(results[0].matches.length).toBe(1);
		expect(results[0].matches[0].line).toBe(2);
	});

	it("regex lookarounds against newlines are not skipped by the prefilter", async () => {
		const storage = createMockStorage({
			"/test-project/src/look.ts": "foo\n"
		});
		const wt = new WorktreeClass(rootOrigin, { storage });
		await wt.scan();

		const engine = new TypeScriptSearchEngineClass(wt);

		// (?!\n) fails the whole-file test ("foo" is followed by "\n" in the
		// raw content) but matches the split "foo" line. The prefilter must
		// not skip the file.
		const results = await engine.search({ pattern: "foo(?!\\n)", isRegex: true }).all();
		expect(results.length).toBe(1);
		expect(results[0].filepath).toBe("src/look.ts");
		expect(results[0].matches.length).toBe(1);
		expect(results[0].matches[0].lineText).toBe("foo");
	});

	it("invalid regex does not crash engine and yields 0 results", async () => {
		const storage = createMockStorage({
			"/test-project/src/index.ts": "const foo = 'bar';"
		});
		const wt = new WorktreeClass(rootOrigin, { storage });
		await wt.scan();

		const engine = new TypeScriptSearchEngineClass(wt);

		// Invalid regex pattern: unclosed bracket
		const stream = engine.search({ pattern: "[a-z", isRegex: true });
		const results = await stream.all();
		expect(results.length).toBe(0);

		// buildSearchRegex throws SyntaxError for callers that validate regex
		expect(() => buildSearchRegexFn({ pattern: "[a-z", isRegex: true })).toThrow();
	});

	it("case-sensitive toggle filters results correctly", async () => {
		const storage = createMockStorage({
			"/test-project/src/case.ts": "const FooBar = 1;\nconst foobar = 2;\nconst FOOBAR = 3;"
		});
		const wt = new WorktreeClass(rootOrigin, { storage });
		await wt.scan();

		const engine = new TypeScriptSearchEngineClass(wt);

		// Case-insensitive (default): finds all 3
		const insensResults = await engine.search({ pattern: "FooBar", caseSensitive: false }).all();
		expect(insensResults.length).toBe(1);
		expect(insensResults[0].matches.length).toBe(3);

		// Case-sensitive: finds only FooBar
		const sensResults = await engine.search({ pattern: "FooBar", caseSensitive: true }).all();
		expect(sensResults.length).toBe(1);
		expect(sensResults[0].matches.length).toBe(1);
		expect(sensResults[0].matches[0].lineText).toBe("const FooBar = 1;");
	});

	it("whole-word toggle filters results correctly", async () => {
		const storage = createMockStorage({
			"/test-project/src/word.ts": "const target = 1;\nconst subtarget = 2;\nconst targetWord = 3;\nfn(target);"
		});
		const wt = new WorktreeClass(rootOrigin, { storage });
		await wt.scan();

		const engine = new TypeScriptSearchEngineClass(wt);

		// Whole word OFF: matches all 4 lines
		const partialResults = await engine.search({ pattern: "target", wholeWord: false }).all();
		expect(partialResults.length).toBe(1);
		expect(partialResults[0].matches.length).toBe(4);

		// Whole word ON: matches only "const target = 1;" and "fn(target);"
		const wholeResults = await engine.search({ pattern: "target", wholeWord: true }).all();
		expect(wholeResults.length).toBe(1);
		expect(wholeResults[0].matches.length).toBe(2);
		expect(wholeResults[0].matches[0].line).toBe(1);
		expect(wholeResults[0].matches[1].line).toBe(4);
	});

	it("include/exclude globs narrow the searched file set", async () => {
		const storage = createMockStorage({
			"/test-project/src/app.ts": "const token = 'xyz';",
			"/test-project/src/app.test.ts": "const token = 'xyz';",
			"/test-project/src/utils.ts": "const token = 'xyz';",
			"/test-project/docs/readme.md": "token documentation",
			"/test-project/package.json": '{"token": "xyz"}'
		});
		const wt = new WorktreeClass(rootOrigin, { storage });
		await wt.scan();

		const engine = new TypeScriptSearchEngineClass(wt);

		// No globs: matches all 5 files
		const allResults = await engine.search({ pattern: "token" }).all();
		expect(allResults.length).toBe(5);

		// Include *.ts only: matches 3 ts files
		const tsOnly = await engine.search({
			pattern: "token",
			includeGlobs: ["*.ts"]
		}).all();
		const tsPaths = tsOnly.map((r) => r.filepath);
		expect(tsPaths.sort()).toEqual(["src/app.test.ts", "src/app.ts", "src/utils.ts"].sort());

		// Include *.ts but exclude *.test.ts: matches only app.ts and utils.ts
		const noTests = await engine.search({
			pattern: "token",
			includeGlobs: ["*.ts"],
			excludeGlobs: ["*.test.ts"]
		}).all();
		const noTestPaths = noTests.map((r) => r.filepath);
		expect(noTestPaths.sort()).toEqual(["src/app.ts", "src/utils.ts"].sort());

		// Comma-separated globs in includeGlobs string
		const multiInclude = await engine.search({
			pattern: "token",
			includeGlobs: "*.md, *.json"
		}).all();
		const multiPaths = multiInclude.map((r) => r.filepath);
		expect(multiPaths.sort()).toEqual(["docs/readme.md", "package.json"].sort());
	});

	it("directory-style globs select the paths below the directory", async () => {
		const storage = createMockStorage({
			"/test-project/src/app.ts": "const token = 'xyz';",
			"/test-project/src/app.test.ts": "const token = 'xyz';",
			"/test-project/src/utils.ts": "const token = 'xyz';",
			"/test-project/docs/readme.md": "token documentation",
			"/test-project/package.json": '{"token": "xyz"}'
		});
		const wt = new WorktreeClass(rootOrigin, { storage });
		await wt.scan();

		const engine = new TypeScriptSearchEngineClass(wt);

		// Bare directory name includes everything below it
		const srcOnly = await engine.search({
			pattern: "token",
			includeGlobs: ["src"]
		}).all();
		expect(srcOnly.map((r) => r.filepath).sort()).toEqual(
			["src/app.test.ts", "src/app.ts", "src/utils.ts"].sort()
		);

		// Trailing-slash form names the same directory
		const srcSlash = await engine.search({
			pattern: "token",
			includeGlobs: ["src/"]
		}).all();
		expect(srcSlash.map((r) => r.filepath).sort()).toEqual(
			["src/app.test.ts", "src/app.ts", "src/utils.ts"].sort()
		);

		// Excluding a directory drops everything below it
		const noDocs = await engine.search({
			pattern: "token",
			excludeGlobs: ["docs/"]
		}).all();
		expect(noDocs.map((r) => r.filepath).sort()).toEqual(
			["package.json", "src/app.test.ts", "src/app.ts", "src/utils.ts"].sort()
		);
	});

	it("root globs select the project root and all files", async () => {
		const storage = createMockStorage({
			"/test-project/src/app.ts": "const token = 'xyz';",
			"/test-project/docs/readme.md": "token documentation",
			"/test-project/package.json": '{"token": "xyz"}'
		});
		const wt = new WorktreeClass(rootOrigin, { storage });
		await wt.scan();

		const engine = new TypeScriptSearchEngineClass(wt);
		const allFiles = ["docs/readme.md", "package.json", "src/app.ts"].sort();

		for (const rootGlob of ["./", "/"]) {
			const results = await engine.search({
				pattern: "token",
				includeGlobs: [rootGlob]
			}).all();
			expect(results.map((r) => r.filepath).sort()).toEqual(allFiles);
		}
	});

	it("wildcard globs stay within a single path segment", async () => {
		const storage = createMockStorage({
			"/test-project/src/app.ts": "const token = 'xyz';",
			"/test-project/src/nested/deep.ts": "const token = 'xyz';",
			"/test-project/package.json": '{"token": "xyz"}'
		});
		const wt = new WorktreeClass(rootOrigin, { storage });
		await wt.scan();

		const engine = new TypeScriptSearchEngineClass(wt);

		// "src/*" matches files directly in src/, not nested paths
		const shallow = await engine.search({
			pattern: "token",
			includeGlobs: ["src/*"]
		}).all();
		expect(shallow.map((r) => r.filepath).sort()).toEqual(["src/app.ts"]);

		// The same holds for exclude globs
		const notNested = await engine.search({
			pattern: "token",
			excludeGlobs: ["src/*"]
		}).all();
		expect(notNested.map((r) => r.filepath).sort()).toEqual(
			["package.json", "src/nested/deep.ts"].sort()
		);
	});
});

describe("Search tab session and toggle persistence (Issue #335)", () => {
	it("SearchTabSession stores toggle state and exposes regex validation error", () => {
		const session = new SearchTabSessionClass();
		expect(session.query).toBe("");
		expect(session.isRegex).toBe(false);
		expect(session.caseSensitive).toBe(false);
		expect(session.wholeWord).toBe(false);
		expect(session.includePattern).toBe("");
		expect(session.excludePattern).toBe("");
		expect(session.regexError).toBeNull();

		// Invalid regex returns error message when isRegex is true
		session.query = "[invalid";
		expect(session.regexError).toBeNull(); // isRegex is false, so no error
		session.toggleRegex();
		expect(session.isRegex).toBe(true);
		expect(session.regexError).not.toBeNull();
		expect(typeof session.regexError).toBe("string");

		// Valid regex clears error
		session.query = "[a-z]+";
		expect(session.regexError).toBeNull();

		// Toggles work
		session.toggleCaseSensitive();
		expect(session.caseSensitive).toBe(true);
		session.toggleWholeWord();
		expect(session.wholeWord).toBe(true);

		const query = session.toQuery();
		expect(query.pattern).toBe("[a-z]+");
		expect(query.isRegex).toBe(true);
		expect(query.caseSensitive).toBe(true);
		expect(query.wholeWord).toBe(true);
	});

	it("toggle state persists per search tab while open", async () => {
		const storage = createMockStorage();
		const ws = new WorkspaceClass(storage as any, () => ({} as any), {
			loadOpenFiles: mock(async () => []),
			saveOpenFiles: mock(async () => {}),
			loadActiveDocumentId: mock(async () => null),
			saveActiveDocumentId: mock(async () => {})
		} as any);

		const searchTabId = ws.openSearchTab("initial query");
		const session = ws.getSearchSession(searchTabId);
		expect(session.query).toBe("initial query");
		expect(session.isRegex).toBe(false);

		// Change toggle options on this tab
		session.isRegex = true;
		session.caseSensitive = true;
		session.wholeWord = true;
		session.includePattern = "*.ts";
		session.excludePattern = "*.test.ts";

		// Open a document tab and verify activeTabId switches away
		const doc = await ws.newFile();
		expect(doc).toBeDefined();
		expect(ws.activeTabId).toBe(doc!.id);

		// Switch back to search tab: state must persist
		ws.activeTabId = searchTabId;
		const restoredSession = ws.getSearchSession(searchTabId);
		expect(restoredSession.query).toBe("initial query");
		expect(restoredSession.isRegex).toBe(true);
		expect(restoredSession.caseSensitive).toBe(true);
		expect(restoredSession.wholeWord).toBe(true);
		expect(restoredSession.includePattern).toBe("*.ts");
		expect(restoredSession.excludePattern).toBe("*.test.ts");

		// Closing the tab deletes its session
		ws.closeTab(searchTabId);
		const newSessionAfterClose = ws.getSearchSession(searchTabId);
		expect(newSessionAfterClose.isRegex).toBe(false); // Clean new state
	});

	it("preserves search toggle state in session serialization", () => {
		const storage = createMockStorage();
		const ws = new WorkspaceClass(storage as any, () => ({} as any), {
			loadOpenFiles: mock(async () => []),
			saveOpenFiles: mock(async () => {}),
			loadActiveDocumentId: mock(async () => null),
			saveActiveDocumentId: mock(async () => {})
		} as any);

		const tabId = ws.openSearchTab("findSomething");
		const session = ws.getSearchSession(tabId);
		session.isRegex = true;
		session.caseSensitive = true;
		session.wholeWord = true;
		session.includePattern = "src/**";
		session.excludePattern = "dist/**";

		const serialized = (ws as any).serializeWorkspace().docs;
		expect(serialized.length).toBe(1);
		expect(serialized[0].virtualTabType).toBe("search");
		expect(serialized[0].searchQuery).toBe("findSomething");
		expect(serialized[0].searchIsRegex).toBe(true);
		expect(serialized[0].searchCaseSensitive).toBe(true);
		expect(serialized[0].searchWholeWord).toBe(true);
		expect(serialized[0].searchIncludePattern).toBe("src/**");
		expect(serialized[0].searchExcludePattern).toBe("dist/**");
	});
});
