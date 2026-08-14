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
		mock.module("phosphor-svelte", () => ({
			File: () => {},
			FileCode: () => {},
			FileText: () => {},
			Code: () => {},
			Globe: () => {},
			Database: () => {},
			Gear: () => {},
			Folder: () => {},
			FolderOpen: () => {}
		}));
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

	it("preserves fast path for non-forced restoreSession calls", async () => {
		let loadAllCount = 0;
		const mockPersistence = createMockPersistence(() => {
			loadAllCount++;
		});
		const mockStorage = createMockStorage();

		const appState = new AppState({
			storage: mockStorage,
			vcsFactory: () => ({} as any),
			persistence: mockPersistence
		});

		const p1 = appState.workspace.restoreSession();
		const p2 = appState.workspace.restoreSession();
		const p3 = appState.workspace.restoreSession(false);

		expect(p1).toBe(p2);
		expect(p2).toBe(p3);

		await Promise.all([p1, p2, p3]);
		expect(loadAllCount).toBe(1);
	});

	it("serializes forced restoreSession calls and coordinates isRestoring", async () => {
		const timeline: string[] = [];
		const isRestoringChecks: boolean[] = [];

		let resolveLoad1: () => void;
		const load1Promise = new Promise<void>((res) => {
			resolveLoad1 = res;
		});

		let resolveLoad2: () => void;
		const load2Promise = new Promise<void>((res) => {
			resolveLoad2 = res;
		});

		let callIndex = 0;
		const mockPersistence = createMockPersistence();
		mockPersistence.loadAll = mock(async () => {
			const currentCall = ++callIndex;
			timeline.push(`loadAll_${currentCall}_start`);
			if (currentCall === 1) {
				await load1Promise;
			} else if (currentCall === 2) {
				await load2Promise;
			}
			timeline.push(`loadAll_${currentCall}_end`);
			return {};
		});

		const mockStorage = createMockStorage();
		const appState = new AppState({
			storage: mockStorage,
			vcsFactory: () => ({} as any),
			persistence: mockPersistence
		});

		// Start initial restore
		const p1 = appState.workspace.restoreSession();
		expect(appState.workspace.isRestoring).toBe(true);

		// Trigger forced restore while p1 is in flight
		const p2 = appState.workspace.restoreSession(true);

		// p2 should not start loadAll until p1 completes
		expect(timeline).toEqual(["loadAll_1_start"]);

		// Finish first restore
		resolveLoad1!();
		await p1;

		// When p1 finishes, isRestoring should STILL be true because p2 is queued/executing
		isRestoringChecks.push(appState.workspace.isRestoring);

		// Now loadAll_2 should have started or start next
		// Let p2 finish
		resolveLoad2!();
		await p2;

		expect(timeline).toEqual([
			"loadAll_1_start",
			"loadAll_1_end",
			"loadAll_2_start",
			"loadAll_2_end"
		]);
		expect(isRestoringChecks).toEqual([true]);
		expect(appState.workspace.isRestoring).toBe(false);
	});

	it("coordinates isRestoring across multiple queued forced restores", async () => {
		let resolve1: () => void;
		let resolve2: () => void;
		let resolve3: () => void;
		const pLoad1 = new Promise<void>((r) => (resolve1 = r));
		const pLoad2 = new Promise<void>((r) => (resolve2 = r));
		const pLoad3 = new Promise<void>((r) => (resolve3 = r));

		let callCount = 0;
		const mockPersistence = createMockPersistence();
		mockPersistence.loadAll = mock(async () => {
			const idx = ++callCount;
			if (idx === 1) await pLoad1;
			if (idx === 2) await pLoad2;
			if (idx === 3) await pLoad3;
			return {};
		});

		const mockStorage = createMockStorage();
		const appState = new AppState({
			storage: mockStorage,
			vcsFactory: () => ({} as any),
			persistence: mockPersistence
		});

		const p1 = appState.workspace.restoreSession(true);
		const p2 = appState.workspace.restoreSession(true);
		const p3 = appState.workspace.restoreSession(true);

		expect(appState.workspace.isRestoring).toBe(true);

		// Resolve p1
		resolve1!();
		await p1;
		expect(appState.workspace.isRestoring).toBe(true);

		// Resolve p2
		resolve2!();
		await p2;
		expect(appState.workspace.isRestoring).toBe(true);

		// Resolve p3
		resolve3!();
		await p3;
		expect(appState.workspace.isRestoring).toBe(false);
		expect(callCount).toBe(3);
	});

	it("runs forced restore even if previous restore encountered an error", async () => {
		let callCount = 0;
		const mockPersistence = createMockPersistence();
		mockPersistence.loadAll = mock(async () => {
			callCount++;
			if (callCount === 1) {
				throw new Error("Disk read error");
			}
			return {};
		});

		const mockStorage = createMockStorage();
		const appState = new AppState({
			storage: mockStorage,
			vcsFactory: () => ({} as any),
			persistence: mockPersistence
		});

		// Call 1 fails internally and recovers with default empty document
		await appState.workspace.restoreSession(true);
		expect(callCount).toBe(1);
		expect(appState.workspace.isRestoring).toBe(false);

		// Call 2 forced succeeds
		await appState.workspace.restoreSession(true);
		expect(callCount).toBe(2);
		expect(appState.workspace.isRestoring).toBe(false);
	});
});
