(globalThis as any).$state = Object.assign(<T>(v: T) => v, {
	snapshot: <T>(v: T) => v,
	raw: <T>(v: T) => v
});
(globalThis as any).$derived = Object.assign(<T>(v: T) => v, {
	by: (fn: any) => fn()
});
(globalThis as any).$effect = Object.assign(() => {}, {
	root: (cb: () => void) => { cb(); return () => {}; }
});

import { describe, it, expect, mock, beforeAll } from "bun:test";
import type { SessionPersistence } from "./persistence";
import type { Storage } from "./storage";

function createMockPersistence(onLoadAll?: () => void): SessionPersistence {
	return {
		saveOpenFiles: mock(async () => {}),
		loadOpenFiles: mock(async () => []),
		saveRootFolder: mock(async () => {}),
		loadRootFolder: mock(async () => null),
		saveRecentFolders: mock(async () => {}),
		loadRecentFolders: mock(async () => []),
		saveExpandedPaths: mock(async () => {}),
		loadExpandedPaths: mock(async () => []),
		saveActiveDocumentId: mock(async () => {}),
		loadActiveDocumentId: mock(async () => null),
		loadAll: mock(async () => {
			onLoadAll?.();
			return {};
		})
	};
}

function createMockStorage(): Storage {
	return {
		readFile: mock(async () => ""),
		writeFile: mock(async () => {}),
		deleteFile: mock(async () => {}),
		listDirectory: mock(async () => []),
		createDirectory: mock(async () => {}),
		deleteDirectory: mock(async () => {}),
		exists: mock(async () => true),
		stat: mock(async () => ({ isFile: true, isDirectory: false, size: 0, mtime: 0 })),
		pickFile: mock(async () => null),
		pickDirectory: mock(async () => null),
		queryPermission: mock(async () => "prompt" as const),
		verifyPermission: mock(async () => false)
	};
}

describe("AppState / Workspace SSR & Initialization", () => {
	let AppState: any;

	beforeAll(async () => {
		const mod = await import("./state.svelte");
		AppState = mod.AppState;
	});

	it("does not restore session, open DB, or create untitled documents during construction", () => {
		let loadAllCalled = false;
		const mockPersistence = createMockPersistence(() => {
			loadAllCalled = true;
		});
		const mockStorage = createMockStorage();

		const appState = new AppState({
			storage: mockStorage,
			vcsFactory: () => ({} as any),
			persistence: mockPersistence
		});

		// During SSR / synchronous construction:
		expect(loadAllCalled).toBe(false);
		expect(appState.workspace.documents.length).toBe(0);
		expect(appState.workspace.tabs.length).toBe(0);
	});

	it("restores session and creates initial file on appState.init()", async () => {
		let loadAllCalled = false;
		const mockPersistence = createMockPersistence(() => {
			loadAllCalled = true;
		});
		const mockStorage = createMockStorage();

		const appState = new AppState({
			storage: mockStorage,
			vcsFactory: () => ({} as any),
			persistence: mockPersistence
		});

		expect(loadAllCalled).toBe(false);

		await appState.init();

		expect(loadAllCalled).toBe(true);
		expect(appState.workspace.documents.length).toBe(1);
		expect(appState.workspace.tabs.length).toBe(1);
		expect(appState.workspace.documents[0].fileName).toBe("Untitled 1");
	});
});
