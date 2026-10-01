import "../../../tests/contract/rune-setup";
import { describe, it, expect, mock, beforeAll } from "bun:test";
import { createMockStorage } from "../../../tests/mock-storage";
import { MemorySessionPersistence } from "./persistence";
import type { VCSAdapter } from "./project/vcs";
import type { FileOrigin } from "./storage";

let WorkspaceClass: typeof import("./workspace.svelte").Workspace;
let PluginHostClass: typeof import("./plugins/host.svelte").PluginHost;

beforeAll(async () => {
	const mod = await import("./workspace.svelte");
	WorkspaceClass = mod.Workspace;
	const hostMod = await import("./plugins/host.svelte");
	PluginHostClass = hostMod.PluginHost;
});

function makeVcsFactory(): (root: FileOrigin) => VCSAdapter {
	return () => ({
		detect: mock(async () => true),
		getCurrentBranch: async () => "main",
		getBranches: async () => ["main"],
		getChanges: async () => [],
		getCommits: async () => [],
		getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
		switchBranch: mock(async () => ({ status: "switched" as const }))
	});
}

/**
 * Off-state gating (AC1): shell UI gates on repository presence today, so a
 * repository left behind by a bounded-cleanup timeout stays live. The
 * workspace must expose the repository only while its owning plugin is
 * active, without naming any feature (shell stays `git`-free).
 */
describe("workspace repository off-state gating", () => {
	it("hides branch state and refuses writes when the owning plugin is off", async () => {
		const host = new PluginHostClass();
		host.register({ manifest: { id: "vcs-owner", name: "VCS Owner", version: 0 }, setup: () => {} });
		const ws = new WorkspaceClass(createMockStorage(), makeVcsFactory(), new MemorySessionPersistence(), host as any);
		await host.activate("vcs-owner");

		// Simulate a published repository owned by the contributor.
		(ws as any).repository = { currentBranch: "main", branches: ["main"], switchBranch: async () => ({ status: "switched" }) };
		(ws as any).repositoryOwnerId = "vcs-owner";

		expect((ws as any).isRepositoryActive).toBe(true);
		expect(ws.currentBranch).toBe("main");

		await host.deactivate("vcs-owner");

		// Stale slot stays, but the workspace no longer exposes it.
		expect((ws as any).isRepositoryActive).toBe(false);
		expect(ws.currentBranch).toBeNull();
		expect(ws.branches).toEqual([]);
		expect(await ws.getBranchSafetyReport("other")).toBeNull();
		const result = await ws.switchBranch("other");
		expect(result.status).toBe("error");
	});
});
