import "../../../tests/contract/rune-setup";
import { describe, it, expect, mock, beforeAll } from "bun:test";
import type { FileOrigin } from "./storage";
import { createMockStorage } from "../../../tests/mock-storage";
import { MemorySessionPersistence } from "./persistence";
import { Repository } from "./project/repository.svelte";
import type { VCSAdapter, GitChange } from "./project/vcs";
import type { Workspace } from "./workspace.svelte";

beforeAll(async () => {
	mock.module("svelte/reactivity", () => ({
		SvelteMap: Map,
		SvelteSet: Set
	}));
});

let makeWorkspace: (storage: ReturnType<typeof createMockStorage>, factory: (root: FileOrigin) => VCSAdapter, persistence: MemorySessionPersistence) => Workspace;
beforeAll(async () => {
	const mod = await import("./workspace.svelte");
	makeWorkspace = (storage, factory, persistence) => new mod.Workspace(storage, factory, persistence);
});

const rootOrigin: FileOrigin = { scheme: "file", path: "/projects/np", name: "np" };

function makeChange(filepath: string, staged: boolean): GitChange {
	return {
		filepath,
		status: "M",
		additions: 1,
		deletions: 0,
		diff: "",
		staged
	};
}

function createVcsFactory(changes: GitChange[]): (root: FileOrigin) => VCSAdapter {
	return () => ({
		detect: mock(async () => {}),
		getCurrentBranch: async () => "main",
		getBranches: async () => ["main"],
		getChanges: async () => changes,
		getCommits: async () => [],
		getStatus: async () => ({ isDirty: changes.length > 0, uncommittedFiles: [...new Set(changes.map(c => c.filepath))] }),
		switchBranch: mock(async () => ({ status: "switched" as const }))
	});
}

function createLocalMockStorage() {
	return createMockStorage({
		pickDirectory: async () => rootOrigin,
		verifyPermission: async () => true,
		queryPermission: async () => "granted"
	});
}

