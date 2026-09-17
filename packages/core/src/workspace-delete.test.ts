import "../../../tests/contract/rune-setup";
import { describe, it, expect, mock, beforeAll } from "bun:test";
import type { FileOrigin } from "./storage";
import { toURI } from "./storage";
import { DocumentSession } from "./document.svelte";
import { createMockStorage } from "../../../tests/mock-storage";
import { MemorySessionPersistence } from "./persistence";
import type { VCSAdapter } from "./project/vcs";
import type { Workspace } from "./workspace.svelte";

beforeAll(async () => {
	mock.module("svelte/reactivity", () => ({
		SvelteMap: Map,
		SvelteSet: Set
	}));
});

let WorkspaceClass: typeof import("./workspace.svelte").Workspace;

beforeAll(async () => {
	const mod = await import("./workspace.svelte");
	WorkspaceClass = mod.Workspace;
});

const rootOrigin: FileOrigin = { scheme: "file", path: "/projects/np", name: "np" };
const fileOrigin: FileOrigin = { scheme: "file", path: "/projects/np/src/a.ts", name: "a.ts" };

// Drains pending microtasks (e.g. a restoreDraft baseline read's `.then`)
// deterministically, without relying on timer scheduling.
async function flushMicrotasks(times = 10) {
	for (let i = 0; i < times; i++) {
		await Promise.resolve();
	}
}

function makeVcsFactory(): (rootOrigin: FileOrigin) => VCSAdapter {
	return (): VCSAdapter =>
		({
			detect: mock(async () => false),
			getCurrentBranch: async () => "main",
			getBranches: async () => ["main"],
			getChanges: async () => [],
			getCommits: async () => [],
			getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
			switchBranch: mock(async () => ({ status: "switched" as const }))
		}) as unknown as VCSAdapter;
}

async function makeWsWithOpenFile(
	diskContent = "committed content\n",
	existingOrigin: FileOrigin = fileOrigin
): Promise<{ ws: Workspace; doc: NonNullable<Awaited<ReturnType<Workspace["openFile"]>>>; storage: any }> {
	const storage = createMockStorage({
		pickDirectory: async () => rootOrigin,
		verifyPermission: async () => true
	});
	storage.readFile = mock(async () => diskContent);
	storage.readDirectory = mock(async () => []);
	const ws = new WorkspaceClass(storage, makeVcsFactory(), new MemorySessionPersistence());
	await ws.openDirectory();
	// openDirectory restores an untitled doc when persistence is empty; drop
	// it so the test owns exactly the tabs it opens.
	ws.documents = [];
	ws.tabs = [];
	const doc = (await ws.openFile(existingOrigin))!;
	return { ws, doc, storage };
}

