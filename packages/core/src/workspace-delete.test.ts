import "../../../tests/contract/rune-setup";
import { describe, it, expect, mock, beforeAll } from "bun:test";
import type { FileOrigin } from "./storage";
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
): Promise<{ ws: Workspace; doc: NonNullable<Awaited<ReturnType<Workspace["openFile"]>>> }> {
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
	return { ws, doc };
}

describe("filetree delete marks open tabs deleted-on-disk (issue #173)", () => {
	it("marks a dirty open file deleted-on-disk, preserving edits and keeping the tab", async () => {
		const { ws, doc } = await makeWsWithOpenFile();
		const unsavedEdit = "my unsaved in-memory edit\n";
		ws.updateDocumentContent(doc, unsavedEdit);
		expect(doc.isModified).toBe(true);
		expect(doc.deletedOnDisk).toBe(false);

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
		const { ws, doc } = await makeWsWithOpenFile(diskContent);
		expect(doc.isModified).toBe(false);

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
});
