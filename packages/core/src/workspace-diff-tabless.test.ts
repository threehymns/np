import "../../../tests/contract/rune-setup";
import { describe, it, expect, mock, beforeAll } from "bun:test";
import type { FileOrigin } from "./storage";
import { createMockStorage } from "../../../tests/mock-storage";
import { MemorySessionPersistence } from "./persistence";
import { Repository } from "./project/repository.svelte";
import type { VCSAdapter } from "./project/vcs";
import type { Workspace } from "./workspace.svelte";
import { DocumentSession } from "./document.svelte";
import { gitRegistration } from "./plugins/git/registration";
import { DIALOGS_SERVICE_KEY } from "./plugins/services";

beforeAll(async () => {
	mock.module("svelte/reactivity", () => ({
		SvelteMap: Map,
		SvelteSet: Set
	}));
});

let makeWorkspace: (
	storage: ReturnType<typeof createMockStorage>,
	factory: (root: FileOrigin) => VCSAdapter,
	persistence: MemorySessionPersistence
) => Promise<Workspace>;
beforeAll(async () => {
	const mod = await import("./workspace.svelte");
	const hostMod = await import("./plugins/host.svelte");
	// Repository lifecycle is owned by the Git Core Plugin (#202).
	makeWorkspace = async (storage, factory, persistence) => {
		const host = new hostMod.PluginHost();
		host.register(gitRegistration);
		host.provideService(DIALOGS_SERVICE_KEY, {
			alert: mock(async () => {}),
			confirm: mock(async () => true)
		});
		const ws = new mod.Workspace(storage, factory, persistence, host);
		await host.activate("git");
		return ws;
	};
});

const rootOrigin: FileOrigin = { scheme: "file", path: "/projects/np", name: "np" };
const fileOrigin: FileOrigin = { scheme: "file", path: "/projects/np/src/a.ts", name: "a.ts" };

function silentFactory(): (root: FileOrigin) => VCSAdapter {
	return () => ({
		detect: mock(async () => true),
		getCurrentBranch: async () => "main",
		getBranches: async () => ["main"],
		getChanges: async () => [],
		getCommits: async () => [],
		getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
		switchBranch: mock(async () => ({ status: "switched" as const }))
	});
}

function localStorage() {
	return createMockStorage({
		pickDirectory: async () => rootOrigin,
		verifyPermission: async () => true,
		queryPermission: async () => "granted"
	});
}

/** A tab-less bound Document, as ensureSplitDocument creates for the diff pane. */
function pushTablessDoc(ws: Workspace, storage: ReturnType<typeof createMockStorage>, content: string) {
	const doc = new DocumentSession(storage, content, fileOrigin, "a.ts");
	ws.documents.push(doc);
	return doc;
}

