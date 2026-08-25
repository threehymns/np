import "../../../tests/contract/rune-setup";
import { describe, it, expect, mock, beforeAll } from "bun:test";
import type { FileOrigin } from "./storage";
import { createMockStorage } from "../../../tests/mock-storage";
import { MemorySessionPersistence } from "./persistence";
import type { VCSAdapter } from "./project/vcs";
import type { Workspace, WorkspaceTab } from "./workspace.svelte";

beforeAll(async () => {
	mock.module("svelte/reactivity", () => ({
		SvelteMap: Map,
		SvelteSet: Set
	}));
});

let makeWorkspace: (persistence: MemorySessionPersistence) => Workspace;
beforeAll(async () => {
	const mod = await import("./workspace.svelte");
	makeWorkspace = (persistence) =>
		new mod.Workspace(
			createMockStorage(),
			() => ({}) as VCSAdapter,
			persistence
		);
});

function docTabs(tabs: WorkspaceTab[]): string[] {
	return tabs.filter(t => t.type === 'document').map(t => t.id);
}

describe("tab ordering stays in lockstep", () => {
	it("reorderDocuments permutes tabs to match the new document order and persists it", async () => {
		const persistence = new MemorySessionPersistence();
		const ws = makeWorkspace(persistence);
		await ws.restoreSession();

		const first = ws.documents[0];
		const second = await ws.openFile({ scheme: 'file', path: '/projects/np/a.md', name: 'a.md' });
		const third = await ws.openFile({ scheme: 'file', path: '/projects/np/b.md', name: 'b.md' });

		ws.reorderDocuments([third!, first, second!]);

		expect(docTabs(ws.tabs)).toEqual([third!.id, first.id, second!.id]);

		ws.flushSaveOpenFiles();
		const saved = await persistence.loadOpenFiles('');
		expect(saved.map(s => s.id)).toEqual(ws.tabs.map(t => t.id));
	});

	it("moveTab keeps the documents array in lockstep for document tabs", async () => {
		const ws = makeWorkspace(new MemorySessionPersistence());
		await ws.restoreSession();

		const first = ws.documents[0];
		await ws.openFile({ scheme: 'file', path: '/projects/np/a.md', name: 'a.md' });
		await ws.openFile({ scheme: 'file', path: '/projects/np/b.md', name: 'b.md' });
		const [, second, third] = ws.documents;

		ws.moveTab(2, 0);

		expect(ws.tabs.map(t => t.id)).toEqual([third!.id, first.id, second!.id]);
		expect(ws.documents.map(d => d.id)).toEqual([third!.id, first.id, second!.id]);
	});
});