describe("filetree delete marks open tabs deleted-on-disk (issue #173)", () => {
	it("marks a dirty open file deleted-on-disk, preserving edits and keeping the tab", async () => {
		const { ws, doc, storage } = await makeWsWithOpenFile();
		const unsavedEdit = "my unsaved in-memory edit\n";
		ws.updateDocumentContent(doc, unsavedEdit);
		expect(doc.isModified).toBe(true);
		expect(doc.deletedOnDisk).toBe(false);

		// The file is now gone from disk, so the post-delete scan's reconcile
		// probe also sees it as missing.
		storage.readFile = mock(async () => {
			const err: any = new Error("not found");
			err.name = "NotFoundError";
			throw err;
		});

		await ws.projectTree.deleteEntry({
			name: fileOrigin.name,
			kind: "file",
			origin: fileOrigin,
			isExpanded: false
		});

		expect(doc.content).toBe(unsavedEdit);
		expect(doc.deletedOnDisk).toBe(true);
		expect(doc.isModified).toBe(true);
		// Nothing auto-closes: the document and its tab survive the delete.
		expect(ws.documents.find((d) => d.id === doc.id)).toBe(doc);
		expect(ws.tabs.some((t) => t.id === doc.id)).toBe(true);
	});

	it("marks a clean open file deleted-on-disk without touching content", async () => {
		const diskContent = "committed content\n";
		const { ws, doc, storage } = await makeWsWithOpenFile(diskContent);
		expect(doc.isModified).toBe(false);

		storage.readFile = mock(async () => {
			const err: any = new Error("not found");
			err.name = "NotFoundError";
			throw err;
		});

		await ws.projectTree.deleteEntry({
			name: fileOrigin.name,
			kind: "file",
			origin: fileOrigin,
			isExpanded: false
		});

		expect(doc.content).toBe(diskContent);
		expect(doc.deletedOnDisk).toBe(true);
		expect(ws.tabs.some((t) => t.id === doc.id)).toBe(true);
	});

	it("marks descendants on directory delete and leaves siblings alone", async () => {
		const { ws } = await makeWsWithOpenFile();
		// Reset to a controlled pair: one file under the deleted dir, one sibling.
		ws.documents = [];
		ws.tabs = [];
		const storage = (ws as any).storage;
		storage.readFile = mock(async (o: FileOrigin) => `content of ${o.path}\n`);
		const underOrigin: FileOrigin = { scheme: "file", path: "/projects/np/dir/a.txt", name: "a.txt" };
		const siblingOrigin: FileOrigin = { scheme: "file", path: "/projects/np/other/b.txt", name: "b.txt" };
		const under = (await ws.openFile(underOrigin))!;
		const sibling = (await ws.openFile(siblingOrigin))!;

		// The directory (and its descendants) are gone from disk, so the
		// post-delete scan's reconcile probe sees them as missing too.
		storage.readFile = mock(async (o: FileOrigin) => {
			if (o.path === underOrigin.path || o.path.startsWith("/projects/np/dir/")) {
				const err: any = new Error("not found");
				err.name = "NotFoundError";
				throw err;
			}
			return `content of ${o.path}\n`;
		});

		await ws.projectTree.deleteEntry({
			name: "dir",
			kind: "directory",
			origin: { scheme: "file", path: "/projects/np/dir", name: "dir" },
			isExpanded: false
		});

		expect(under.deletedOnDisk).toBe(true);
		expect(sibling.deletedOnDisk).toBe(false);
		expect(ws.tabs.some((t) => t.id === under.id)).toBe(true);
		expect(ws.tabs.some((t) => t.id === sibling.id)).toBe(true);
	});

	it("leaves open docs alone when an unrelated file is deleted", async () => {
		const { ws, doc } = await makeWsWithOpenFile();
		const otherOrigin: FileOrigin = { scheme: "file", path: "/projects/np/src/b.ts", name: "b.ts" };

		await ws.projectTree.deleteEntry({
			name: otherOrigin.name,
			kind: "file",
			origin: otherOrigin,
			isExpanded: false
		});

		expect(doc.deletedOnDisk).toBe(false);
		expect(ws.tabs.some((t) => t.id === doc.id)).toBe(true);
	});

	it("loadContent on a missing file marks deleted-on-disk", async () => {
		const { ws, doc, storage } = await makeWsWithOpenFile();
		storage.readFile = mock(async () => {
			const err: any = new Error("not found");
			err.name = "NotFoundError";
			throw err;
		});

		await expect(doc.loadContent()).rejects.toThrow("not found");
		expect(doc.deletedOnDisk).toBe(true);
	});

	it("preserves deletedOnDisk status and text content across session restore / restart", async () => {
		const persistence = new MemorySessionPersistence();
		const storage = createMockStorage({
			pickDirectory: async () => rootOrigin,
			verifyPermission: async () => true
		});
		storage.readFile = mock(async () => "committed text content\n");
		storage.readDirectory = mock(async () => []);

		const ws1 = new WorkspaceClass(storage, makeVcsFactory(), persistence);
		await ws1.openDirectory();
		ws1.documents = [];
		ws1.tabs = [];
		const doc1 = (await ws1.openFile(fileOrigin))!;
		expect(doc1.content).toBe("committed text content\n");

		// The file is gone from disk, so the post-delete scan's reconcile
		// probe also sees it as missing.
		storage.readFile = mock(async () => {
			const err: any = new Error("not found");
			err.name = "NotFoundError";
			throw err;
		});

		// Delete the file via filetree
		await ws1.projectTree.deleteEntry({
			name: fileOrigin.name,
			kind: "file",
			origin: fileOrigin,
			isExpanded: false
		});

		expect(doc1.deletedOnDisk).toBe(true);
		expect(doc1.content).toBe("committed text content\n");

		// Persist workspace state
		await persistence.saveRootFolder(rootOrigin);
		await ws1.saveFolderState(toURI(rootOrigin));

		// Simulate disk reads failing now that the file is deleted
		storage.readFile = mock(async () => {
			const err: any = new Error("not found");
			err.name = "NotFoundError";
			throw err;
		});

		// Create a new Workspace simulating application restart
		const ws2 = new WorkspaceClass(storage, makeVcsFactory(), persistence);
		await ws2.restoreSession();

		expect(ws2.documents.length).toBe(1);
		const restoredDoc = ws2.documents[0];
		expect(restoredDoc.origin?.path).toBe(fileOrigin.path);
		expect(restoredDoc.content).toBe("committed text content\n");
		expect(restoredDoc.deletedOnDisk).toBe(true);
	});

	it("clears a stale deletedOnDisk flag when the file exists again at restore", async () => {
		const persistence = new MemorySessionPersistence();
		const storage = createMockStorage({
			pickDirectory: async () => rootOrigin,
			verifyPermission: async () => true
		});
		storage.readFile = mock(async () => "committed text content\n");
		storage.readDirectory = mock(async () => []);

		const ws1 = new WorkspaceClass(storage, makeVcsFactory(), persistence);
		await ws1.openDirectory();
		ws1.documents = [];
		ws1.tabs = [];
		const doc1 = (await ws1.openFile(fileOrigin))!;

		// The file is gone from disk, so the post-delete scan's reconcile
		// probe also sees it as missing.
		storage.readFile = mock(async () => {
			const err: any = new Error("not found");
			err.name = "NotFoundError";
			throw err;
		});

		await ws1.projectTree.deleteEntry({
			name: fileOrigin.name,
			kind: "file",
			origin: fileOrigin,
			isExpanded: false
		});
		expect(doc1.deletedOnDisk).toBe(true);

		await persistence.saveRootFolder(rootOrigin);
		await ws1.saveFolderState(toURI(rootOrigin));

		// File was recreated before restart: reads succeed again.
		storage.readFile = mock(async () => "recreated content\n");

		const ws2 = new WorkspaceClass(storage, makeVcsFactory(), persistence);
		await ws2.restoreSession();
		// restoreDraft's baseline read resolves async; wait for it.
		await flushMicrotasks();

		expect(ws2.documents.length).toBe(1);
		expect(ws2.documents[0].deletedOnDisk).toBe(false);
	});

	it("keeps deletedOnDisk when a delete lands while the restore read is in flight", async () => {
		const storage = createMockStorage({
			pickDirectory: async () => rootOrigin,
			verifyPermission: async () => true
		});
		storage.readFile = mock(async () => "committed content\n");
		storage.readDirectory = mock(async () => []);

		// A dirty doc persists its draft, so the restore triggers a baseline
		// read that we defer to interleave a filetree delete with it.
		let resolveRead!: (data: string) => void;
		storage.readFile = mock(
			(_origin: FileOrigin) => new Promise<string>((resolve) => { resolveRead = resolve; })
		);

		const ws = new WorkspaceClass(storage, makeVcsFactory(), new MemorySessionPersistence());
		const doc = new DocumentSession(storage, "", fileOrigin);
		ws.documents = [doc];
		ws.tabs = [{ id: doc.id, type: "document" }];

		doc.restoreDraft("unsaved edit\n");
		// The delete lands before the startup restore baseline read resolves.
		ws.markDocumentsDeleted(fileOrigin);

		resolveRead("recreated content\n");
		await flushMicrotasks();

		expect(doc.deletedOnDisk).toBe(true);
	});

	it("keeps deletedOnDisk when a delete lands while a loadContent read is in flight", async () => {
		const { ws, doc, storage } = await makeWsWithOpenFile();
		doc.isLoaded = false;
		doc.deletedOnDisk = false;

		// Defer the load read so a filetree delete can land mid-load.
		let resolveRead!: (data: string) => void;
		storage.readFile = mock(
			(_origin: FileOrigin) => new Promise<string>((resolve) => { resolveRead = resolve; })
		);

		const loading = doc.loadContent();
		// The delete lands while the startup load read is in flight.
		ws.markDocumentsDeleted(fileOrigin);

		resolveRead("still-there content\n");
		await flushMicrotasks();
		await loading;

		// The stale success must not resurrect a cleared deletedOnDisk flag.
		expect(doc.deletedOnDisk).toBe(true);
		// The stale read was dropped entirely: baseline and content untouched.
		expect(doc.content).toBe("committed content\n");
	});
});
