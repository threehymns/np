import "../../../tests/contract/rune-setup";
import { describe, it, expect, mock, beforeAll } from "bun:test";
import { createMockStorage } from "../../../tests/mock-storage";
import { MemorySessionPersistence } from "./persistence";
import type { VCSAdapter } from "./project/vcs";
import {
	Pane,
	Axis,
	splitPane,
	collapseTree,
	removePane,
	findPaneInDirection,
	canSplitTab,
	WORKSPACE_PERSISTENCE_VERSION,
	type Rect,
} from "./split-tree.svelte";
import { CommandRegistry, registerCoreCommands } from "./commands.svelte";
import { defaultKeymap } from "./keymap.svelte";
import type { Workspace } from "./workspace.svelte";

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

describe("ADR 0024: Pane Splits", () => {
	describe("1. Split tree insert and collapse operations", () => {
		it("splits root pane into an axis with 50/50 flex", () => {
			const rootPane = new Pane();
			const newPane = new Pane();
			const layout = splitPane(rootPane, rootPane.id, "right", newPane);

			expect(layout.type).toBe("axis");
			if (layout.type === "axis") {
				expect(layout.axis).toBe("horizontal");
				expect(layout.children.length).toBe(2);
				expect(layout.children[0].id).toBe(rootPane.id);
				expect(layout.children[1].id).toBe(newPane.id);
				expect(layout.children[0].flex).toBe(1);
				expect(layout.children[1].flex).toBe(1);
			}
		});

		it("inserts adjacent when splitting along the same axis", () => {
			const rootPane = new Pane();
			const p2 = new Pane();
			const p3 = new Pane();

			let layout = splitPane(rootPane, rootPane.id, "right", p2);
			layout = splitPane(layout, p2.id, "right", p3);

			expect(layout.type).toBe("axis");
			if (layout.type === "axis") {
				expect(layout.axis).toBe("horizontal");
				expect(layout.children.length).toBe(3);
				expect(layout.children.map((c) => c.id)).toEqual([rootPane.id, p2.id, p3.id]);
			}
		});

		it("nests a new axis when splitting orthogonal to parent axis", () => {
			const rootPane = new Pane();
			const p2 = new Pane();
			const p3 = new Pane();

			let layout = splitPane(rootPane, rootPane.id, "right", p2);
			// p2 splits vertically down
			layout = splitPane(layout, p2.id, "down", p3);

			expect(layout.type).toBe("axis");
			if (layout.type === "axis") {
				expect(layout.axis).toBe("horizontal");
				expect(layout.children.length).toBe(2);
				expect(layout.children[0].id).toBe(rootPane.id);

				const nested = layout.children[1];
				expect(nested.type).toBe("axis");
				if (nested.type === "axis") {
					expect(nested.axis).toBe("vertical");
					expect(nested.children.map((c) => c.id)).toEqual([p2.id, p3.id]);
				}
			}
		});

		it("collapses single-child axes when a pane is removed", () => {
			const rootPane = new Pane();
			const p2 = new Pane();
			const layout = splitPane(rootPane, rootPane.id, "right", p2);

			const result = removePane(layout, p2.id);
			expect(result.newRoot.type).toBe("pane");
			expect(result.newRoot.id).toBe(rootPane.id);
			expect(result.neighborId).toBe(rootPane.id);
		});
	});

	describe("2. All three split modes (empty, move, clone)", () => {
		it("split mode 'empty' leaves active tab in source pane and creates empty pane", async () => {
			const ws = makeWorkspace();
			const doc = await ws.newFile();
			expect(ws.activePane.tabs.length).toBe(1);

			const newPane = ws.splitActivePane("right", "empty");
			expect(newPane.tabs.length).toBe(0);
			expect(newPane.activeTabId).toBe("");
			expect(ws.activePaneId).toBe(newPane.id);

			const sourcePane = ws.findPane(ws.layout.type === "axis" ? ws.layout.children[0].id : "");
			expect(sourcePane?.tabs.length).toBe(1);
			expect(sourcePane?.tabs[0].id).toBe(doc.id);
		});

		it("split mode 'move' moves active tab to new pane and updates source activeTabId", async () => {
			const ws = makeWorkspace();
			const doc1 = await ws.newFile();
			const doc2 = await ws.newFile();
			expect(ws.activePane.tabs.length).toBe(2);
			expect(ws.activePane.activeTabId).toBe(doc2.id);

			const newPane = ws.splitActivePane("right", "move");
			expect(newPane.tabs.length).toBe(1);
			expect(newPane.tabs[0].id).toBe(doc2.id);
			expect(ws.activePaneId).toBe(newPane.id);

			const sourcePane = ws.findPane(ws.layout.type === "axis" ? ws.layout.children[0].id : "");
			expect(sourcePane?.tabs.length).toBe(1);
			expect(sourcePane?.tabs[0].id).toBe(doc1.id);
			expect(sourcePane?.activeTabId).toBe(doc1.id);
		});

		it("split mode 'clone' duplicates active tab onto same DocumentSession and focuses new pane", async () => {
			const ws = makeWorkspace();
			const doc = await ws.newFile();
			const origPane = ws.activePane;

			const newPane = ws.splitActivePane("right", "clone");
			expect(ws.activePaneId).toBe(newPane.id);
			expect(newPane.tabs.length).toBe(1);
			expect(newPane.tabs[0].id).toBe(doc.id);
			expect(origPane.tabs.length).toBe(1);
			expect(origPane.tabs[0].id).toBe(doc.id);

			// Both tabs reference the same document session
			expect(ws.countTabsForDocument(doc.id)).toBe(2);
		});
	});

	describe("3. Clone veto on diff viewer and LSP logs", () => {
		it("canSplitTab returns false for diff tabs and LSP logs", () => {
			expect(canSplitTab({ id: "diff-1", type: "diff" } as any)).toBe(false);
			expect(canSplitTab({ id: "__lsp_logs__", type: "document" } as any)).toBe(false);
			expect(canSplitTab({ id: "__project_diff__", type: "diff" } as any)).toBe(false);
			expect(canSplitTab({ id: "tab-1", type: "document", canSplit: false } as any)).toBe(false);
			expect(canSplitTab({ id: "tab-2", type: "document" } as any)).toBe(true);
		});

		it("split in clone mode falls back to empty pane when active tab vetoes cloning", async () => {
			const ws = makeWorkspace();
			ws.activePane.tabs = [{ id: "__lsp_logs__", type: "diff", pluginId: "lsp" } as any];
			ws.activePane.activeTabId = "__lsp_logs__";

			const newPane = ws.splitActivePane("right", "clone");
			expect(newPane.tabs.length).toBe(0);
			expect(newPane.activeTabId).toBe("");
			expect(ws.activePaneId).toBe(newPane.id);
		});
	});

	describe("4. Shared-session dirty semantics", () => {
		it("closing a cloned tab closes silently while another tab references the session", async () => {
			const ws = makeWorkspace();
			const doc = await ws.newFile();
			ws.updateDocumentContent(doc, "Modified content");
			expect(doc.isModified).toBe(true);

			const pane1 = ws.activePane;
			const pane2 = ws.splitActivePane("right", "clone");
			expect(ws.countTabsForDocument(doc.id)).toBe(2);

			// Close tab in pane2: should close silently without prompt (pendingCloseId stays null)
			await ws.closeTab(doc.id, pane2.id);
			expect(ws.pendingCloseId).toBeNull();
			expect(pane2.tabs.length).toBe(0);
			expect(ws.countTabsForDocument(doc.id)).toBe(1);

			// Now close the last remaining tab in pane1: should trigger prompt (pendingCloseId set)
			await ws.closeTab(doc.id, pane1.id);
			expect(ws.pendingCloseId).toBe(doc.id);
		});
	});

	describe("5. Implicit pane death + last-pane guard", () => {
		it("implicit death: pane closes when its last tab closes and collapses tree", async () => {
			const ws = makeWorkspace();
			const doc1 = await ws.newFile();
			const pane1 = ws.activePane;
			const pane2 = ws.splitActivePane("right", "empty");
			const doc2 = await ws.newFile(); // in pane2

			expect(ws.getAllPanes().length).toBe(2);

			// Close doc2 in pane2 (its only tab)
			await ws.performClose(doc2.id, false, pane2.id);

			expect(ws.getAllPanes().length).toBe(1);
			expect(ws.activePaneId).toBe(pane1.id);
			expect(ws.layout.type).toBe("pane");
		});

		it("last-pane guard: last pane survives as an empty pane when its last tab closes", async () => {
			const ws = makeWorkspace();
			const doc = await ws.newFile();
			expect(ws.getAllPanes().length).toBe(1);

			await ws.performClose(doc.id, false, ws.activePaneId);

			expect(ws.getAllPanes().length).toBe(1);
			expect(ws.activePane.tabs.length).toBe(0);
			expect(ws.activePane.activeTabId).toBe("");
			expect(ws.layout.type).toBe("pane");
		});
	});

	describe("6. Geometric focus navigation", () => {
		it("findPaneInDirection navigates correctly between neighboring pane rects", () => {
			const rects = new Map<string, Rect>([
				["pane-left", { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }],
				["pane-right", { left: 100, top: 0, right: 200, bottom: 100, width: 100, height: 100 }],
				["pane-below", { left: 0, top: 100, right: 100, bottom: 200, width: 100, height: 100 }],
			]);

			expect(findPaneInDirection("pane-left", "right", rects)).toBe("pane-right");
			expect(findPaneInDirection("pane-right", "left", rects)).toBe("pane-left");
			expect(findPaneInDirection("pane-left", "down", rects)).toBe("pane-below");
			expect(findPaneInDirection("pane-below", "up", rects)).toBe("pane-left");
			expect(findPaneInDirection("pane-right", "right", rects)).toBeNull();
			expect(findPaneInDirection("pane-left", "up", rects)).toBeNull();
		});

		it("focusPaneInDirection updates activePaneId", () => {
			const ws = makeWorkspace();
			const p2 = ws.splitActivePane("right", "empty");
			const p1Id = ws.layout.type === "axis" ? ws.layout.children[0].id : "";

			const rects = new Map<string, Rect>([
				[p1Id, { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }],
				[p2.id, { left: 100, top: 0, right: 200, bottom: 100, width: 100, height: 100 }],
			]);

			expect(ws.activePaneId).toBe(p2.id);
			const moved = ws.focusPaneInDirection("left", rects);
			expect(moved).toBe(true);
			expect(ws.activePaneId).toBe(p1Id);
		});
	});

	describe("7. Keybinding and command registration", () => {
		it("registers pane split and focus commands", () => {
			const commands = new CommandRegistry();
			registerCoreCommands({
				commands,
				workspace: {
					splitActivePane: () => {},
					focusPaneInDirection: () => true,
				},
			} as any);

			const commandIds = [
				"pane.splitRight",
				"pane.splitLeft",
				"pane.splitUp",
				"pane.splitDown",
				"pane.focusLeft",
				"pane.focusRight",
				"pane.focusUp",
				"pane.focusDown",
			];

			for (const id of commandIds) {
				expect(commands.get(id)).toBeDefined();
			}
		});

		it("registers default keybindings for split and focus", () => {
			const globalBindings = defaultKeymap.find((b) => !b.context)?.bindings ?? {};
			expect(globalBindings["ctrl+\\"]).toBe("pane.splitRight");
			expect(globalBindings["cmd+k right"]).toBe("pane.splitRight");
			expect(globalBindings["cmd+k left"]).toBe("pane.splitLeft");
			expect(globalBindings["cmd+k up"]).toBe("pane.splitUp");
			expect(globalBindings["cmd+k down"]).toBe("pane.splitDown");
			expect(globalBindings["cmd+k cmd+right"]).toBe("pane.focusRight");
			expect(globalBindings["cmd+k cmd+left"]).toBe("pane.focusLeft");
			expect(globalBindings["cmd+k cmd+up"]).toBe("pane.focusUp");
			expect(globalBindings["cmd+k cmd+down"]).toBe("pane.focusDown");
		});
	});

	describe("8. Persistence versioning", () => {
		it("uses version-keyed persistence to discard obsolete state without migration", () => {
			expect(WORKSPACE_PERSISTENCE_VERSION).toBe(1);

			const ws = makeWorkspace();
			const serialized = ws.serializeTabs();
			expect(serialized.version).toBe(WORKSPACE_PERSISTENCE_VERSION);
		});
	});
});
