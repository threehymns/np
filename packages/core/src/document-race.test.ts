import "../../../tests/contract/rune-setup";
import { describe, it, expect, mock, beforeAll } from "bun:test";
import type { FileOrigin } from "./storage";
import { createMockStorage } from "../../../tests/mock-storage";
import { MemorySessionPersistence } from "./persistence";
import type { VCSAdapter } from "./project/vcs";
import type { Workspace } from "./workspace.svelte";
import type { DocumentSession } from "./document.svelte";

let makeWorkspace: (storage: ReturnType<typeof createMockStorage>, persistence: MemorySessionPersistence) => Workspace;
let makeDocSession: (storage: ReturnType<typeof createMockStorage>, initialContent?: string, origin?: FileOrigin | null, untitledTitle?: string) => DocumentSession;

beforeAll(async () => {
	const wsMod = await import("./workspace.svelte");
	const docMod = await import("./document.svelte");
	makeWorkspace = (storage, persistence) =>
		new wsMod.Workspace(
			storage,
			() => ({ detect: async () => false }) as unknown as VCSAdapter,
			persistence
		);
	makeDocSession = (storage, initialContent = "", origin = null, untitledTitle = "Untitled") =>
		new docMod.DocumentSession(storage, initialContent, origin, untitledTitle);
});

