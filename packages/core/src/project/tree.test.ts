import "../../../../tests/contract/rune-setup";
import { describe, it, expect, mock, beforeAll } from "bun:test";
import type { FileOrigin } from "../storage";
import { toURI } from "../storage";

let ProjectTreeClass: typeof import("./tree.svelte").ProjectTree;

beforeAll(async () => {
	mock.module("svelte/reactivity", () => ({
		SvelteMap: Map,
		SvelteSet: Set
	}));

	const mod = await import("./tree.svelte");
	ProjectTreeClass = mod.ProjectTree;
});

const folderA: FileOrigin = { scheme: "file", path: "/folder-a", name: "folder-a" };
const folderB: FileOrigin = { scheme: "file", path: "/folder-b", name: "folder-b" };

function createMockWorkspace(currentRoot: FileOrigin | null = folderA) {
	const storage = {
		readFile: mock(async (origin: FileOrigin) => {
			if (origin.name === ".gitignore") return "*.log\n";
			return "content";
		}),
		readDirectory: mock(async (origin: FileOrigin) => {
			if (toURI(origin) === toURI(folderA)) {
				return [
					{ name: "fileA.txt", kind: "file" as const, origin: { scheme: "file", path: "/folder-a/fileA.txt", name: "fileA.txt" } }
				];
			}
			if (toURI(origin) === toURI(folderB)) {
				return [
					{ name: "fileB.txt", kind: "file" as const, origin: { scheme: "file", path: "/folder-b/fileB.txt", name: "fileB.txt" } }
				];
			}
			return [];
		})
	};

	const ws: any = {
		hasRootPermission: true,
		rootOrigin: currentRoot,
		storage,
		persistence: {
			loadExpandedPaths: mock(async () => []),
			saveExpandedPaths: mock(async () => {})
		}
	};

	return ws;
}

