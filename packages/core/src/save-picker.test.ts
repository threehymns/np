import "../../../tests/contract/rune-setup";
import { describe, it, expect, mock, beforeAll } from "bun:test";
import { toSuggestedSaveName, type FileOrigin } from "./storage";
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

describe("toSuggestedSaveName", () => {
	it("appends .md to a bare draft title", () => {
		expect(toSuggestedSaveName("Untitled 1")).toBe("Untitled 1.md");
	});

	it("keeps an existing extension", () => {
		expect(toSuggestedSaveName("My Note.md")).toBe("My Note.md");
	});

	it("falls back for empty titles", () => {
		expect(toSuggestedSaveName("")).toBe("untitled.md");
		expect(toSuggestedSaveName("   ")).toBe("untitled.md");
	});

	it("strips path separators so the title cannot escape the folder", () => {
		const name = toSuggestedSaveName("../outside");
		expect(name).not.toContain("/");
		expect(name).not.toContain("..");
		expect(name).toBe("-outside.md");
	});
});

describe("save picker defaults (issue #174)", () => {
	it("passes the draft title and workspace folder when saving an untitled document", async () => {
		const storage = createMockStorage();
		const persistence = new MemorySessionPersistence();
		const ws = makeWorkspace(storage, persistence);
		await ws.restoreSession();
		ws.rootOrigin = { scheme: "file", path: "/projects/np", name: "np" };

		const doc = makeDocSession(storage, "hello", null, "My Draft");
		storage.saveFile = mock(async () => ({ scheme: "file", path: "/projects/np/My Draft.md", name: "My Draft.md" })) as any;

		await ws.saveDocument(doc);

		expect(storage.saveFile).toHaveBeenCalled();
		const [, targetOrigin, options] = (storage.saveFile as any).mock.calls[0];
		expect(targetOrigin).toBeUndefined();
		expect(options?.suggestedName).toBe("My Draft.md");
		expect(options?.startDirectory).toEqual({ scheme: "file", path: "/projects/np", name: "np" });
	});

	it("falls back to a safe name with no directory when no workspace folder is open", async () => {
		const storage = createMockStorage();
		const persistence = new MemorySessionPersistence();
		const ws = makeWorkspace(storage, persistence);
		await ws.restoreSession();
		expect(ws.rootOrigin).toBeNull();

		const doc = makeDocSession(storage, "hello", null, "Untitled 1");
		storage.saveFile = mock(async () => ({ scheme: "file", path: "/tmp/Untitled 1.md", name: "Untitled 1.md" })) as any;

		await ws.saveDocument(doc);

		const [, , options] = (storage.saveFile as any).mock.calls[0];
		expect(options?.suggestedName).toBe("Untitled 1.md");
		expect(options?.startDirectory).toBeNull();
	});

	it("does not pass picker hints when saving a file-backed document", async () => {
		const storage = createMockStorage({
			verifyPermission: async () => true,
			queryPermission: async () => "granted"
		});
		const persistence = new MemorySessionPersistence();
		const ws = makeWorkspace(storage, persistence);
		await ws.restoreSession();
		ws.rootOrigin = { scheme: "file", path: "/projects/np", name: "np" };

		const origin = { scheme: "file", path: "/projects/np/existing.md", name: "existing.md" } as FileOrigin;
		const doc = makeDocSession(storage, "updated", origin);
		storage.saveFile = mock(async () => origin) as any;

		await ws.saveDocument(doc);

		const [, targetOrigin, options] = (storage.saveFile as any).mock.calls[0];
		expect(targetOrigin).toEqual(origin);
		expect(options?.suggestedName).toBeUndefined();
		expect(options?.startDirectory).toBeUndefined();
	});
});
