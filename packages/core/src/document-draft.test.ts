import "../../../tests/contract/rune-setup";
import { describe, it, expect, mock, beforeAll } from "bun:test";
import type { FileOrigin } from "./storage";
import { createMockStorage } from "../../../tests/mock-storage";
import { MemorySessionPersistence } from "./persistence";
import type { VCSAdapter } from "./project/vcs";
import type { Workspace } from "./workspace.svelte";
import type { DocumentSession } from "./document.svelte";

beforeAll(async () => {
	mock.module("svelte/reactivity", () => ({
		SvelteMap: Map,
		SvelteSet: Set
	}));
});

let makeWorkspace: (storage: ReturnType<typeof createMockStorage>, persistence: MemorySessionPersistence) => Workspace;
let makeDocSession: (storage: ReturnType<typeof createMockStorage>, initialContent?: string, origin?: FileOrigin | null, untitledTitle?: string, workspace?: Workspace) => DocumentSession;

beforeAll(async () => {
	const wsMod = await import("./workspace.svelte");
	const docMod = await import("./document.svelte");
	makeWorkspace = (storage, persistence) =>
		new wsMod.Workspace(
			storage,
			() => ({ detect: async () => false } as unknown as VCSAdapter),
			persistence
		);
	makeDocSession = (storage, initialContent = "", origin = null, untitledTitle = "Untitled", workspace) =>
		new docMod.DocumentSession(storage, initialContent, origin, untitledTitle, workspace);
});

