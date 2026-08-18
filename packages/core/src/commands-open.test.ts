(globalThis as any).$state = <T>(v: T) => v;

import { describe, it, expect, mock } from "bun:test";
import { registerCoreCommands, CommandRegistry } from "./commands.svelte";
import type { FileOrigin } from "./storage";

function createMockAppState() {
	const commands = new CommandRegistry();
	const openedFiles: any[] = [];
	let openFileCalled = false;

	const workspace = {
		rootOrigin: { scheme: "file", path: "/projects/np", name: "np" } as FileOrigin,
		openFile: mock(async (origin?: FileOrigin) => {
			openedFiles.push(origin);
			return origin;
		})
	};

	const appState = {
		commands,
		workspace,
		openFile: mock(async () => {
			openFileCalled = true;
		})
	};

	registerCoreCommands(appState as any);
	return { appState, commands, workspace, openedFiles, getOpenFileCalled: () => openFileCalled };
}

describe("file.open command", () => {
	it("delegates to appState.openFile() when invoked with no arguments", async () => {
		const { commands, appState } = createMockAppState();
		const command = commands.get("file.open");
		expect(command).toBeDefined();
		expect(command?.label).toBe("Open...");
		expect(command?.category).toBe("File");

		await commands.execute("file.open");
		expect(appState.openFile).toHaveBeenCalledTimes(1);
	});

	it("opens URI string programmatically", async () => {
		const { commands, workspace, openedFiles } = createMockAppState();
		await commands.execute("file.open", "file:///test/doc.md");
		expect(workspace.openFile).toHaveBeenCalledTimes(1);
		expect(openedFiles[0]).toEqual({
			scheme: "file",
			path: "/test/doc.md",
			name: "doc.md"
		});
	});

	it("resolves relative path against workspace rootOrigin", async () => {
		const { commands, workspace, openedFiles } = createMockAppState();
		await commands.execute("file.open", "src/index.ts");
		expect(workspace.openFile).toHaveBeenCalledTimes(1);
		expect(openedFiles[0]).toEqual({
			scheme: "file",
			path: "/projects/np/src/index.ts",
			name: "index.ts"
		});
	});

	it("opens FileOrigin object directly", async () => {
		const { commands, workspace, openedFiles } = createMockAppState();
		const customOrigin: FileOrigin = { scheme: "memory", path: "buffer-1", name: "buffer-1" };
		await commands.execute("file.open", customOrigin);
		expect(workspace.openFile).toHaveBeenCalledTimes(1);
		expect(openedFiles[0]).toBe(customOrigin);
	});

	it("ensures deprecated editor.open and file.openPath are not registered", () => {
		const { commands } = createMockAppState();
		expect(commands.get("editor.open")).toBeUndefined();
		expect(commands.get("file.openPath")).toBeUndefined();
	});
});
