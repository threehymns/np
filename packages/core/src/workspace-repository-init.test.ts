import "../../../tests/contract/rune-setup";
import { describe, it, expect, mock, beforeAll } from "bun:test";
import type { FileOrigin } from "./storage";
import { createMockStorage } from "../../../tests/mock-storage";
import { MemorySessionPersistence } from "./persistence";
import type { VCSAdapter } from "./project/vcs";
import type { Workspace } from "./workspace.svelte";
import { DocumentSession } from "./document.svelte";
import { CommandRegistry, registerCoreCommands } from "./commands.svelte";

beforeAll(async () => {
	mock.module("svelte/reactivity", () => ({
		SvelteMap: Map,
		SvelteSet: Set
	}));
});

let makeWorkspace: (
	detected: boolean
) => Promise<{ ws: Workspace }>;
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

describe("Workspace.initializeRepository action (ticket #118)", () => {
	it("refuses cleanly and returns false when no rootOrigin is open", async () => {
		let factoryCalled = false;
		const storage = createMockStorage({});
		const vcsFactory = (): VCSAdapter => {
			factoryCalled = true;
			return {
				detect: mock(async () => false),
				getCurrentBranch: async () => "main",
				getBranches: async () => ["main"],
				getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
				switchBranch: mock(async () => ({ status: "switched" as const }))
			};
		};
		const ws = new WorkspaceClass(storage, vcsFactory, new MemorySessionPersistence());
		ws.rootOrigin = null;
		ws.hasRootPermission = true;

		const result = await ws.initializeRepository();
		expect(result).toBe(false);
		expect(ws.repository).toBeNull();
		expect(factoryCalled).toBe(false);
	});

	it("refuses cleanly and returns false when hasRootPermission is false", async () => {
		let factoryCalled = false;
		const storage = createMockStorage({});
		const vcsFactory = (): VCSAdapter => {
			factoryCalled = true;
			return {
				detect: mock(async () => false),
				getCurrentBranch: async () => "main",
				getBranches: async () => ["main"],
				getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
				switchBranch: mock(async () => ({ status: "switched" as const }))
			};
		};
		const ws = new WorkspaceClass(storage, vcsFactory, new MemorySessionPersistence());
		ws.rootOrigin = rootOrigin;
		ws.hasRootPermission = false;

		const result = await ws.initializeRepository();
		expect(result).toBe(false);
		expect(ws.repository).toBeNull();
		expect(factoryCalled).toBe(false);
	});

	it("initializes repository, refreshes metadata, and rescans project tree on success", async () => {
		let initPath: string | undefined;
		const storage = createMockStorage({});
		const vcsFactory = (): VCSAdapter => ({
			detect: mock(async () => true),
			init: mock(async (path?: string) => {
				initPath = path;
			}),
			getCurrentBranch: async () => "main",
			getBranches: async () => ["main"],
			getChanges: async () => [],
			getCommits: async () => [],
			getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
			switchBranch: mock(async () => ({ status: "switched" as const }))
		});
		const ws = new WorkspaceClass(storage, vcsFactory, new MemorySessionPersistence());
		ws.rootOrigin = rootOrigin;
		ws.hasRootPermission = true;

		let scannedOrigin: FileOrigin | null = null;
		ws.projectTree.scan = mock(async (origin: FileOrigin) => {
			scannedOrigin = origin;
		});

		const result = await ws.initializeRepository();

		expect(result).toBe(true);
		expect(initPath).toBe(rootOrigin.path);
		expect(ws.repository).not.toBeNull();
		expect(ws.repository?.currentBranch).toBe("main");
		expect(scannedOrigin).toEqual(rootOrigin);
	});

	it("clears stale repository before asynchronous initialization starts", async () => {
		let repoClearedBeforeInit = false;
		let resolveInit!: () => void;
		const initPromise = new Promise<void>((r) => (resolveInit = r));

		const storage = createMockStorage({});
		const ws = new WorkspaceClass(
			storage,
			(): VCSAdapter => ({
				detect: mock(async () => true),
				init: mock(async () => {
					repoClearedBeforeInit = ws.repository === null;
					await initPromise;
				}),
				getCurrentBranch: async () => "main",
				getBranches: async () => ["main"],
				getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
				switchBranch: mock(async () => ({ status: "switched" as const }))
			}),
			new MemorySessionPersistence()
		);
		ws.rootOrigin = rootOrigin;
		ws.hasRootPermission = true;

		// Set a pre-existing fake repository
		ws.repository = { currentBranch: "old-branch" } as any;

		const initTask = ws.initializeRepository();
		await new Promise((resolve) => setTimeout(resolve, 0));

		// Stale repository must be cleared immediately
		expect(ws.repository).toBeNull();

		resolveInit();
		await initTask;

		expect(repoClearedBeforeInit).toBe(true);
		expect(ws.repository).not.toBeNull();
	});

	it("throws and leaves repository null when VCS adapter lacks init capability", async () => {
		const storage = createMockStorage({});
		const vcsFactory = (): VCSAdapter => ({
			detect: mock(async () => false),
			// init is omitted
			getCurrentBranch: async () => "main",
			getBranches: async () => ["main"],
			getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
			switchBranch: mock(async () => ({ status: "switched" as const }))
		});
		const ws = new WorkspaceClass(storage, vcsFactory, new MemorySessionPersistence());
		ws.rootOrigin = rootOrigin;
		ws.hasRootPermission = true;
		ws.repository = { currentBranch: "stale" } as any;

		await expect(ws.initializeRepository()).rejects.toThrow(
			"VCS adapter does not support repository initialization"
		);
		expect(ws.repository).toBeNull();
	});

	it("throws and leaves repository null when adapter init rejects", async () => {
		const storage = createMockStorage({});
		const vcsFactory = (): VCSAdapter => ({
			detect: mock(async () => false),
			init: mock(async () => {
				throw new Error("Filesystem write permission denied");
			}),
			getCurrentBranch: async () => "main",
			getBranches: async () => ["main"],
			getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
			switchBranch: mock(async () => ({ status: "switched" as const }))
		});
		const ws = new WorkspaceClass(storage, vcsFactory, new MemorySessionPersistence());
		ws.rootOrigin = rootOrigin;
		ws.hasRootPermission = true;
		ws.repository = { currentBranch: "stale" } as any;

		await expect(ws.initializeRepository()).rejects.toThrow("Filesystem write permission denied");
		expect(ws.repository).toBeNull();
	});

	it("throws and leaves repository null when repo.refresh or scan rejects", async () => {
		const storage = createMockStorage({});
		const vcsFactory = (): VCSAdapter => ({
			detect: mock(async () => true),
			init: mock(async () => {}),
			getCurrentBranch: async () => {
				throw new Error("Corrupted repository state");
			},
			getBranches: async () => ["main"],
			getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
			switchBranch: mock(async () => ({ status: "switched" as const }))
		});
		const ws = new WorkspaceClass(storage, vcsFactory, new MemorySessionPersistence());
		ws.rootOrigin = rootOrigin;
		ws.hasRootPermission = true;
		ws.projectTree.scan = mock(async () => {
			throw new Error("Project tree scan failure");
		});

		await expect(ws.initializeRepository()).rejects.toThrow("Project tree scan failure");
		expect(ws.repository).toBeNull();
	});

	it("registers git.init command and delegates to workspace.initializeRepository", async () => {
		const commands = new CommandRegistry();
		let initCalled = false;
		const mockWorkspace = {
			initializeRepository: mock(async () => {
				initCalled = true;
				return true;
			})
		};
		const alerts: string[] = [];
		const appState = {
			commands,
			workspace: mockWorkspace,
			dialogService: {
				alert: mock(async (msg: string) => {
					alerts.push(msg);
				})
			}
		} as any;

		registerCoreCommands(appState);

		const cmd = commands.get("git.init");
		expect(cmd).toBeDefined();
		expect(cmd?.label).toBe("Git: Initialize Repository");
		expect(cmd?.category).toBe("Source Control");

		const result = await commands.execute("git.init");
		expect(result).toBe(true);
		expect(initCalled).toBe(true);
	});

	it("git.init command handles failure and displays alert dialog", async () => {
		const commands = new CommandRegistry();
		const mockWorkspace = {
			initializeRepository: mock(async () => {
				throw new Error("Initialization failed: disk full");
			})
		};
		const alerts: string[] = [];
		const appState = {
			commands,
			workspace: mockWorkspace,
			dialogService: {
				alert: mock(async (msg: string) => {
					alerts.push(msg);
				})
			}
		} as any;

		registerCoreCommands(appState);

		const result = await commands.execute("git.init");
		expect(result).toBe(false);
		expect(alerts).toEqual(["Failed to initialize repository: Initialization failed: disk full"]);
	});
});