describe("Document draft and keystroke decoupling", () => {
	it("modifying document content marks it as modified and updates stats", () => {
		const storage = createMockStorage();
		const doc = makeDocSession(storage, "Hello world", { scheme: "file", path: "/test.txt", name: "test.txt" });

		expect(doc.isModified).toBe(false);
		expect(doc.charCount).toBe(11);
		expect(doc.wordCount).toBe(2);

		doc.content = "Hello world modified!";
		expect(doc.isModified).toBe(true);
		expect(doc.charCount).toBe(21);
		expect(doc.wordCount).toBe(3);
	});

	it("schedules debouncedSaveOpenFiles on content edit and persists draft", async () => {
		const persistence = new MemorySessionPersistence();
		const storage = createMockStorage();
		storage.readFile = mock(async () => "Original disk content");

		const ws = makeWorkspace(storage, persistence);
		await ws.restoreSession();

		const doc = await ws.openFile({ scheme: "file", path: "/test.txt", name: "test.txt" });
		expect(doc).toBeDefined();

		// Disk content is unchanged, so initial draftContent is undefined
		ws.flushSaveOpenFiles();
		let saved = await persistence.loadOpenFiles("");
		expect(saved[saved.length - 1].draftContent).toBeUndefined();

		// Keystroke edit: modify doc.content
		doc!.content = "Modified draft text";
		expect(doc!.isModified).toBe(true);

		// Flush persistence and verify draftContent is persisted
		ws.flushSaveOpenFiles();
		saved = await persistence.loadOpenFiles("");
		const savedDoc = saved.find(d => d.id === doc!.id);
		expect(savedDoc?.draftContent).toBe("Modified draft text");
	});

	it("restoring session restores draft content and modified state for modified files", async () => {
		const persistence = new MemorySessionPersistence();
		const storage = createMockStorage();
		storage.readFile = mock(async (origin) => {
			if (origin.path === "/test.txt") return "Disk content";
			return "";
		});

		// Save draft state in persistence
		await persistence.saveOpenFiles([
			{
				id: "untitled-1",
				origin: null,
				untitledTitle: "Untitled 1",
				draftContent: "Untitled draft text"
			},
			{
				id: "doc-2",
				origin: { scheme: "file", path: "/test.txt", name: "test.txt" },
				draftContent: "Modified unsaved draft"
			}
		], "");
		await persistence.saveActiveDocumentId("doc-2", "");

		const ws = makeWorkspace(storage, persistence);
		await ws.restoreSession();

		expect(ws.documents.length).toBe(2);
		expect(ws.activeTabId).toBe("doc-2");

		const untitledDoc = ws.documents.find(d => d.id === "untitled-1");
		expect(untitledDoc?.content).toBe("Untitled draft text");
		expect(untitledDoc?.isModified).toBe(true);

		const modifiedDoc = ws.documents.find(d => d.id === "doc-2");
		expect(modifiedDoc?.content).toBe("Modified unsaved draft");
		expect(modifiedDoc?.isModified).toBe(true);
	});

	it("flushSaveOpenFiles flushes pending draft saves cleanly", async () => {
		const persistence = new MemorySessionPersistence();
		const storage = createMockStorage();
		const ws = makeWorkspace(storage, persistence);
		await ws.restoreSession();

		const doc1 = ws.documents[0];
		const doc2 = await ws.newFile();

		doc1.content = "Keystroke edit in doc 1";
		ws.activeTabId = doc2.id;
		ws.flushSaveOpenFiles();

		const saved = await persistence.loadOpenFiles("");
		const savedDoc1 = saved.find(d => d.id === doc1.id);
		expect(savedDoc1?.draftContent).toBe("Keystroke edit in doc 1");
	});

	it("saving a modified document clears its draftContent in next persistence flush", async () => {
		const persistence = new MemorySessionPersistence();
		let fileStore: Record<string, string> = { "/test.txt": "Original content" };
		const storage = createMockStorage({
			verifyPermission: async () => true,
			queryPermission: async () => "granted"
		});
		storage.readFile = mock(async (origin) => fileStore[origin.path] ?? "");
		storage.saveFile = mock(async (content, origin) => {
			const path = origin?.path ?? "/test.txt";
			fileStore[path] = content;
			return { scheme: "file", path, name: "test.txt" };
		});

		const ws = makeWorkspace(storage, persistence);
		await ws.restoreSession();

		const doc = await ws.openFile({ scheme: "file", path: "/test.txt", name: "test.txt" });
		doc!.content = "Brand new unsaved edits";
		ws.flushSaveOpenFiles();

		let saved = await persistence.loadOpenFiles("");
		expect(saved.find(d => d.id === doc!.id)?.draftContent).toBe("Brand new unsaved edits");

		// Save the document
		const saveSuccess = await doc!.save();
		expect(saveSuccess).toBe(true);
		expect(doc!.isModified).toBe(false);

		ws.flushSaveOpenFiles();
		saved = await persistence.loadOpenFiles("");
		expect(saved.find(d => d.id === doc!.id)?.draftContent).toBeUndefined();
	});

	it("keystroke editing directly invokes debouncedSaveOpenFiles without modifying structural tabs/docs identity", async () => {
		const persistence = new MemorySessionPersistence();
		const storage = createMockStorage();
		const ws = makeWorkspace(storage, persistence);
		await ws.restoreSession();

		const doc = ws.documents[0];
		const initialTabs = ws.tabs.map(t => t.id).join(",");
		const initialDocs = ws.documents.map(d => `${d.id}:${d.origin?.path || d.untitledTitle}`).join(",");

		// Mock debouncedSaveOpenFiles to track invocations
		const originalDebouncedSave = ws.debouncedSaveOpenFiles;
		let debouncedCalls = 0;
		ws.debouncedSaveOpenFiles = () => {
			debouncedCalls++;
			originalDebouncedSave.call(ws);
		};

		// Keystroke edit:
		doc.content = "New keystroke edit";

		expect(debouncedCalls).toBe(1);
		// Structural identity of tabs and documents is unaffected by keystroke content
		expect(ws.tabs.map(t => t.id).join(",")).toBe(initialTabs);
		expect(ws.documents.map(d => `${d.id}:${d.origin?.path || d.untitledTitle}`).join(",")).toBe(initialDocs);
	});
});
