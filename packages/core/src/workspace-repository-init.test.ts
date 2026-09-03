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

let makeWorkspace: (
	detected: boolean
) => Promise<{ ws: Workspace }>;

beforeAll(async () => {
	const mod = await import("./workspace.svelte");

	makeWorkspace = async (detected: boolean) => {
		const storage = createMockStorage({
			pickDirectory: async () => rootOrigin,
			verifyPermission: async () => true
		});
		const vcsFactory = (): VCSAdapter => ({
			detect: mock(async () => detected),
			getCurrentBranch: async () => "main",
			getBranches: async () => ["main"],
			getChanges: async () => [],
			getCommits: async () => [],
			getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
			switchBranch: mock(async () => ({ status: "switched" as const }))
		});
		const ws = new mod.Workspace(storage, vcsFactory, new MemorySessionPersistence());
		return { ws };
	};
});

const rootOrigin: FileOrigin = { scheme: "file", path: "/projects/np", name: "np" };

describe("repository initialization respects VCS detect (issue #64)", () => {
	it("leaves workspace.repository null when the opened folder is not a git repository", async () => {
		const { ws } = await makeWorkspace(false);
		await ws.openDirectory();
		// Regression: previously the detect result was discarded and a Repository
		// was created unconditionally, so the Git panel's "No Git Repository"
		// empty state (guarded on repository === null) was unreachable.
		expect(ws.repository).toBeNull();
	});

	it("creates a Repository when the opened folder contains a git repository", async () => {
		const { ws } = await makeWorkspace(true);
		await ws.openDirectory();
		expect(ws.repository).not.toBeNull();
	});
});