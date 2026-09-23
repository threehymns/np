import "../../../tests/contract/rune-setup";
import { describe, it, expect, mock, beforeAll } from "bun:test";
import type { FileOrigin } from "./storage";
import { createMockStorage } from "../../../tests/mock-storage";
import { MemorySessionPersistence } from "./persistence";
import type { SwitchResult, VCSAdapter } from "./project/vcs";
import type { Workspace } from "./workspace.svelte";

beforeAll(async () => {
	mock.module("svelte/reactivity", () => ({
		SvelteMap: Map,
		SvelteSet: Set
	}));
});

const rootOrigin: FileOrigin = { scheme: "file", path: "/projects/np", name: "np" };
const otherOrigin: FileOrigin = { scheme: "file", path: "/projects/other", name: "other" };
const twinOrigin: FileOrigin = { scheme: "file", path: "/elsewhere/np", name: "np" };

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

interface Harness {
	ws: Workspace;
}

async function makeWorkspace(): Promise<Harness> {
	const mod = await import("./workspace.svelte");
	const storage = createMockStorage({
		pickDirectory: async () => otherOrigin,
		verifyPermission: async () => true
	});
	const vcsFactory = (): VCSAdapter => ({
		detect: mock(async () => true),
		getCurrentBranch: async () => "main",
		getBranches: async () => ["main"],
		getChanges: async () => [],
		getCommits: async () => [],
		getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
		switchBranch: mock(async (): Promise<SwitchResult> => ({ status: "switched" as const }))
	});
	const ws: Workspace = new mod.Workspace(storage, vcsFactory, new MemorySessionPersistence());
	return { ws };
}

describe("workspace project lifecycle (ticket #188)", () => {
	it("ignores a second project request while one is already running", async () => {
		const mod = await import("./workspace.svelte");
		const harness = await makeWorkspace();
		const ws = harness.ws;
		let resolveFirst!: (v: boolean) => void;
		let firstCalls = 0;
		const originalVerify = ws.storage.verifyPermission.bind(ws.storage);
		ws.storage.verifyPermission = mock(async () => {
			firstCalls++;
			if (firstCalls === 1) {
				return await new Promise<boolean>((resolve) => {
					resolveFirst = resolve;
				});
			}
			return true;
		});

		const first = ws.openDirectory(otherOrigin);
		const second = await ws.openDirectory(rootOrigin);
		expect(second).toBe(false);
		resolveFirst(true);
		expect(await first).toBe(true);
		expect(firstCalls).toBe(1);
		expect(ws.projectUri).toBe("file:///projects/other");
	});

	it("rolls the session back when the destination fails to load", async () => {
		const harness = await makeWorkspace();
		const ws = harness.ws;
		await ws.openDirectory(rootOrigin);
		const doc = await ws.newFile();
		ws.updateDocumentContent(doc, "Root draft");
		await ws.flushSaveOpenFiles();

		const persistence = ws.persistence as MemorySessionPersistence;
		persistence.loadOpenFiles = mock(async () => {
			throw new Error("load failed");
		});

		const ok = await ws.openDirectory(otherOrigin);
		expect(ok).toBe(false);
		expect(ws.projectUri).toBe("file:///projects/np");
		expect(ws.projectOpening).toBe(false);
		expect(ws.projectError).toBe("Failed to open folder: load failed");
		expect(ws.documents.map((d) => d.content)).toContain("Root draft");
	});

	it("preserves the outgoing session when a picker is cancelled or permission is denied", async () => {
		const harness = await makeWorkspace();
		const ws = harness.ws;
		await ws.openDirectory(rootOrigin);
		const doc = await ws.newFile();
		ws.updateDocumentContent(doc, "Keep me");

		const pick = ws.storage.pickDirectory.bind(ws.storage);
		ws.storage.pickDirectory = mock(async () => null);
		expect(await ws.openDirectory()).toBe(false);
		expect(ws.projectUri).toBe("file:///projects/np");
		expect(ws.projectOpening).toBe(false);
		expect(ws.projectError).toBeNull();

		ws.storage.pickDirectory = pick;
		ws.storage.verifyPermission = mock(async () => false);
		expect(await ws.openDirectory(otherOrigin)).toBe(false);
		expect(ws.projectUri).toBe("file:///projects/np");
		expect(ws.documents.map((d) => d.content)).toContain("Keep me");
		expect(ws.projectError).toContain("Permission denied");
	});

	it("keeps twin-basename recent folders distinct and honors the identity order", async () => {
		const harness = await makeWorkspace();
		const ws = harness.ws;
		await ws.openDirectory(rootOrigin);
		await ws.openDirectory(twinOrigin);
		await ws.openDirectory(rootOrigin);
		expect(ws.recentFolders.map((f) => `${f.name}@${f.path}`)).toEqual([
			"np@/projects/np",
			"np@/elsewhere/np"
		]);
	});

	it("never pairs a newly selected project with the old repository after a failed open", async () => {
		const harness = await makeWorkspace();
		const ws = harness.ws;
		await ws.openDirectory(rootOrigin);
		const oldRepo = ws.repository;
		expect(oldRepo).not.toBeNull();

		const persistence = ws.persistence as MemorySessionPersistence;
		persistence.loadOpenFiles = mock(async () => {
			throw new Error("boom");
		});
		await ws.openDirectory(otherOrigin);

		expect(ws.repository).toBe(oldRepo);
		expect(ws.projectUri).toBe("file:///projects/np");
		ws.storage.pickDirectory = mock(async () => otherOrigin);
		persistence.loadOpenFiles = async (uri: string) =>
			(await MemorySessionPersistence.prototype.loadOpenFiles.call(persistence, uri)) ?? [];
		ws.storage.verifyPermission = async () => true;
		expect(await ws.openDirectory(otherOrigin)).toBe(true);
		expect(ws.repository).not.toBeNull();
		expect(ws.repository).not.toBe(oldRepo);
		expect(ws.projectUri).toBe("file:///projects/other");
	});
});

