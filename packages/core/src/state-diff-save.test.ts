import "../../../tests/contract/rune-setup";
import { describe, it, expect, mock, beforeAll } from "bun:test";
import type { FileOrigin } from "./storage";
import { createMockStorage } from "../../../tests/mock-storage";
import { MemorySessionPersistence } from "./persistence";

let AppState: any;
beforeAll(async () => {
	const mod = await import("./state.svelte");
	AppState = mod.AppState;
});

const rootOrigin: FileOrigin = { scheme: "file", path: "/projects/np", name: "np" };

function makeApp() {
	const disk = new Map<string, string>();
	disk.set("/projects/np/src/a.ts", "line1\nline2\n");
	const storage = createMockStorage({
		verifyPermission: async () => true,
		queryPermission: async () => "granted"
	});
	storage.readFile = mock(async (origin: FileOrigin) => {
		const content = disk.get(origin.path);
		if (content === undefined) {
			const err = new Error("not found") as any;
			err.code = "ENOENT";
			throw err;
		}
		return content;
	}) as any;
	storage.saveFile = mock(async (content: string, existingOrigin?: FileOrigin, _options?: any) => {
		const origin = existingOrigin ?? { scheme: "file", path: "/projects/np/Untitled 1.md", name: "Untitled 1.md" };
		disk.set(origin.path, content);
		return origin;
	}) as any;
	const appState = new AppState({
		storage,
		vcsFactory: () => ({} as any),
		persistence: new MemorySessionPersistence()
	});
	appState.workspace.project.rootOrigin = rootOrigin;
	appState.workspace.project.hasRootPermission = true;
	return { appState, storage, disk };
}

function activateDiffTab(appState: any) {
	appState.workspace.tabs.push({ id: "__project_diff__", type: "diff", pluginId: "git" });
	appState.workspace.activeTabId = "__project_diff__";
}

describe("diff pane save routing (#269)", () => {
	it("saves the bound diff Document through the standard save path with focus in the diff pane", async () => {
		const { appState, storage, disk } = makeApp();
		const origin: FileOrigin = { scheme: "file", path: "/projects/np/src/a.ts", name: "a.ts" };
		const doc = await appState.workspace.openFile(origin);
		activateDiffTab(appState);
		expect(appState.activeDocument).toBeUndefined();

		// Pane keystrokes land on the shared Document via the keystroke path.
		appState.activeDiffDocument = doc;
		appState.workspace.updateDocumentContent(doc, "line1 edited\nline2\n");
		expect(doc.isModified).toBe(true);

		const ok = await appState.saveFile();

		expect(ok).toBe(true);
		expect(storage.saveFile).toHaveBeenCalledTimes(1);
		const [savedContent, targetOrigin] = (storage.saveFile as any).mock.calls[0];
		expect(savedContent).toBe("line1 edited\nline2\n");
		expect(targetOrigin).toEqual(origin);
		expect(disk.get("/projects/np/src/a.ts")).toBe("line1 edited\nline2\n");
		expect(doc.isModified).toBe(false);
	});

	it("prefers the active tab Document over the diff save target", async () => {
		const { appState, storage } = makeApp();
		const origin: FileOrigin = { scheme: "file", path: "/projects/np/src/a.ts", name: "a.ts" };
		const tabDoc = await appState.workspace.openFile(origin);
		appState.workspace.updateDocumentContent(tabDoc, "tab edit\n");

		const other = await appState.workspace.openFile(origin);
		expect(other).toBe(tabDoc);
		// Still on the document tab, but a stale diff target lingers.
		appState.activeDiffDocument = tabDoc;

		await appState.saveFile();

		expect(storage.saveFile).toHaveBeenCalledTimes(1);
		expect((storage.saveFile as any).mock.calls[0][0]).toBe("tab edit\n");
	});

	it("saves the diff Document via Save As through the same path", async () => {
		const { appState, storage } = makeApp();
		const origin: FileOrigin = { scheme: "file", path: "/projects/np/src/a.ts", name: "a.ts" };
		const doc = await appState.workspace.openFile(origin);
		activateDiffTab(appState);
		appState.activeDiffDocument = doc;
		appState.workspace.updateDocumentContent(doc, "as-edited\n");

		const ok = await appState.saveFileAs();

		expect(ok).toBe(true);
		const [, targetOrigin, options] = (storage.saveFile as any).mock.calls[0];
		expect(targetOrigin).toBeUndefined();
		expect(options?.suggestedName).toBe("a.ts");
	});

	it("does nothing when neither a document tab nor a diff Document is active", async () => {
		const { appState, storage } = makeApp();
		activateDiffTab(appState);
		expect(appState.activeDiffDocument).toBeUndefined();

		const ok = await appState.saveFile();

		expect(ok).toBeUndefined();
		expect(storage.saveFile).not.toHaveBeenCalled();
	});
});