describe("Document load/save revision race", () => {
	it("older load ENOENT does not resurrect deletion after a newer successful load", async () => {
		const origin: FileOrigin = { scheme: "file", path: "/test.txt", name: "test.txt" };
		const storage = createMockStorage();
		let rejectOlder!: (error: unknown) => void;
		let resolveNewer!: (content: string) => void;
		const olderGate = new Promise<string>((_, reject) => { rejectOlder = reject; });
		const newerGate = new Promise<string>((resolve) => { resolveNewer = resolve; });
		storage.readFile = mock(() => newerGate).mockImplementationOnce(() => olderGate);
		const doc = makeDocSession(storage, "base", origin);
		doc.markDeletedOnDisk();

		const older = doc.loadContent();
		const newer = doc.loadContent();
		resolveNewer("recreated content");
		await newer;
		expect(doc.deletedOnDisk).toBe(false);

		const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
		rejectOlder(missing);
		await expect(older).rejects.toThrow("missing");

		expect(doc.deletedOnDisk).toBe(false);
		expect(doc.content).toBe("recreated content");
		expect(doc.isModified).toBe(false);
	});

	it("older successful load does not override a newer load ENOENT", async () => {
		const origin: FileOrigin = { scheme: "file", path: "/test.txt", name: "test.txt" };
		const storage = createMockStorage();
		let resolveOlder!: (content: string) => void;
		let rejectNewer!: (error: unknown) => void;
		const olderGate = new Promise<string>((resolve) => { resolveOlder = resolve; });
		const newerGate = new Promise<string>((_, reject) => { rejectNewer = reject; });
		storage.readFile = mock(() => newerGate).mockImplementationOnce(() => olderGate);
		const doc = makeDocSession(storage, "base", origin);

		const older = doc.loadContent();
		const newer = doc.loadContent();
		rejectNewer(Object.assign(new Error("missing"), { code: "ENOENT" }));
		await expect(newer).rejects.toThrow("missing");
		expect(doc.deletedOnDisk).toBe(true);

		resolveOlder("stale content");
		await older;

		expect(doc.deletedOnDisk).toBe(true);
		expect(doc.content).toBe("base");
		expect(doc.isModified).toBe(false);
	});

	it("accepted load clears pending draft baseline and ignores the older restore read", async () => {
		const origin: FileOrigin = { scheme: "file", path: "/test.txt", name: "test.txt" };
		const storage = createMockStorage();
		let resolveRestore!: (content: string) => void;
		let resolveLoad!: (content: string) => void;
		const restoreGate = new Promise<string>((resolve) => { resolveRestore = resolve; });
		const loadGate = new Promise<string>((resolve) => { resolveLoad = resolve; });
		storage.readFile = mock(() => loadGate).mockImplementationOnce(() => restoreGate);
		const doc = makeDocSession(storage, "", origin);
		doc.restoreDraft("recovered content");
		expect(doc.isModified).toBe(true);

		const loading = doc.loadContent();
		resolveLoad("recovered content");
		await loading;

		try {
			expect(doc.content).toBe("recovered content");
			expect(doc.isModified).toBe(false);
			expect(doc.deletedOnDisk).toBe(false);
		} finally {
			resolveRestore("stale disk content");
			await restoreGate;
		}

		expect(doc.content).toBe("recovered content");
		expect(doc.isModified).toBe(false);
	});

	it("in-flight load does not clobber a concurrent save", async () => {
		const origin = { scheme: "file", path: "/test.txt", name: "test.txt" } as FileOrigin;
		const storage = createMockStorage({
			verifyPermission: async () => true,
			queryPermission: async () => "granted",
		});
		let resolveRead!: (v: string) => void;
		const gate = new Promise<string>((r) => {
			resolveRead = r;
		});
		storage.readFile = mock(async () => gate) as any;
		storage.saveFile = mock(async (content: string, existing?: FileOrigin) => {
			return { scheme: "file", path: "/test.txt", name: "test.txt" } as FileOrigin;
		}) as any;

		const doc = makeDocSession(storage, "base", origin);
		// Isolated Document test: direct assignment simulates keystrokes
		// without a Workspace (no persistence scheduling expected).
		doc.content = "edited";

		const loading = doc.loadContent();
		// Concurrent save completes while the load's readFile is in flight.
		const saved = await doc.save({ coveredByRoot: false });
		expect(saved).toBe(true);

		resolveRead("stale-disk");
		await loading;

		expect(doc.content).toBe("edited");
		expect(doc.isModified).toBe(false);
	});

	it("in-flight load does not apply old-origin content after a save-as origin change", async () => {
		const oldOrigin = { scheme: "file", path: "/old.txt", name: "old.txt" } as FileOrigin;
		const newOrigin = { scheme: "file", path: "/new.txt", name: "new.txt" } as FileOrigin;
		const storage = createMockStorage({
			verifyPermission: async () => true,
			queryPermission: async () => "granted",
		});
		let resolveRead!: (v: string) => void;
		const gate = new Promise<string>((r) => {
			resolveRead = r;
		});
		storage.readFile = mock(async () => gate) as any;
		storage.saveFile = mock(async () => newOrigin) as any;

		const doc = makeDocSession(storage, "base", oldOrigin);
		const loading = doc.loadContent();
		const saved = await doc.save({ forceNewOrigin: true, coveredByRoot: false });
		expect(saved).toBe(true);
		expect(doc.origin?.path).toBe("/new.txt");

		resolveRead("old-disk-content");
		await loading;

		expect(doc.origin?.path).toBe("/new.txt");
		expect(doc.content).toBe("base");
		expect(doc.isModified).toBe(false);
	});

	it("in-flight rebase does not clobber a concurrent save baseline", async () => {
		const origin = { scheme: "file", path: "/test.txt", name: "test.txt" } as FileOrigin;
		const storage = createMockStorage({
			verifyPermission: async () => true,
			queryPermission: async () => "granted",
		});
		let resolveRead!: (v: string) => void;
		const gate = new Promise<string>((r) => {
			resolveRead = r;
		});
		storage.readFile = mock(async () => gate) as any;
		storage.saveFile = mock(async (content: string) => origin) as any;

		const doc = makeDocSession(storage, "base", origin);
		// Isolated Document test: direct assignment simulates keystrokes
		// without a Workspace (no persistence scheduling expected).
		doc.content = "edited";

		const rebasing = doc.rebaseSavedBaseline();
		// Concurrent save completes while the rebase read is in flight.
		const saved = await doc.save({ coveredByRoot: false });
		expect(saved).toBe(true);

		resolveRead("stale-disk");
		await rebasing;

		expect(doc.content).toBe("edited");
		expect(doc.isModified).toBe(false);
	});

	it("restoreDraft baseline read does not clobber a concurrent save", async () => {
		const origin = { scheme: "file", path: "/test.txt", name: "test.txt" } as FileOrigin;
		const storage = createMockStorage({
			verifyPermission: async () => true,
			queryPermission: async () => "granted",
		});
		let resolveRead!: (v: string) => void;
		const gate = new Promise<string>((r) => {
			resolveRead = r;
		});
		storage.readFile = mock(async () => gate) as any;
		storage.saveFile = mock(async (content: string) => origin) as any;

		const doc = makeDocSession(storage, "", origin);
		doc.restoreDraft("");
		// Isolated Document test: direct assignment simulates keystrokes
		// typed while the baseline read is in flight.
		doc.content = "typed after restore";

		// Save establishes the baseline before the stale read resolves.
		const saved = await doc.save({ coveredByRoot: false });
		expect(saved).toBe(true);

		resolveRead("old disk content");
		await new Promise((r) => setTimeout(r, 10));

		expect(doc.content).toBe("typed after restore");
		expect(doc.isModified).toBe(false);
	});

	it("in-flight load still applies when the origin is re-created with equal values", async () => {
		const origin = { scheme: "file", path: "/test.txt", name: "test.txt" } as FileOrigin;
		const storage = createMockStorage();
		let resolveRead!: (v: string) => void;
		const gate = new Promise<string>((r) => {
			resolveRead = r;
		});
		storage.readFile = mock(async () => gate) as any;

		const doc = makeDocSession(storage, "base", origin);
		const loading = doc.loadContent();
		// Same file, new object identity: origins are plain data, so the
		// in-flight read for that URI is still valid.
		doc.origin = { scheme: "file", path: "/test.txt", name: "test.txt" } as FileOrigin;

		resolveRead("fresh-disk");
		await loading;

		expect(doc.content).toBe("fresh-disk");
		expect(doc.isModified).toBe(false);
		expect(doc.isLoaded).toBe(true);
	});

	it("older restoreDraft read does not overwrite a newer rebase baseline", async () => {
		const origin = { scheme: "file", path: "/test.txt", name: "test.txt" } as FileOrigin;
		const storage = createMockStorage();
		let resolveRestore!: (v: string) => void;
		let resolveRebase!: (v: string) => void;
		const restoreGate = new Promise<string>((r) => {
			resolveRestore = r;
		});
		const rebaseGate = new Promise<string>((r) => {
			resolveRebase = r;
		});
		let readCalls = 0;
		storage.readFile = mock(async () => {
			readCalls++;
			if (readCalls === 1) return restoreGate;
			return rebaseGate;
		}) as any;

		const doc = makeDocSession(storage, "", origin);
		doc.restoreDraft("new-branch-content");
		const rebasing = doc.rebaseSavedBaseline();

		resolveRebase("new-branch-content");
		await rebasing;

		resolveRestore("old-branch-content");
		await new Promise((r) => setTimeout(r, 10));

		expect(doc.content).toBe("new-branch-content");
		expect(doc.isModified).toBe(false);
	});
});

