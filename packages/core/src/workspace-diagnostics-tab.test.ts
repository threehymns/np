import "../../../tests/contract/rune-setup";
import { describe, it, expect, mock, beforeAll } from "bun:test";
import { createMockStorage } from "../../../tests/mock-storage";
import { CommandRegistry, registerCoreCommands } from "./commands.svelte";
import { defaultKeymap } from "./keymap.svelte";
import { MemorySessionPersistence } from "./persistence";
import type { VCSAdapter } from "./project/vcs";
import type { Workspace } from "./workspace.svelte";

/**
 * The project-wide diagnostics tab (spec #309, issue #309).
 *
 * The workspace owns the tab and the session behind it: the severity filter
 * and the sort order the reader chose belong to the tab, so switching away and
 * back has to find them again. The diagnostics themselves are not here — they
 * come from the merged store the LSP plugin publishes, and the tab's decisions
 * about them are asserted where they are made.
 */

let makeWorkspace: () => Workspace;
beforeAll(async () => {
	const mod = await import("./workspace.svelte");
	makeWorkspace = () =>
		new mod.Workspace(
			createMockStorage(),
			() => ({}) as VCSAdapter,
			new MemorySessionPersistence()
		);
});

describe("the diagnostics tab in the workspace", () => {
	it("opens a tab of its own kind and focuses it", async () => {
		const ws = makeWorkspace();
		await ws.restoreSession();

		ws.openDiagnosticsTab();

		const tab = ws.tabs.find((t) => t.type === "diagnostics");
		expect(tab).toBeDefined();
		expect(ws.activeTabId).toBe(tab!.id);
	});

	it("keeps the severity filter when the tab is switched away from and back to", async () => {
		const ws = makeWorkspace();
		await ws.restoreSession();

		ws.openDiagnosticsTab();
		const tabId = ws.activeTabId;
		ws.getDiagnosticsSession(tabId).filter = "error";

		const documentTab = ws.tabs.find((t) => t.type === "document")!;
		ws.activeTabId = documentTab.id;
		expect(ws.activeTabId).toBe(documentTab.id);

		ws.activeTabId = tabId;
		expect(ws.getDiagnosticsSession(tabId).filter).toBe("error");
	});

	it("opens one tab however many times the command runs", async () => {
		const ws = makeWorkspace();
		await ws.restoreSession();

		ws.openDiagnosticsTab();
		ws.openDiagnosticsTab();

		expect(ws.tabs.filter((t) => t.type === "diagnostics")).toHaveLength(1);
	});

	it("drops the diagnostics session when the folder changes", async () => {
		const ws = makeWorkspace();
		await ws.restoreSession();

		ws.openDiagnosticsTab();
		const tabId = ws.activeTabId;
		ws.getDiagnosticsSession(tabId).filter = "error";

		ws.project.storage.pickDirectory = mock(async () => ({
			scheme: "file",
			path: "/projects/other",
			name: "other"
		}));
		ws.project.storage.verifyPermission = mock(async () => true);

		expect(await ws.openDirectory()).toBe(true);
		// The old layout's tabs were replaced, not closed: a fresh session
		// is created on next ask, so the old folder's filter is gone.
		expect(ws.getDiagnosticsSession(tabId).filter).toBe("all");
	});

	it("keeps the diagnostics session when the folder change fails", async () => {
		const ws = makeWorkspace();
		await ws.restoreSession();

		ws.openDiagnosticsTab();
		const tabId = ws.activeTabId;
		ws.getDiagnosticsSession(tabId).filter = "error";

		ws.project.storage.pickDirectory = mock(async () => ({
			scheme: "file",
			path: "/projects/other",
			name: "other"
		}));
		ws.project.storage.verifyPermission = mock(async () => true);
		const persistence = ws.project.persistence as MemorySessionPersistence;
		persistence.loadOpenFiles = mock(async () => {
			throw new Error("load failed");
		});

		expect(await ws.openDirectory()).toBe(false);
		// The old layout was restored, so the reader's filter survives.
		expect(ws.getDiagnosticsSession(tabId).filter).toBe("error");
	});
});

describe("opening the diagnostics tab", () => {
	it("is a command in the shared registry", async () => {
		const ws = makeWorkspace();
		await ws.restoreSession();
		const commands = new CommandRegistry();
		registerCoreCommands({ commands, workspace: ws } as never);

		expect(commands.get("diagnostics.open")).toBeDefined();
		await commands.execute("diagnostics.open");

		expect(ws.tabs.some((t) => t.type === "diagnostics")).toBe(true);
	});

	it("has a keybinding of its own, and takes none that is taken", () => {
		const bindings = defaultKeymap.flatMap((block) =>
			Object.entries(block.bindings).map(([sequence, command]) => ({ sequence, command }))
		);

		const mine = bindings.filter((b) => b.sequence === "cmd+shift+m");
		expect(mine).toHaveLength(1);
		expect(mine[0]!.command).toBe("diagnostics.open");
	});
});