describe("ProjectTree single-child collapse", () => {
	const root: FileOrigin = { scheme: "file", path: "/proj", name: "proj" };

	function createChainWorkspace() {
		const storage = {
			readFile: mock(async () => {
				throw { name: "NotFoundError" };
			}),
			readDirectory: mock(async (origin: FileOrigin) => {
				if (origin.path === "/proj") {
					return [
						{ name: "a", kind: "directory" as const, origin: { scheme: "file", path: "/proj/a", name: "a" } },
					];
				}
				if (origin.path === "/proj/a") {
					return [
						{ name: "b", kind: "directory" as const, origin: { scheme: "file", path: "/proj/a/b", name: "b" } },
					];
				}
				if (origin.path === "/proj/a/b") {
					return [
						{ name: "c", kind: "directory" as const, origin: { scheme: "file", path: "/proj/a/b/c", name: "c" } },
					];
				}
				if (origin.path === "/proj/a/b/c") {
					return [
						{ name: "file1.txt", kind: "file" as const, origin: { scheme: "file", path: "/proj/a/b/c/file1.txt", name: "file1.txt" } },
						{ name: "file2.txt", kind: "file" as const, origin: { scheme: "file", path: "/proj/a/b/c/file2.txt", name: "file2.txt" } },
					];
				}
				return [];
			}),
			createFile: mock(async () => {}),
			createDirectory: mock(async () => {}),
			deleteEntry: mock(async () => {}),
			renameEntry: mock(async (o: FileOrigin) => o),
		};

		const ws: any = {
			hasRootPermission: true,
			rootOrigin: root,
			storage,
			documents: [],
			persistence: {
				loadExpandedPaths: mock(async () => []),
				saveExpandedPaths: mock(async () => {})
			}
		};

		return ws;
	}

	it("one click opens a 3-deep single-child chain with grandchildren visible", async () => {
		const ws = createChainWorkspace();
		const tree = new ProjectTreeClass(ws);
		await tree.scan(root);

		// Single click on top-level "a" must resolve the whole spine eagerly
		const nodeA = tree.nodes.find((n) => n.name === "a")!;
		await tree.toggleExpand(nodeA);

		const visual = (tree as any).visualNodes;
		const chain = visual.find((v: any) => v.name === "a/b/c")!;
		expect(chain).toBeDefined();
		expect(chain.isExpanded).toBe(true);
		expect(chain.children?.map((c: any) => c.name).sort()).toEqual(["file1.txt", "file2.txt"]);
		// Fold metadata: one entry per level, original first, leaf last
		expect(chain.chain.map((n: any) => n.name)).toEqual(["a", "b", "c"]);
		expect(chain.originalNode).toBe(chain.chain[0]);
		expect(chain.leafNode).toBe(chain.chain[chain.chain.length - 1]);
		// Spine reads stay cheap: one per level + the fork read
		expect(ws.storage.readDirectory.mock.calls.length).toBeLessThanOrEqual(4);
	});

	it("toggling a collapsed visual row still targets the leaf", async () => {
		const ws = createChainWorkspace();
		const tree = new ProjectTreeClass(ws);
		await tree.scan(root);

		const nodeA = tree.nodes.find((n) => n.name === "a")!;
		await tree.toggleExpand(nodeA);

		// Collapse via the visual row, then re-expand via the visual row:
		// both must flip chevron AND children together on a single click.
		let visual = (tree as any).visualNodes;
		await tree.toggleVisualExpand(visual.find((v: any) => v.name === "a/b/c")!);
		visual = (tree as any).visualNodes;
		expect(visual.find((v: any) => v.name === "a/b/c")!.isExpanded).toBe(false);

		visual = (tree as any).visualNodes;
		await tree.toggleVisualExpand(visual.find((v: any) => v.name === "a/b/c")!);
		visual = (tree as any).visualNodes;
		const expanded = visual.find((v: any) => v.name === "a/b/c")!;
		expect(expanded.isExpanded).toBe(true);
		expect(expanded.children?.map((c: any) => c.name).sort()).toEqual(["file1.txt", "file2.txt"]);
		// Chain ancestor stays expanded so the collapse is still discoverable
		expect(expanded.originalNode.isExpanded).toBe(true);
	});

	it("collapsing keeps the chain discoverable across rescan", async () => {
		const ws = createChainWorkspace();
		const tree = new ProjectTreeClass(ws);
		await tree.scan(root);

		const nodeA = tree.nodes.find((n) => n.name === "a")!;
		await tree.toggleExpand(nodeA);

		// Collapse via the visual row
		let visual = (tree as any).visualNodes;
		await tree.toggleVisualExpand(visual.find((v: any) => v.name === "a/b/c")!);
		visual = (tree as any).visualNodes;
		expect(visual.find((v: any) => v.name === "a/b/c")!.isExpanded).toBe(false);

		// Rescan (as after rename/delete) must still show collapsed "a/b/c"
		await tree.scan(root);
		visual = (tree as any).visualNodes;
		expect(visual.find((v: any) => v.name === "a/b/c")).toBeDefined();
		expect(visual.find((v: any) => v.name === "a/b/c")!.isExpanded).toBe(false);
	});
});

describe("ProjectTree.scan", () => {
	it("scans and commits nodes when root has not changed", async () => {
		const ws = createMockWorkspace(folderA);
		const tree = new ProjectTreeClass(ws);

		await tree.scan(folderA);

		expect(tree.nodes.length).toBe(1);
		expect(tree.nodes[0].name).toBe("fileA.txt");
	});

	it("discards scan results if workspace rootOrigin changes before scan completes", async () => {
		const ws = createMockWorkspace(folderA);
		let resolveReadDir!: (val: any) => void;
		const readDirPromise = new Promise<any>((resolve) => {
			resolveReadDir = resolve;
		});

		ws.storage.readDirectory = mock(async (origin: FileOrigin) => {
			if (toURI(origin) === toURI(folderA)) {
				await readDirPromise;
				return [
					{ name: "fileA.txt", kind: "file" as const, origin: { scheme: "file", path: "/folder-a/fileA.txt", name: "fileA.txt" } }
				];
			}
			return [];
		});

		const tree = new ProjectTreeClass(ws);
		const scanPromise = tree.scan(folderA);

		await new Promise((r) => setTimeout(r, 0));

		// Root switched while scan of folderA was deferred
		ws.rootOrigin = folderB;
		tree.nodes = [];

		resolveReadDir([
			{ name: "fileA.txt", kind: "file" as const, origin: { scheme: "file", path: "/folder-a/fileA.txt", name: "fileA.txt" } }
		]);
		await scanPromise;

		// Nodes must NOT be overwritten by the stale scan
		expect(tree.nodes).toEqual([]);
	});
});
