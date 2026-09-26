import "../../../tests/contract/rune-setup";
import { describe, it, expect, mock, beforeAll, spyOn } from "bun:test";
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

let WorkspaceClass: typeof import("./workspace.svelte").Workspace;
beforeAll(async () => {
	const mod = await import("./workspace.svelte");
	WorkspaceClass = mod.Workspace;
});

function makeWorkspace(): Workspace {
	return new WorkspaceClass(
		createMockStorage(),
		() => ({}) as VCSAdapter,
		new MemorySessionPersistence()
	);
}

describe("closeTab is fire-and-forget but never silent", () => {
	it("reports a failed close instead of dropping the rejection", async () => {
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});
		const ws = makeWorkspace();
		const only = await ws.newFile();
		// Closing the last tab leaves only its replacement to await, and
		// closeTab returns before that settles.
		(ws as any).newFile = async () => {
			throw new Error("replacement tab unavailable");
		};

		ws.closeTab(only.id);
		// The close itself is complete; only the replacement failed.
		expect(ws.tabs.some((t) => t.id === only.id)).toBe(false);

		await new Promise((r) => setTimeout(r, 10));
		expect(errorSpy).toHaveBeenCalled();

		errorSpy.mockRestore();
	});
});
