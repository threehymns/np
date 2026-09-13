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
let makeDocSession: (storage: ReturnType<typeof createMockStorage>, initialContent?: string, origin?: FileOrigin | null, untitledTitle?: string) => DocumentSession;

beforeAll(async () => {
	const wsMod = await import("./workspace.svelte");
	const docMod = await import("./document.svelte");
	makeWorkspace = (storage, persistence) =>
		new wsMod.Workspace(
			storage,
			() => ({ detect: async () => false } as unknown as VCSAdapter),
			persistence
		);
	makeDocSession = (storage, initialContent = "", origin = null, untitledTitle = "Untitled") =>
		new docMod.DocumentSession(storage, initialContent, origin, untitledTitle);
});

describe("Document draft and keystroke decoupling", () => {
	it("modifying document content marks it as modified and updates stats", () => {
		const storage = createMockStorage();
		const doc = makeDocSession(storage, "Hello world", { scheme: "file", path: "/test.txt", name: "test.txt" });

		expect(doc.isModified).toBe(false);
		expect(doc.charCount).toBe(11);
		expect(doc.wordCount).toBe(2);

		// Isolated Document test: direct assignment is intentional here (no
		// Workspace, so no persistence scheduling expected).
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
		await ws.flushSaveOpenFiles();
		let saved = await persistence.loadOpenFiles("");
		expect(saved[saved.length - 1].draftContent).toBeUndefined();

		// Keystroke edit: modify doc.content via the Workspace path
		ws.updateDocumentContent(doc!, "Modified draft text");
		expect(doc!.isModified).toBe(true);

		// Flush persistence and verify draftContent is persisted
		await ws.flushSaveOpenFiles();
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

		ws.updateDocumentContent(doc1, "Keystroke edit in doc 1");
		ws.activeTabId = doc2.id;
		await ws.flushSaveOpenFiles();

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
		ws.updateDocumentContent(doc!, "Brand new unsaved edits");
		await ws.flushSaveOpenFiles();

		let saved = await persistence.loadOpenFiles("");
		expect(saved.find(d => d.id === doc!.id)?.draftContent).toBe("Brand new unsaved edits");

		// Save the document via the Workspace path (covers post-save flush)
		const saveSuccess = await ws.saveDocument(doc!);
		expect(saveSuccess).toBe(true);
		expect(doc!.isModified).toBe(false);

		await ws.flushSaveOpenFiles();
		saved = await persistence.loadOpenFiles("");
		expect(saved.find(d => d.id === doc!.id)?.draftContent).toBeUndefined();
	});

	it("loadContent preserves keystrokes typed while the async read is in flight", async () => {
		const storage = createMockStorage();
		let resolveRead!: (v: string) => void;
		const gate = new Promise<string>((r) => {
			resolveRead = r;
		});
		storage.readFile = mock(async () => gate) as any;

		const origin = { scheme: "file", path: "/test.txt", name: "test.txt" } as FileOrigin;
		const doc = makeDocSession(storage, "", origin);
		expect(doc.isLoaded).toBe(false);

		const load = doc.loadContent();
		// User types before readFile resolves (restore + fast typing window).
		doc.content = "typed while loading";

		resolveRead("disk content");
		await load;

		expect(doc.content).toBe("typed while loading");
		expect(doc.isLoaded).toBe(true);
	});

	it("save captures content at write start so keystrokes during save stay dirty", async () => {
		const storage = createMockStorage({
			verifyPermission: async () => true,
			queryPermission: async () => "granted"
		});
		let resolveSave!: (v: FileOrigin) => void;
		const gate = new Promise<FileOrigin>((r) => {
			resolveSave = r;
		});
		let writtenContent: string | null = null;
		storage.saveFile = mock(async (content) => {
			writtenContent = content;
			return gate;
		}) as any;

		// Untitled (origin null) skips the async permission check, so the
		// content snapshot is taken synchronously and the edit below lands
		// strictly during the in-flight saveFile — the reported race window.
		const doc = makeDocSession(storage, "original", null);
		expect(doc.isModified).toBe(false);

		const saving = doc.save({ coveredByRoot: false });
		// User types while the async save is in flight.
		doc.content = "original + newer edit";

		resolveSave({ scheme: "file", path: "/test.txt", name: "test.txt" } as FileOrigin);
		const ok = await saving;
		expect(ok).toBe(true);
		// Disk received the older snapshot; the newer edit must stay dirty.
		expect(writtenContent).toBe("original");
		expect(doc.isModified).toBe(true);
		expect(doc.content).toBe("original + newer edit");
	});

	it("empty restored draft stays dirty until disk baseline loads", async () => {
		const persistence = new MemorySessionPersistence();
		const storage = createMockStorage();
		let resolveRead!: (v: string) => void;
		let rejectRead!: (e: unknown) => void;
		const gate = new Promise<string>((res, rej) => {
			resolveRead = res;
			rejectRead = rej;
		});
		storage.readFile = mock(async () => gate) as any;

		const origin = { scheme: "file", path: "/test.txt", name: "test.txt" } as FileOrigin;
		const ws = makeWorkspace(storage, persistence);
		await ws.restoreSession();

		const doc = makeDocSession(storage, "", origin, "Untitled");
		ws.documents.push(doc);
		ws.tabs.push({ id: doc.id, type: "document" });
		ws.activeTabId = doc.id;

		doc.restoreDraft("");
		// Baseline read pending: empty draft must read dirty so the immediate
		// flush does not omit the deletion draft.
		expect(doc.isModified).toBe(true);

		await ws.flushSaveOpenFiles();
		let saved = await persistence.loadOpenFiles("");
		expect(saved.find((d) => d.id === doc.id)?.draftContent).toBe("");

		// Disk still holds the old content; draft stays dirty after baseline.
		resolveRead("old disk content");
		await new Promise((r) => setTimeout(r, 10));
		expect(doc.content).toBe("");
		expect(doc.isModified).toBe(true);

		await ws.flushSaveOpenFiles();
		saved = await persistence.loadOpenFiles("");
		expect(saved.find((d) => d.id === doc.id)?.draftContent).toBe("");
	});

	it("empty restored draft stays dirty when baseline read fails", async () => {
		const storage = createMockStorage();
		let rejectRead!: (e: unknown) => void;
		const gate = new Promise<string>((_, rej) => {
			rejectRead = rej;
		});
		// Suppress expected error logging.
		const origError = console.error;
		console.error = () => {};
		storage.readFile = mock(async () => gate) as any;

		try {
			const origin = { scheme: "file", path: "/missing.txt", name: "missing.txt" } as FileOrigin;
			const doc = makeDocSession(storage, "", origin);
			doc.restoreDraft("");
			expect(doc.isModified).toBe(true);

			rejectRead(new Error("ENOENT"));
			await new Promise((r) => setTimeout(r, 10));
			expect(doc.isModified).toBe(true);
		} finally {
			console.error = origError;
		}
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

		// Keystroke edit via the Workspace path:
		ws.updateDocumentContent(doc, "New keystroke edit");

		expect(debouncedCalls).toBe(1);
		// Structural identity of tabs and documents is unaffected by keystroke content
		expect(ws.tabs.map(t => t.id).join(",")).toBe(initialTabs);
		expect(ws.documents.map(d => `${d.id}:${d.origin?.path || d.untitledTitle}`).join(",")).toBe(initialDocs);
	});
});
