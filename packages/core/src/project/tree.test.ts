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
