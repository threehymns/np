import "../../../tests/contract/rune-setup";
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { registerCoreCommands, CommandRegistry } from "./commands.svelte";
import type { FileOrigin } from "./storage";

function createMockAppState() {
	const commands = new CommandRegistry();
	const openedFiles: any[] = [];
	const alerts: string[] = [];

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
		settingsOpen: false,
		dialogService: {
			alert: mock(async (msg: string) => {
				alerts.push(msg);
			})
		}
	};

	registerCoreCommands(appState as any);
	return {
		appState,
		commands,
		workspace,
		openedFiles,
		alerts,
		setSettingsOpen: (v: boolean) => {
			appState.settingsOpen = v;
		},
		getSettingsOpen: () => appState.settingsOpen
	};
}

describe("settings.openConfigJson command", () => {
	let mockGetConfigPath: ReturnType<typeof mock>;
	let mockReadConfigFileSync: ReturnType<typeof mock>;

	beforeEach(() => {
		mockGetConfigPath = mock(async () => "/home/user/.config/np/config.json");
		mockReadConfigFileSync = mock(() => "{\"zoom\":100}" as string | null);
		(globalThis as any).window = {
			electronAPI: {
				getConfigPath: mockGetConfigPath,
				readConfigFileSync: mockReadConfigFileSync
			}
		};
	});

	afterEach(() => {
		delete (globalThis as any).window;
	});

	it("registers with the correct label and category", () => {
		const { commands } = createMockAppState();
		const command = commands.get("settings.openConfigJson");
		expect(command).toBeDefined();
		expect(command?.label).toBe("Preferences: Open Settings (JSON)");
		expect(command?.category).toBe("Preferences");
	});

	it("opens the config file as a document tab and closes settings", async () => {
		const { commands, workspace, openedFiles, getSettingsOpen, appState, setSettingsOpen } = createMockAppState();
		setSettingsOpen(true);
		await commands.execute("settings.openConfigJson");

		expect(mockGetConfigPath).toHaveBeenCalledTimes(1);
		expect(mockReadConfigFileSync).toHaveBeenCalledTimes(1);
		expect(workspace.openFile).toHaveBeenCalledTimes(1);
		expect(openedFiles[0]).toEqual({
			scheme: "file",
			path: "/home/user/.config/np/config.json",
			name: "config.json"
		});
		expect(getSettingsOpen()).toBe(false);
		expect(appState.dialogService.alert).not.toHaveBeenCalled();
	});

	it("shows fallback alert when window.electronAPI is absent and does not open a file", async () => {
		delete (globalThis as any).window;
		const { commands, workspace, alerts, appState } = createMockAppState();
		await commands.execute("settings.openConfigJson");

		expect(workspace.openFile).not.toHaveBeenCalled();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toBe("Configuration file is only available in the desktop application.");
	});
});