describe("branch switch preserves unsaved in-memory edits (issue #86)", () => {
	const makeSwitchWs = async (readFile: (o: FileOrigin) => Promise<string>) => {
		const storage = createMockStorage({
			pickDirectory: async () => rootOrigin,
			verifyPermission: async () => true
		});
		storage.readFile = mock(readFile);
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
		return { storage, ws };
	};

	it("keeps modified document content across a successful switch and rebases its baseline", async () => {
		// New branch content for the open file; readFile returns this after switch.
		const newBranchContent = "new branch content\n";
		const oldSavedContent = "old committed content\n";
		const unsavedEdit = "my unsaved in-memory edit\n";

		const { storage, ws } = await makeSwitchWs(async (o: FileOrigin) =>
			o.path === fileOrigin.path ? newBranchContent : ""
		);

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

	it("reloads unmodified documents with the checked-out content after a switch", async () => {
		const oldSavedContent = "old committed content\n";
		const newBranchContent = "new branch content\n";

		const { storage, ws } = await makeSwitchWs(async (o: FileOrigin) =>
			o.path === fileOrigin.path ? newBranchContent : ""
		);

		// Unmodified document: content matches its saved baseline.
		const doc = new DocumentSession(storage, oldSavedContent, fileOrigin, "a.ts", ws);
		ws.documents.push(doc);
		expect(doc.isModified).toBe(false);

		await ws.switchBranch("feature");

		// Unmodified documents reload the checked-out (new branch) content.
		expect(doc.content).toBe(newBranchContent);
		expect(doc.isModified).toBe(false);
	});

	it("preserves edits and marks deletedOnDisk when a modified file is gone after a switch", async () => {
		const unsavedEdit = "my unsaved in-memory edit\n";
		// The file no longer exists on disk after the switch (e.g. removed on the target branch).
		const { storage, ws } = await makeSwitchWs(async (o: FileOrigin) => {
			if (o.path === fileOrigin.path) {
				const err: any = new Error("not found");
				err.name = "NotFoundError";
				throw err;
			}
			return "";
		});

		const doc = new DocumentSession(storage, "old committed content\n", fileOrigin, "a.ts", ws);
		doc.content = unsavedEdit; // in-memory-only edit
		ws.documents.push(doc);
		expect(doc.isModified).toBe(true);

		await ws.switchBranch("feature");

		// The unsaved edit is preserved even though the file vanished, and the
		// session reflects the file is gone on disk rather than silently loading.
		expect(doc.content).toBe(unsavedEdit);
		expect(doc.deletedOnDisk).toBe(true);
		expect(doc.isModified).toBe(true);
	});
});
