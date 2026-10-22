import "../../../tests/contract/rune-setup";
import { describe, it, expect, beforeAll, mock } from "bun:test";
import { createMockStorage } from "../../../tests/mock-storage";
import { MemorySessionPersistence } from "./persistence";
import type { VCSAdapter } from "./project/vcs";
import { CommandRegistry, registerCoreCommands } from "./commands.svelte";
import { commandSearchText } from "./plugins/commands";
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

/** Lets fire-and-forget close chains (closeTab → finalizeClose → performClose) settle. */
const flush = () => new Promise((r) => setTimeout(r, 10));

describe("Pane tab close commands", () => {
	describe("1. Workspace tab-close operations", () => {
		it("closeAllTabs closes every tab of the active pane", async () => {
			const ws = makeWorkspace();
			await ws.newFile();
			await ws.newFile();
			expect(ws.getPaneTabs().length).toBe(2);

			await ws.closeAllTabs();
			await flush();

			expect(ws.getPaneTabs().length).toBe(0);
		});

		it("closeAllTabs asks before discarding a dirty last tab instead of closing silently", async () => {
			const ws = makeWorkspace();
			const doc = await ws.newFile();
			ws.updateDocumentContent(doc, "Modified content");
			expect(doc.isModified).toBe(true);

			await ws.closeAllTabs();
			await flush();

			// The save/discard prompt owns the close until it is answered.
			expect(ws.pendingCloseId).toBe(doc.id);
			expect(ws.getPaneTabs().length).toBe(1);
		});

		it("closeOtherTabs keeps the active tab and closes the rest", async () => {
			const ws = makeWorkspace();
			const doc1 = await ws.newFile();
			const doc2 = await ws.newFile();
			expect(ws.getPaneTabs().map((t) => t.id)).toEqual([doc1.id, doc2.id]);

			await ws.closeOtherTabs();
			await flush();

			expect(ws.getPaneTabs().length).toBe(1);
			expect(ws.getPaneTabs()[0].id).toBe(doc2.id);
		});

		it("closeCleanTabs closes clean tabs and keeps dirty ones", async () => {
			const ws = makeWorkspace();
			const clean = await ws.newFile();
			const dirty = await ws.newFile();
			ws.updateDocumentContent(dirty, "Unsaved work");
			expect(dirty.isModified).toBe(true);
			expect(clean.isModified).toBe(false);

			await ws.closeCleanTabs();
			await flush();

			expect(ws.getPaneTabs().length).toBe(1);
			expect(ws.getPaneTabs()[0].id).toBe(dirty.id);
		});

		it("closeTabsToLeft closes the tabs ordered before the active tab", async () => {
			const ws = makeWorkspace();
			const doc1 = await ws.newFile();
			const doc2 = await ws.newFile();
			const doc3 = await ws.newFile();
			ws.activePaneId = ws.findPaneWithTab(doc3.id)!.id;
			ws.activePane.activeTabId = doc3.id;

			await ws.closeTabsToLeft();
			await flush();

			expect(ws.getPaneTabs().length).toBe(1);
			expect(ws.getPaneTabs()[0].id).toBe(doc3.id);
		});

		it("closeTabsToRight closes the tabs ordered after the active tab", async () => {
			const ws = makeWorkspace();
			const doc1 = await ws.newFile();
			const doc2 = await ws.newFile();
			const doc3 = await ws.newFile();
			ws.activePaneId = ws.findPaneWithTab(doc1.id)!.id;
			ws.activePane.activeTabId = doc1.id;

			await ws.closeTabsToRight();
			await flush();

			expect(ws.getPaneTabs().length).toBe(1);
			expect(ws.getPaneTabs()[0].id).toBe(doc1.id);
		});

		it("closeMultibufferTabs closes diff and search tabs but keeps document tabs", async () => {
			const ws = makeWorkspace();
			const doc = await ws.newFile();
			ws.tabs = [
				{ id: doc.id, type: "document" },
				{ id: "diff-1", type: "diff", pluginId: "git" },
				{ id: "search-1", type: "search" }
			] as any;
			expect(ws.getPaneTabs().length).toBe(3);

			await ws.closeMultibufferTabs();
			await flush();

			expect(ws.getPaneTabs().length).toBe(1);
			expect(ws.getPaneTabs()[0].type).toBe("document");
		});

		it("reopenClosedTab puts the most recently closed tab back", async () => {
			const ws = makeWorkspace();
			const doc = await ws.newFile();

			expect(ws.reopenClosedTab()).toBe(false);
			await ws.closeTab(doc.id);
			await flush();
			expect(ws.getPaneTabs().length).toBe(0);

			expect(ws.reopenClosedTab()).toBe(true);
			await flush();

			expect(ws.getPaneTabs().length).toBe(1);
			expect(ws.getPaneTabs()[0].id).toBe(doc.id);
			expect(ws.activePane.activeTabId).toBe(doc.id);
		});
	});

	describe("2. Command registration", () => {
		function makePaneCommandHarness() {
			const commands = new CommandRegistry();
			const executed: string[] = [];
			registerCoreCommands({
				commands,
				workspace: {
					splitActivePane: () => {},
					focusPaneInDirection: () => true,
					closeAllTabs: async () => {
						executed.push("closeAllTabs");
					},
					closeOtherTabs: async () => {
						executed.push("closeOtherTabs");
					},
					closeCleanTabs: async () => {
						executed.push("closeCleanTabs");
					},
					closeMultibufferTabs: async () => {
						executed.push("closeMultibufferTabs");
					},
					closeTabsToLeft: async () => {
						executed.push("closeTabsToLeft");
					},
					closeTabsToRight: async () => {
						executed.push("closeTabsToRight");
					},
					reopenClosedTab: () => {
						executed.push("reopenClosedTab");
						return true;
					}
				},
				closeTab: (id: string) => {
					executed.push(`closeTab:${id}`);
				}
			} as any);
			return { commands, executed };
		}

		it("registers the pane tab close commands under the View category", () => {
			const { commands } = makePaneCommandHarness();

			const ids = [
				"pane.closeAllTabs",
				"pane.closeOtherTabs",
				"pane.closeCleanTabs",
				"pane.closeActiveTab",
				"pane.reopenClosedTab",
				"pane.closeMultibufferTabs",
				"pane.closeTabsToLeft",
				"pane.closeTabsToRight"
			];

			for (const id of ids) {
				const command = commands.get(id)!;
				expect(command.category).toBe("View");
				expect(command.label.startsWith("Pane: ")).toBe(true);
				expect(command.keywords).toContain("pane");
				// The palette matches a query against the search text, so the
				// keyword has to be in it for "pane" to find the command.
				expect(commandSearchText(command)).toContain("pane");
			}
		});

		it("runs the close-all-tabs command through the workspace", async () => {
			const { commands, executed } = makePaneCommandHarness();
			await commands.execute("pane.closeAllTabs");
			expect(executed).toEqual(["closeAllTabs"]);
		});

		it("runs the close-other-tabs command through the workspace", async () => {
			const { commands, executed } = makePaneCommandHarness();
			await commands.execute("pane.closeOtherTabs");
			expect(executed).toEqual(["closeOtherTabs"]);
		});

		it("runs the close-active-tab command through the close path", async () => {
			const { commands, executed } = makePaneCommandHarness();
			await commands.execute("pane.closeActiveTab");
			expect(executed[0]).toMatch(/^closeTab:/);
		});

		it("runs the reopen-closed-tab command through the workspace", async () => {
			const { commands, executed } = makePaneCommandHarness();
			await commands.execute("pane.reopenClosedTab");
			expect(executed).toEqual(["reopenClosedTab"]);
		});
	});
});
