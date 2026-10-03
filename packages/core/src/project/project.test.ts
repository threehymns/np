import "../../../../tests/contract/rune-setup";
import { describe, it, expect, mock, beforeAll } from "bun:test";
import { createMockStorage } from "../../../../tests/mock-storage";
import { MemorySessionPersistence } from "../persistence";
import type { VCSAdapter } from "./vcs";
import type { FileOrigin } from "../storage";

let ProjectClass: typeof import("./project.svelte").Project;
let WorkspaceClass: typeof import("../workspace.svelte").Workspace;

beforeAll(async () => {
	const mod = await import("./project.svelte");
	ProjectClass = mod.Project;
	const wsMod = await import("../workspace.svelte");
	WorkspaceClass = wsMod.Workspace;
});

function makeVcsFactory(): (root: FileOrigin) => VCSAdapter {
	return () => ({
		detect: mock(async () => false),
		getCurrentBranch: async () => null,
		getBranches: async () => [],
		getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
		switchBranch: mock(async () => ({ status: "error" as const, message: "none" }))
	});
}

/**
 * #251 pin: Project is the single owner of the scheme-and-prefix coverage
 * rule. Workspace exposes no coverage API after #253 — single ownership by
 * absence. If this test fails because Workspace regrows coversOrigin or
 * relativePath, behaviour moved and must be reported, not absorbed.
 */
describe("Project coverage single ownership (#251)", () => {
	it("pins the scheme-and-prefix rule on Project with Workspace exposing no coverage API", () => {
		const root: FileOrigin = { scheme: "file", path: "/proj", name: "proj" };
		const project = new ProjectClass(createMockStorage(), makeVcsFactory(), new MemorySessionPersistence());
		project.rootOrigin = root;

		// Not covered before permission is granted.
		expect(project.coversOrigin({ scheme: "file", path: "/proj/a.md", name: "a.md" })).toBe(false);
		expect(project.relativePath({ scheme: "file", path: "/proj/a.md", name: "a.md" })).toBeNull();

		project.hasRootPermission = true;

		// Root itself is a zero-length relative path.
		expect(project.relativePath(root)).toBe("");
		expect(project.coversOrigin(root)).toBe(true);
		// Inside the root.
		expect(project.relativePath({ scheme: "file", path: "/proj/a.md", name: "a.md" })).toBe("a.md");
		expect(project.coversOrigin({ scheme: "file", path: "/proj/a.md", name: "a.md" })).toBe(true);
		// Different scheme is not covered.
		expect(project.coversOrigin({ scheme: "other", path: "/proj/a.md", name: "a.md" })).toBe(false);
		// Prefix sibling is not covered (/proj2 must not match /proj).
		expect(project.coversOrigin({ scheme: "file", path: "/proj2/a.md", name: "a.md" })).toBe(false);

		// Workspace exposes no coverage API after #253 — single ownership by
		// absence; all coverage flows through ws.project.
		const ws = new WorkspaceClass(createMockStorage(), makeVcsFactory(), new MemorySessionPersistence());
		expect((ws as any).coversOrigin).toBeUndefined();
		expect((ws as any).relativePath).toBeUndefined();
	});
});