describe("stale branch safety against project changes (ticket #188)", () => {
	it("returns a stale identity error when the repository is replaced before switching", async () => {
		const harness = await makeWorkspace();
		const ws = harness.ws;
		await ws.openDirectory(rootOrigin);
		const target = ws.captureProject();
		const oldRepo = ws.repository!;
		oldRepo.adapter.getCurrentBranch = mock(async () => {
			await new Promise((r) => setTimeout(r, 25));
			return "main";
		});
		const preflight = ws.getBranchSafetyReport("feature", target);
		await ws.openDirectory(otherOrigin);
		const result = await ws.switchBranch("feature", target);
		await preflight;
		expect(result.status).toBe("error");
		expect(ws.projectUri).toBe("file:///projects/other");
	});

	it("rejects a branch switch when a project mutation is already running", async () => {
		const harness = await makeWorkspace();
		const ws = harness.ws;
		await ws.openDirectory(rootOrigin);
		const target = ws.captureProject();
		const releaseScan = deferred<void>();
		const tree = ws.projectTree as unknown as { scan: (origin: FileOrigin) => Promise<void> };
		const originalScan = tree.scan.bind(ws.projectTree);
		ws.projectTree.scan = mock(async (origin: FileOrigin) => {
			await releaseScan.promise;
			await originalScan(origin);
		});
		const opening = ws.openDirectory(otherOrigin);
		await new Promise((r) => setTimeout(r, 0));
		const result = await ws.switchBranch("main", target);
		expect(result.status).toBe("error");
		expect(ws.projectMutationBusy).toBe(true);
		releaseScan.resolve();
		await opening;
		expect(ws.projectUri).toBe("file:///projects/other");
		expect(ws.projectMutationBusy).toBe(false);
	});

	it("rejects a preflight that resolves after the project changed", async () => {
		const harness = await makeWorkspace();
		const ws = harness.ws;
		await ws.openDirectory(rootOrigin);
		const target = ws.captureProject();
		const repo = ws.repository!;
		const gate = deferred<boolean>();
		repo.adapter.getStatus = mock(async () => {
			await gate.promise;
			return { isDirty: false, uncommittedFiles: [] };
		});
		const reportPromise = ws.getBranchSafetyReport("feature", target);
		await ws.openDirectory(otherOrigin);
		gate.resolve(false);
		const report = await reportPromise;
		expect(report).toBeNull();
		expect(ws.projectUri).toBe("file:///projects/other");
	});
});

describe("source control state scoping (ticket #188)", () => {
	it("stores commit drafts per project URI and restores them after returning", async () => {
		const harness = await makeWorkspace();
		const ws = harness.ws;
		await ws.openDirectory(rootOrigin);
		ws.commitDrafts[ws.projectUri] = "Draft for np";
		await ws.openDirectory(otherOrigin);
		ws.commitDrafts[ws.projectUri] = "Draft for other";
		await ws.openDirectory(rootOrigin);
		expect(ws.commitDrafts["file:///projects/np"]).toBe("Draft for np");
		expect(ws.commitDrafts["file:///projects/other"]).toBe("Draft for other");
		expect(ws.commitDrafts["file:///elsewhere/np"]).toBeUndefined();
	});

	it("a delayed refresh on the old repository cannot become the new project's identity", async () => {
		const harness = await makeWorkspace();
		const ws = harness.ws;
		await ws.openDirectory(rootOrigin);
		const oldRepo = ws.repository!;
		let releaseBranch!: (v: string | null) => void;
		const gate = new Promise<string | null>((r) => {
			releaseBranch = r;
		});
		oldRepo.adapter.getCurrentBranch = mock(async () => await gate);
		void oldRepo.refresh();

		await ws.openDirectory(otherOrigin);
		const newRepoBefore = ws.repository;
		releaseBranch("stale-branch");
		await new Promise((r) => setTimeout(r, 10));

		expect(ws.repository).toBe(newRepoBefore);
		expect(ws.repository).not.toBe(oldRepo);
		expect(ws.currentBranch).toBe("main");
		expect(ws.projectUri).toBe("file:///projects/other");
	});
});