describe("Document permission query freshness", () => {
	it("stale queryPermission result does not overwrite a newer granted permission", async () => {
		const origin = { scheme: "file", path: "/test.txt", name: "test.txt" } as FileOrigin;
		const storage = createMockStorage();
		let resolveQuery!: (v: "granted" | "prompt" | "denied") => void;
		const gate = new Promise<"granted" | "prompt" | "denied">((r) => {
			resolveQuery = r;
		});
		storage.queryPermission = mock(async () => gate) as any;
		storage.verifyPermission = mock(async () => true) as any;

		const doc = makeDocSession(storage, "", origin);
		doc.refreshPermissionState(false);
		// Newer grant lands while the query is in flight.
		const granted = await doc.requestPermission(true);
		expect(granted).toBe(true);
		expect(doc.permissionState).toBe("granted");

		resolveQuery("denied");
		await new Promise((r) => setTimeout(r, 10));
		expect(doc.permissionState).toBe("granted");
	});

	it("Workspace.requestRootPermission grant invalidates pending permission queries", async () => {
		const persistence = new MemorySessionPersistence();
		const storage = createMockStorage();
		let resolveQuery!: (v: "granted" | "prompt" | "denied") => void;
		const gate = new Promise<"granted" | "prompt" | "denied">((r) => {
			resolveQuery = r;
		});
		storage.queryPermission = mock(async () => gate) as any;
		storage.verifyPermission = mock(async () => true) as any;
		storage.readDirectory = mock(async () => []) as any;

		const ws = makeWorkspace(storage, persistence);
		ws.rootOrigin = { scheme: "file", path: "/root", name: "root" } as FileOrigin;
		ws.hasRootPermission = false;

		const docOrigin = { scheme: "file", path: "/root/test.txt", name: "test.txt" } as FileOrigin;
		const doc = makeDocSession(storage, "", docOrigin);
		ws.documents.push(doc);

		// Not covered yet (no root permission), so this issues an async query.
		doc.refreshPermissionState(ws.coversOrigin(docOrigin));
		const granted = await ws.requestRootPermission();
		expect(granted).toBe(true);
		expect(doc.permissionState).toBe("granted");

		resolveQuery("denied");
		await new Promise((r) => setTimeout(r, 10));
		expect(doc.permissionState).toBe("granted");
	});
});