describe("tab-less diff bound Documents (issue #272)", () => {
	it("openFile adopts the tab-less bound Document and opens a tab for it", async () => {
		const storage = localStorage();
		storage.readFile = mock(async () => "disk content\n");
		const ws = await makeWorkspace(storage, silentFactory(), new MemorySessionPersistence());
		const bound = pushTablessDoc(ws, storage, "disk content\n");
		ws.updateDocumentContent(bound, "unsaved pane edits\n");

		const opened = await ws.openFile(fileOrigin);

		expect(opened).toBe(bound);
		// The file now has a real tab instead of a dangling active id.
		expect(ws.tabs.some((t) => t.id === bound.id && t.type === "document")).toBe(true);
		expect(ws.activeTabId).toBe(bound.id);
		// Still a single truth: no duplicate Document was created.
		expect(ws.documents.filter((d) => d.id === bound.id)).toHaveLength(1);
		expect(opened!.content).toBe("unsaved pane edits\n");
	});

	it("persists a dirty tab-less Document draft so pane edits survive a restart", async () => {
		const persistence = new MemorySessionPersistence();
		const ws = await makeWorkspace(localStorage(), silentFactory(), persistence);
		await ws.restoreSession();
		const doc = pushTablessDoc(ws, localStorage(), "disk content\n");
		ws.updateDocumentContent(doc, "unsaved pane edits\n");

		await ws.flushSaveOpenFiles();

		const saved = await persistence.loadOpenFiles("");
		const entry = saved.find((d) => d.id === doc.id);
		expect(entry).toBeDefined();
		expect(entry?.draftContent).toBe("unsaved pane edits\n");
		expect(entry?.tabless).toBe(true);
		expect(entry?.origin).toEqual(fileOrigin);
	});

	it("omits clean tab-less Documents, which the next diff load re-derives", async () => {
		const persistence = new MemorySessionPersistence();
		const ws = await makeWorkspace(localStorage(), silentFactory(), persistence);
		await ws.restoreSession();
		const doc = pushTablessDoc(ws, localStorage(), "disk content\n");
		expect(doc.isModified).toBe(false);

		await ws.flushSaveOpenFiles();

		const saved = await persistence.loadOpenFiles("");
		expect(saved.find((d) => d.id === doc.id)).toBeUndefined();
	});

	it("restores a tab-less draft as a Document with no tab", async () => {
		const persistence = new MemorySessionPersistence();
		const storage = localStorage();
		storage.readFile = mock(async () => "disk content\n");
		const folderUri = "file:///projects/np";
		await persistence.saveRootFolder(rootOrigin);
		await persistence.saveOpenFiles(
			[
				{
					id: "tabless-diff-doc",
					origin: fileOrigin,
					draftContent: "unsaved pane edits\n",
					tabless: true
				}
			],
			folderUri
		);

		const ws = await makeWorkspace(storage, silentFactory(), persistence);
		await ws.openDirectory(rootOrigin);

		const doc = ws.documents.find((d) => d.id === "tabless-diff-doc");
		expect(doc).toBeDefined();
		expect(doc!.content).toBe("unsaved pane edits\n");
		expect(doc!.isModified).toBe(true);
		expect(ws.tabs.some((t) => t.id === "tabless-diff-doc")).toBe(false);
	});

	it("drops the persisted draft after the tab-less Document is saved", async () => {
		const persistence = new MemorySessionPersistence();
		const disk = new Map<string, string>([[fileOrigin.path, "disk content\n"]]);
		const storage = localStorage();
		storage.readFile = mock(async (origin: FileOrigin) => {
			const content = disk.get(origin.path);
			if (content === undefined) {
				const err = new Error("not found") as any;
				err.code = "ENOENT";
				throw err;
			}
			return content;
		}) as any;
		storage.saveFile = mock(async (content: string, existingOrigin?: FileOrigin) => {
			const origin = existingOrigin ?? fileOrigin;
			disk.set(origin.path, content);
			return origin;
		}) as any;
		const ws = await makeWorkspace(storage, silentFactory(), persistence);
		await ws.restoreSession();
		ws.project.rootOrigin = rootOrigin;
		ws.project.hasRootPermission = true;
		const doc = pushTablessDoc(ws, storage, "disk content\n");
		ws.updateDocumentContent(doc, "pane edits to save\n");
		await ws.flushSaveOpenFiles();
		const folderUri = "file:///projects/np";
		expect((await persistence.loadOpenFiles(folderUri)).find((d) => d.id === doc.id)?.draftContent).toBe(
			"pane edits to save\n"
		);

		expect(await ws.saveDocument(doc)).toBe(true);

		await ws.flushSaveOpenFiles();
		const saved = await persistence.loadOpenFiles(folderUri);
		expect(saved.find((d) => d.id === doc.id)).toBeUndefined();
		expect(disk.get(fileOrigin.path)).toBe("pane edits to save\n");
	});

	it("includes a dirty tab-less diff pane in the branch safety report", async () => {
		const ws = await makeWorkspace(localStorage(), silentFactory(), new MemorySessionPersistence());
		ws.project.rootOrigin = rootOrigin;
		ws.project.hasRootPermission = true;
		ws.project.repository = new Repository(rootOrigin, silentFactory());
		ws.project.repositoryOwnerId = "git";
		const doc = pushTablessDoc(ws, localStorage(), "disk content\n");
		ws.updateDocumentContent(doc, "unsaved pane edits\n");

		const report = await ws.getBranchSafetyReport("feature");

		expect(report).not.toBeNull();
		expect(report!.canSwitch).toBe(false);
		expect(report!.unsavedFiles).toContain("src/a.ts");
	});

	it("switchBranch preserves a dirty tab-less diff pane and rebases its baseline", async () => {
		const newBranchContent = "new branch content\n";
		const storage = localStorage();
		storage.readFile = mock(async () => newBranchContent);
		const ws = await makeWorkspace(storage, silentFactory(), new MemorySessionPersistence());
		ws.project.rootOrigin = rootOrigin;
		ws.project.hasRootPermission = true;
		ws.project.repository = new Repository(rootOrigin, silentFactory());
		ws.project.repositoryOwnerId = "git";
		ws.project.projectTree.scan = mock(async () => {});
		const doc = pushTablessDoc(ws, storage, "old committed content\n");
		ws.updateDocumentContent(doc, "unsaved pane edits\n");

		const result = await ws.switchBranch("feature");

		expect(result.status).toBe("switched");
		expect(doc.content).toBe("unsaved pane edits\n");
		expect(doc.isModified).toBe(true);
	});

	it("switchBranch reloads a clean tab-less diff pane with the checked-out content", async () => {
		const newBranchContent = "new branch content\n";
		const storage = localStorage();
		storage.readFile = mock(async () => newBranchContent);
		const ws = await makeWorkspace(storage, silentFactory(), new MemorySessionPersistence());
		ws.project.rootOrigin = rootOrigin;
		ws.project.hasRootPermission = true;
		ws.project.repository = new Repository(rootOrigin, silentFactory());
		ws.project.repositoryOwnerId = "git";
		ws.project.projectTree.scan = mock(async () => {});
		const doc = pushTablessDoc(ws, storage, "old committed content\n");
		expect(doc.isModified).toBe(false);

		await ws.switchBranch("feature");

		expect(doc.content).toBe(newBranchContent);
		expect(doc.isModified).toBe(false);
	});
});