describe("diff tab session persistence", () => {
	it("serializes the active diff file's filepath and staged scope", async () => {
		const persistence = new MemorySessionPersistence();
		const ws = makeWorkspace(createLocalMockStorage(), createVcsFactory([]), persistence);
		await ws.restoreSession();

		ws.repository = new Repository(rootOrigin, createVcsFactory([]));
		ws.repository.changes = [makeChange("src/a.ts", false), makeChange("docs/b.md", true)];
		ws.repository.activeDiffFile = ws.repository.changes[1];
		ws.tabs.push({ id: "__project_diff__", type: "diff" });

		ws.flushSaveOpenFiles();

		const saved = await persistence.loadOpenFiles("");
		const diffEntry = saved.find(d => d.virtualTabType === "diff");
		expect(diffEntry).toBeDefined();
		expect(diffEntry?.diffFilepath).toBe("docs/b.md");
		expect(diffEntry?.diffStaged).toBe(true);
	});

	it("restores the persisted diff selection into Repository.activeDiffFile on folder reload", async () => {
		const persistence = new MemorySessionPersistence();
		const storage = createLocalMockStorage();
		const factory = createVcsFactory([makeChange("src/a.ts", false), makeChange("docs/b.md", true)]);
		const ws = makeWorkspace(storage, factory, persistence);

		const folderUri = "file:///projects/np";
		await persistence.saveOpenFiles(
			[
				{ id: "__project_diff__", origin: null, isModified: false, virtualTabType: "diff", diffFilepath: "docs/b.md", diffStaged: true }
			],
			folderUri
		);
		await persistence.saveActiveDocumentId("__project_diff__", folderUri);

		await ws.openDirectory(rootOrigin);

		expect(ws.repository).not.toBeNull();
		expect(ws.tabs.some(t => t.type === "diff")).toBe(true);
		expect(ws.repository!.activeDiffFile?.filepath).toBe("docs/b.md");
		expect(ws.repository!.activeDiffFile?.staged).toBe(true);
	});

	it("falls back to filepath match when the persisted scope no longer exists", async () => {
		const persistence = new MemorySessionPersistence();
		const storage = createLocalMockStorage();
		const factory = createVcsFactory([makeChange("src/a.ts", false), makeChange("docs/b.md", false)]);
		const ws = makeWorkspace(storage, factory, persistence);

		const folderUri = "file:///projects/np";
		await persistence.saveOpenFiles(
			[
				{ id: "__project_diff__", origin: null, isModified: false, virtualTabType: "diff", diffFilepath: "docs/b.md", diffStaged: true }
			],
			folderUri
		);

		await ws.openDirectory(rootOrigin);

		expect(ws.tabs.some(t => t.type === "diff")).toBe(true);
		// Persisted scope (staged) is gone; falls back to the filepath,
		// which is NOT refresh's default first change (src/a.ts).
		expect(ws.repository!.activeDiffFile?.filepath).toBe("docs/b.md");
		expect(ws.repository!.activeDiffFile?.staged).toBe(false);
	});

	it("keeps selections independent across multiple persisted diff tabs", async () => {
		const persistence = new MemorySessionPersistence();
		const storage = createLocalMockStorage();
		// Only docs/b.md exists anymore; the second tab's persisted selection
		// ("src/gone.ts") is stale. docs/b.md is deliberately NOT the first
		// change, so refresh's default first-change fallback can't mask the
		// outcome.
		const factory = createVcsFactory([makeChange("other/c.ts", false), makeChange("docs/b.md", true)]);
		const ws = makeWorkspace(storage, factory, persistence);

		const folderUri = "file:///projects/np";
		await persistence.saveOpenFiles(
			[
				{ id: "__project_diff__", origin: null, isModified: false, virtualTabType: "diff", diffFilepath: "docs/b.md", diffStaged: true },
				{ id: "__project_diff_2__", origin: null, isModified: false, virtualTabType: "diff", diffFilepath: "src/gone.ts", diffStaged: false }
			],
			folderUri
		);

		await ws.openDirectory(rootOrigin);

		expect(ws.tabs.filter(t => t.type === "diff").map(t => t.id)).toEqual(["__project_diff__", "__project_diff_2__"]);
		// A later diff tab's stale selection must not destroy an earlier tab's
		// still-resolvable selection: entries resolve per tab, unresolvable
		// ones are dropped, resolvable ones are applied.
		expect(ws.repository!.activeDiffFile?.filepath).toBe("docs/b.md");
		expect(ws.repository!.activeDiffFile?.staged).toBe(true);
	});

	it("restores the persisted diff selection when the change list finishes loading after session state", async () => {
		const persistence = new MemorySessionPersistence();
		const storage = createLocalMockStorage();

		let resolveChanges!: () => void;
		const changesPending = new Promise<void>((resolve) => {
			resolveChanges = resolve;
		});
		const base = createVcsFactory([makeChange("src/a.ts", false), makeChange("docs/b.md", true)])(rootOrigin);
		const slowAdapter: VCSAdapter = {
			...base,
			getChanges: async () => {
				await changesPending;
				return [makeChange("src/a.ts", false), makeChange("docs/b.md", true)];
			}
		};

		const folderUri = "file:///projects/np";
		await persistence.saveRootFolder(rootOrigin);
		await persistence.saveOpenFiles(
			[
				{ id: "__project_diff__", origin: null, isModified: false, virtualTabType: "diff", diffFilepath: "docs/b.md", diffStaged: true }
			],
			folderUri
		);
		await persistence.saveActiveDocumentId("__project_diff__", folderUri);

		const ws = makeWorkspace(storage, () => slowAdapter, persistence);

		// restoreSession hands back once session state loads; repository.refresh()
		// is still blocked on getChanges at this point.
		await ws.restoreSession();

		resolveChanges!();
		for (let i = 0; i < 50 && !ws.repository?.activeDiffFile; i++) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		// The persisted selection must win over refresh's default first change.
		expect(ws.repository!.activeDiffFile?.filepath).toBe("docs/b.md");
		expect(ws.repository!.activeDiffFile?.staged).toBe(true);
	});
});
