import "../../../tests/contract/rune-setup";
import { describe, it, expect, mock, beforeAll } from "bun:test";
import type { FileOrigin } from "./storage";
import { createMockStorage } from "../../../tests/mock-storage";
import { MemorySessionPersistence } from "./persistence";
import type { VCSAdapter } from "./project/vcs";
import type { Workspace } from "./workspace.svelte";
import { DocumentSession } from "./document.svelte";

beforeAll(async () => {
	mock.module("svelte/reactivity", () => ({
		SvelteMap: Map,
		SvelteSet: Set
	}));
});

let makeWorkspace: (detected: boolean) => Promise<{ ws: Workspace }>;
let WorkspaceClass: typeof import("./workspace.svelte").Workspace;

beforeAll(async () => {
	const mod = await import("./workspace.svelte");
	WorkspaceClass = mod.Workspace;

	makeWorkspace = async (detected: boolean) => {
		const storage = createMockStorage({
			pickDirectory: async () => rootOrigin,
			verifyPermission: async () => true
		});
		const vcsFactory = (): VCSAdapter => ({
			detect: mock(async () => detected),
			getCurrentBranch: async () => "main",
			getBranches: async () => ["main"],
			getChanges: async () => [],
			getCommits: async () => [],
			getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
			switchBranch: mock(async () => ({ status: "switched" as const }))
		});
		const ws = new mod.Workspace(storage, vcsFactory, new MemorySessionPersistence());
		return { ws };
	};
});

const rootOrigin: FileOrigin = { scheme: "file", path: "/projects/np", name: "np" };
const fileOrigin: FileOrigin = { scheme: "file", path: "/projects/np/src/a.ts", name: "a.ts" };

describe("repository initialization respects VCS detect (issue #64)", () => {
	it("leaves workspace.repository null when the opened folder is not a git repository", async () => {
		const { ws } = await makeWorkspace(false);
		await ws.openDirectory();
		// Regression: previously the detect result was discarded and a Repository
		// was created unconditionally, so the Git panel's "No Git Repository"
		// empty state (guarded on repository === null) was unreachable.
		expect(ws.repository).toBeNull();
	});

	it("creates a Repository when the opened folder contains a git repository", async () => {
		const { ws } = await makeWorkspace(true);
		await ws.openDirectory();
		expect(ws.repository).not.toBeNull();
	});

	it("keeps repository null and scans project tree in requestRootPermission when the folder is not a git repository", async () => {
		const storage = createMockStorage({
			verifyPermission: async () => true
		});
		const vcsFactory = (): VCSAdapter => ({
			detect: mock(async () => false),
			getCurrentBranch: async () => "main",
			getBranches: async () => ["main"],
			getChanges: async () => [],
			getCommits: async () => [],
			getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
			switchBranch: mock(async () => ({ status: "switched" as const }))
		});
		const ws = new WorkspaceClass(storage, vcsFactory, new MemorySessionPersistence());
		ws.rootOrigin = rootOrigin;
		let scannedWith: FileOrigin | null = null;
		ws.projectTree.scan = mock(async (origin: FileOrigin) => {
			scannedWith = origin;
		});

		const granted = await ws.requestRootPermission();

		// Permission is granted, but because detect() reports no git repo, the
		// second repository-init path (requestRootPermission) must also leave
		// workspace.repository null (issue #64).
		expect(granted).toBe(true);
		expect(ws.repository).toBeNull();
		// Project tree scan must still execute so the file explorer is populated.
		expect(scannedWith).toEqual(rootOrigin);
	});

	it("scans project tree during session restore even when the folder is not a git repository", async () => {
		const storage = createMockStorage({
			queryPermission: async () => "granted"
		});
		const vcsFactory = (): VCSAdapter => ({
			detect: mock(async () => false),
			getCurrentBranch: async () => "main",
			getBranches: async () => ["main"],
			getChanges: async () => [],
			getCommits: async () => [],
			getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
			switchBranch: mock(async () => ({ status: "switched" as const }))
		});
		const persistence = new MemorySessionPersistence();
		await persistence.saveRootFolder(rootOrigin);

		const ws = new WorkspaceClass(storage, vcsFactory, persistence);
		let scannedWith: FileOrigin | null = null;
		ws.projectTree.scan = mock(async (origin: FileOrigin) => {
			scannedWith = origin;
		});

		await ws.restoreSession();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(ws.repository).toBeNull();
		expect(scannedWith).toEqual(rootOrigin);
	});
});

describe("branch switch preserves unsaved in-memory edits (issue #86)", () => {
	it("keeps modified document content across a successful switch and rebases its baseline", async () => {
		// New branch content for the open file; readFile returns this after switch.
		const newBranchContent = "new branch content\n";
		const oldSavedContent = "old committed content\n";
		const unsavedEdit = "my unsaved in-memory edit\n";

		const storage = createMockStorage({
			pickDirectory: async () => rootOrigin,
			verifyPermission: async () => true
		});
		storage.readFile = mock(async (o: FileOrigin) =>
			o.path === fileOrigin.path ? newBranchContent : ""
		);

		const vcsFactory = (): VCSAdapter => ({
			detect: mock(async () => true),
			getCurrentBranch: async () => "main",
			getBranches: async () => ["main"],
			getChanges: async () => [],
			getCommits: async () => [],
			getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
			switchBranch: mock(async () => ({ status: "switched" as const }))
		});

		const ws = new WorkspaceClass(storage, vcsFactory, new MemorySessionPersistence());
		await ws.openDirectory();

		// A modified document: saved baseline is the old content, in-memory content holds an edit.
		const doc = new DocumentSession(storage, oldSavedContent, fileOrigin, "a.ts", ws);
		doc.content = unsavedEdit;
		ws.documents.push(doc);
		expect(doc.isModified).toBe(true);

		await ws.switchBranch("feature");

		// The unsaved in-memory edit must survive the switch...
		expect(doc.content).toBe(unsavedEdit);
		// ...and is still treated as modified against the new on-disk baseline.
		expect(doc.isModified).toBe(true);
	});
});