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

function notFound(): any {
	const err: any = new Error("not found");
	err.name = "NotFoundError";
	return err;
}

async function makeWsWithOpenFile(
	diskContent = "committed content\n",
	existingOrigin: FileOrigin = fileOrigin
) {
	const storage = createMockStorage({
		pickDirectory: async () => rootOrigin,
		verifyPermission: async () => true
	});
	storage.readFile = mock(async () => diskContent);
	storage.readDirectory = mock(async () => []);
	const ws = new WorkspaceClass(storage, makeVcsFactory(), new MemorySessionPersistence());
	await ws.openDirectory();
	ws.documents = [];
	ws.tabs = [];
	const doc = (await ws.openFile(existingOrigin))!;
	return { ws, doc, storage };
}

describe("external delete marks open tabs deleted-on-disk (issue #175)", () => {
	it("marks a dirty open file deleted-on-disk on scan, preserving edits and keeping the tab", async () => {
		const { ws, doc, storage } = await makeWsWithOpenFile();
		const unsavedEdit = "my unsaved in-memory edit\n";
		ws.updateDocumentContent(doc, unsavedEdit);
		expect(doc.isModified).toBe(true);
		expect(doc.deletedOnDisk).toBe(false);

		// Simulate external delete: the file vanishes outside the app.
		storage.readFile = mock(async (o: FileOrigin) => {
			if (o.path === fileOrigin.path) throw notFound();
			return "";
		});

		await ws.projectTree.scan(rootOrigin);

		expect(doc.content).toBe(unsavedEdit);
		expect(doc.deletedOnDisk).toBe(true);
		expect(doc.isModified).toBe(true);
		expect(ws.documents.find((d) => d.id === doc.id)).toBe(doc);
		expect(ws.tabs.some((t) => t.id === doc.id)).toBe(true);
	});

	it("marks a dirty open file deleted-on-disk via reconcile, preserving edits", async () => {
		const { ws, doc, storage } = await makeWsWithOpenFile();
		const unsavedEdit = "my unsaved in-memory edit\n";
		ws.updateDocumentContent(doc, unsavedEdit);

		storage.readFile = mock(async (o: FileOrigin) => {
			if (o.path === fileOrigin.path) throw notFound();
			return "";
		});

		await (ws as any).reconcileExternalDeletions();

		expect(doc.content).toBe(unsavedEdit);
		expect(doc.deletedOnDisk).toBe(true);
		expect(ws.tabs.some((t) => t.id === doc.id)).toBe(true);
	});

	it("marks a clean open file deleted-on-disk without touching content", async () => {
		const diskContent = "committed content\n";
		const { ws, doc, storage } = await makeWsWithOpenFile(diskContent);
		expect(doc.isModified).toBe(false);

		storage.readFile = mock(async (o: FileOrigin) => {
			if (o.path === fileOrigin.path) throw notFound();
			return "";
		});

		await ws.projectTree.scan(rootOrigin);

		expect(doc.content).toBe(diskContent);
		expect(doc.deletedOnDisk).toBe(true);
		expect(ws.tabs.some((t) => t.id === doc.id)).toBe(true);
	});

	it("leaves open docs alone when nothing was deleted externally", async () => {
		const { ws, doc } = await makeWsWithOpenFile();
		// readFile still succeeds: file exists on disk.
		await ws.projectTree.scan(rootOrigin);

		expect(doc.deletedOnDisk).toBe(false);
		expect(ws.tabs.some((t) => t.id === doc.id)).toBe(true);
	});

	it("marks descendants when a directory is deleted externally and leaves siblings alone", async () => {
		const { ws, storage } = await makeWsWithOpenFile();
		ws.documents = [];
		ws.tabs = [];
		(storage as any).readFile = mock(async (o: FileOrigin) => `content of ${o.path}\n`);
		const underOrigin: FileOrigin = { scheme: "file", path: "/projects/np/dir/a.txt", name: "a.txt" };
		const siblingOrigin: FileOrigin = { scheme: "file", path: "/projects/np/other/b.txt", name: "b.txt" };
		const under = (await ws.openFile(underOrigin))!;
		const sibling = (await ws.openFile(siblingOrigin))!;

		// Simulate external `rm -rf dir`: reads under it throw NotFound.
		storage.readFile = mock(async (o: FileOrigin) => {
			if (o.path === underOrigin.path || o.path.startsWith("/projects/np/dir/")) throw notFound();
			return `content of ${o.path}\n`;
		});

		await ws.projectTree.scan(rootOrigin);

		expect(under.deletedOnDisk).toBe(true);
		expect(sibling.deletedOnDisk).toBe(false);
		expect(ws.tabs.some((t) => t.id === under.id)).toBe(true);
		expect(ws.tabs.some((t) => t.id === sibling.id)).toBe(true);
	});

	it("reconciles external deletions when storage throws Electron IPC serialized error", async () => {
		const { ws, doc, storage } = await makeWsWithOpenFile();
		const unsavedEdit = "my unsaved in-memory edit\n";
		ws.updateDocumentContent(doc, unsavedEdit);

		// In Electron renderer, IPC error has name='Error' and no .code property,
		// but the message includes 'ENOENT: no such file or directory'.
		storage.readFile = mock(async (o: FileOrigin) => {
			if (o.path === fileOrigin.path) {
				const err = new Error("Error invoking remote method 'fs:readFile': Error: ENOENT: no such file or directory, open '/projects/np/src/a.ts'");
				throw err;
			}
			return "";
		});

		await (ws as any).reconcileExternalDeletions();

		expect(doc.content).toBe(unsavedEdit);
		expect(doc.deletedOnDisk).toBe(true);
		expect(ws.tabs.some((t) => t.id === doc.id)).toBe(true);
	});

	it("loadContent marks deletedOnDisk when storage throws Electron IPC serialized error", async () => {
		const { ws, doc, storage } = await makeWsWithOpenFile();
		doc.isLoaded = false;
		doc.deletedOnDisk = false;

		storage.readFile = mock(async () => {
			throw new Error("Error invoking remote method 'fs:readFile': Error: ENOENT: no such file or directory, open '/projects/np/src/a.ts'");
		});

		await expect(doc.loadContent()).rejects.toThrow();

		expect(doc.deletedOnDisk).toBe(true);
	});

	it("clears a stale deleted-on-disk flag when the file is recreated and reconcile probes it", async () => {
		const initialContent = "original content\n";
		const recreatedContent = "recreated content v2\n";
		const { ws, doc, storage } = await makeWsWithOpenFile(initialContent);
		expect(doc.content).toBe(initialContent);
		expect(doc.isModified).toBe(false);

		// File disappears externally; reconcile marks it on the next scan.
		storage.readFile = mock(async (o: FileOrigin) => {
			if (o.path === fileOrigin.path) throw notFound();
			return "";
		});
		await ws.projectTree.scan(rootOrigin);
		expect(doc.deletedOnDisk).toBe(true);

		// File recreated externally with different content; the next
		// reconcile probe restores via the guarded baseline operation.
		storage.readFile = mock(async () => recreatedContent);
		await (ws as any).reconcileExternalDeletions();

		expect(doc.deletedOnDisk).toBe(false);
		expect(doc.content).toBe(recreatedContent);
		expect(doc.isModified).toBe(false);
		expect(ws.tabs.some((t) => t.id === doc.id)).toBe(true);
	});

	it("marks deleted when the probe fails with a structured ENOENT code but no matching message", async () => {
		const { ws, doc, storage } = await makeWsWithOpenFile();

		// A genuinely missing file whose message lacks the English ENOENT
		// substrings (e.g. a localized or raw system message) must still be
		// classified via its structured code.
		storage.readFile = mock(async () => {
			const err: any = new Error("The system cannot find the file specified");
			err.code = "ENOENT";
			throw err;
		});

		await (ws as any).reconcileExternalDeletions();

		expect(doc.deletedOnDisk).toBe(true);
	});

	it("does not mark a live file deleted when the probe fails with a coded non-missing error", async () => {
		const { ws, doc, storage } = await makeWsWithOpenFile();

		// A coded failure of a different kind (here EACCES) whose message
		// merely mentions ENOENT via a chained cause is not a missing file.
		storage.readFile = mock(async () => {
			const err: any = new Error("permission denied opening file: ENOENT: no such file or directory");
			err.code = "EACCES";
			throw err;
		});

		await (ws as any).reconcileExternalDeletions();

		expect(doc.deletedOnDisk).toBe(false);
	});
});
