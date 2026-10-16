import "../../../../tests/contract/rune-setup";
import { describe, it, expect, mock, beforeAll } from "bun:test";
import type { FileOrigin } from "../storage";
import { toURI } from "../storage";

let WorktreeClass: typeof import("./worktree.svelte").Worktree;
let PolledSnapshotStrategyClass: typeof import("./worktree.svelte").PolledSnapshotStrategy;
let ProjectTreeClass: typeof import("./tree.svelte").ProjectTree;

beforeAll(async () => {
	mock.module("svelte/reactivity", () => ({
		SvelteMap: Map,
		SvelteSet: Set
	}));

	const wtMod = await import("./worktree.svelte");
	WorktreeClass = wtMod.Worktree;
	PolledSnapshotStrategyClass = wtMod.PolledSnapshotStrategy;

	const treeMod = await import("./tree.svelte");
	ProjectTreeClass = treeMod.ProjectTree;
});

const rootOrigin: FileOrigin = { scheme: "file", path: "/test-project", name: "test-project" };

function createMockStorage(files: Record<string, string> = {}) {
	return {
		readFile: mock(async (origin: FileOrigin) => {
			const uri = toURI(origin);
			if (uri in files) return files[uri];
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
		createFile: mock(async () => {}),
		createDirectory: mock(async () => {}),
		deleteEntry: mock(async () => {}),
		renameEntry: mock(async (o: FileOrigin) => o)
	};
}

describe("Worktree owns the live file snapshot (ADR 0025)", () => {
	it("exposes the live file snapshot with initial state", () => {
		const storage = createMockStorage();
		const wt = new WorktreeClass(rootOrigin, { storage });

		expect(wt.root).toEqual(rootOrigin);
		expect(wt.version).toBe(0);
		expect(wt.entries).toEqual([]);
		expect(wt.snapshot).toEqual({
			root: rootOrigin,
			entries: [],
			version: 0
		});
		expect(wt.strategy.name).toBe("polled");
	});

	it("scans and updates snapshot version and entries", async () => {
		const storage = createMockStorage({
			"/test-project/README.md": "# Readme",
			"/test-project/src/index.ts": "console.log('hi');"
		});
		const wt = new WorktreeClass(rootOrigin, { storage });

		const nodes = await wt.scan();

		expect(nodes.length).toBe(2);
		expect(wt.entries.length).toBe(2);
		expect(wt.version).toBe(1);
		expect(wt.snapshot.version).toBe(1);
		expect(wt.snapshot.entries).toBe(wt.entries);
	});

	it("respects .gitignore during scan", async () => {
		const storage = createMockStorage({
			"/test-project/.gitignore": "*.log\ntemp/\n",
			"/test-project/app.log": "log",
			"/test-project/temp/temp.txt": "temp",
			"/test-project/app.ts": "code"
		});
		const wt = new WorktreeClass(rootOrigin, { storage });

		await wt.scan();

		const names = wt.entries.map((e) => e.name);
		expect(names).toContain("app.ts");
		expect(names).toContain(".gitignore");
		expect(names).not.toContain("app.log");
		expect(names).not.toContain("temp");
	});

	it("filters node_modules, .git, and hidden files (except .gitignore)", async () => {
		const storage = createMockStorage({
			"/test-project/node_modules/pkg/index.js": "",
			"/test-project/.git/HEAD": "",
			"/test-project/.hidden": "",
			"/test-project/.gitignore": "",
			"/test-project/visible.ts": ""
		});
		const wt = new WorktreeClass(rootOrigin, { storage });

		await wt.scan();

		const names = wt.entries.map((e) => e.name);
		expect(names).toContain("visible.ts");
		expect(names).toContain(".gitignore");
		expect(names).not.toContain("node_modules");
		expect(names).not.toContain(".git");
		expect(names).not.toContain(".hidden");
	});
});

describe("Worktree subscription seam (ticket 2 / ticket 3 consumers)", () => {
	it("notifies subscriber immediately on subscribe and on snapshot updates", async () => {
		const storage = createMockStorage({
			"/test-project/file1.txt": "content"
		});
		const wt = new WorktreeClass(rootOrigin, { storage });

		const received: any[] = [];
		const unsubscribe = wt.subscribe((snapshot) => {
			received.push(snapshot);
		});

		// Immediate notification
		expect(received.length).toBe(1);
		expect(received[0].version).toBe(0);
		expect(received[0].entries).toEqual([]);

		// After scan
		await wt.scan();
		expect(received.length).toBe(2);
		expect(received[1].version).toBe(1);
		expect(received[1].entries.length).toBe(1);
		expect(received[1].entries[0].name).toBe("file1.txt");

		// After updateSnapshot (e.g. external watcher update in ticket 2)
		wt.updateSnapshot([]);
		expect(received.length).toBe(3);
		expect(received[2].version).toBe(2);
		expect(received[2].entries).toEqual([]);

		unsubscribe();

		// No notifications after unsubscribe
		wt.updateSnapshot([]);
		expect(received.length).toBe(3);
	});

	it("allows multiple independent subscribers (file tree and search engine)", async () => {
		const storage = createMockStorage({
			"/test-project/file1.txt": "content"
		});
		const wt = new WorktreeClass(rootOrigin, { storage });

		const treeReceived: any[] = [];
		const searchEngineReceived: any[] = [];

		const unsub1 = wt.subscribe((snap) => treeReceived.push(snap));
		const unsub2 = wt.subscribe((snap) => searchEngineReceived.push(snap));

		await wt.scan();

		expect(treeReceived.length).toBe(2);
		expect(searchEngineReceived.length).toBe(2);
		expect(treeReceived[1]).toBe(searchEngineReceived[1]);

		unsub1();
		unsub2();
	});
});

describe("Pluggable snapshot strategy seam", () => {
	it("uses PolledSnapshotStrategy by default and delegates refresh to scan", async () => {
		const storage = createMockStorage({
			"/test-project/a.txt": "a"
		});
		const wt = new WorktreeClass(rootOrigin, { storage });

		expect(wt.strategy).toBeInstanceOf(PolledSnapshotStrategyClass);
		expect(wt.strategy.name).toBe("polled");

		await wt.refresh();
		expect(wt.entries.length).toBe(1);
		expect(wt.entries[0].name).toBe("a.txt");
	});

	it("accepts a custom snapshot strategy (e.g. desktop watcher seam)", async () => {
		const storage = createMockStorage({
			"/test-project/b.txt": "b"
		});
		let started = false;
		let stopped = false;
		let refreshed = false;

		const customStrategy = {
			name: "desktop-watcher",
			start: mock(() => {
				started = true;
			}),
			stop: mock(() => {
				stopped = true;
			}),
			refresh: mock(async (worktree: any) => {
				refreshed = true;
				await worktree.scan();
			})
		};

		const wt = new WorktreeClass(rootOrigin, {
			storage,
			strategy: customStrategy
		});

		expect(wt.strategy.name).toBe("desktop-watcher");

		await wt.refresh();
		expect(refreshed).toBe(true);
		expect(wt.entries.length).toBe(1);

		wt.dispose();
		expect(stopped).toBe(true);
	});
});

describe("File explorer renders from subscription, not from feeding entries in", () => {
	it("ProjectTree updates nodes via subscription when Worktree snapshot changes", async () => {
		const storage = createMockStorage({
			"/test-project/fileA.txt": "A",
			"/test-project/fileB.txt": "B"
		});
		const project: any = {
			hasRootPermission: true,
			rootOrigin,
			storage,
			persistence: {
				loadExpandedPaths: mock(async () => []),
				saveExpandedPaths: mock(async () => {})
			}
		};

		const tree = new ProjectTreeClass(project);
		const wt = tree.worktree!;
		expect(wt).toBeDefined();

		// Initially tree nodes are empty
		expect(tree.nodes).toEqual([]);

		// When scan is triggered on tree, tree delegates to worktree,
		// worktree updates snapshot, and tree receives nodes through subscription
		await tree.scan(rootOrigin);

		expect(tree.nodes.length).toBe(2);
		expect(wt.entries.length).toBe(2);
		expect(tree.nodes).toBe(wt.entries);

		// When worktree updates externally (simulating ticket 2 watcher update),
		// ProjectTree receives update through subscription automatically
		wt.updateSnapshot([]);
		expect(tree.nodes).toEqual([]);
	});
});
