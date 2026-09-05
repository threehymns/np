import "../../../tests/contract/rune-setup";
import { describe, it, expect, mock, beforeAll } from "bun:test";
import type { ExportService, ClipboardService } from "./state.svelte";
import { createMockStorage } from "../../../tests/mock-storage";
import { DocumentSession } from "./document.svelte";

let AppState: any;

beforeAll(async () => {
	const mod = await import("./state.svelte");
	AppState = mod.AppState;
});

function createTestAppState(overrides: {
	exportService?: ExportService;
	clipboardService?: ClipboardService;
	dialogService?: any;
} = {}) {
	const storage = createMockStorage();
	const appState = new AppState({
		storage,
		vcsFactory: () => ({} as any),
		exportService: overrides.exportService,
		clipboardService: overrides.clipboardService,
		dialogService: overrides.dialogService
	});
	return appState;
}

describe("Headless Export Commands ('transformer.exportHTML' & 'transformer.copyHTML')", () => {
	it("delegates HTML export to injected exportService with transformed HTML and suggestedName", async () => {
		let exportedPayload: any = null;
		const exportService: ExportService = {
			exportFile: mock(async (options) => {
				exportedPayload = options;
			})
		};
		const appState = createTestAppState({ exportService });
		const doc = new DocumentSession(
			appState.storage,
			"# Sample Heading\n\nParagraph text.",
			{ scheme: "file", path: "/test/Notes.md", name: "Notes.md" },
			"Notes.md",
			appState.workspace
		);
		appState.workspace.documents = [doc];
		appState.workspace.tabs = [{ id: doc.id, type: "document" }];
		appState.workspace.activeTabId = doc.id;

		await appState.commands.execute("transformer.exportHTML");

		expect(exportService.exportFile).toHaveBeenCalledTimes(1);
		expect(exportedPayload).toBeDefined();
		expect(exportedPayload.suggestedName).toBe("Notes.html");
		expect(exportedPayload.content).toContain("<h1");
		expect(exportedPayload.content).toContain("Sample Heading");
		expect(exportedPayload.content).toContain("<p>Paragraph text.</p>");
		expect(exportedPayload.mimeType).toBe("text/html");
		expect(exportedPayload.types).toBeDefined();
	});

	it("handles user cancellation (AbortError) from exportService without uncaught error", async () => {
		const abortErr = new Error("User cancelled");
		abortErr.name = "AbortError";
		const exportService: ExportService = {
			exportFile: mock(async () => {
				throw abortErr;
			})
		};
		const appState = createTestAppState({ exportService });
		const doc = new DocumentSession(
			appState.storage,
			"Content",
			{ scheme: "file", path: "/test/Test.md", name: "Test.md" },
			"Test.md",
			appState.workspace
		);
		appState.workspace.documents = [doc];
		appState.workspace.tabs = [{ id: doc.id, type: "document" }];
		appState.workspace.activeTabId = doc.id;

		expect(async () => {
			await appState.commands.execute("transformer.exportHTML");
		}).not.toThrow();
	});

	it("handles nullish export failures (throw null / undefined) without crashing", async () => {
		for (const rejection of [null, undefined]) {
			const exportService: ExportService = {
				exportFile: mock(async () => {
					throw rejection;
				})
			};
			const appState = createTestAppState({ exportService });
			const doc = new DocumentSession(
				appState.storage,
				"Content",
				{ scheme: "file", path: "/test/Test.md", name: "Test.md" },
				"Test.md",
				appState.workspace
			);
			appState.workspace.documents = [doc];
			appState.workspace.tabs = [{ id: doc.id, type: "document" }];
			appState.workspace.activeTabId = doc.id;

			await appState.commands.execute("transformer.exportHTML");
		}
	});

	it("handles missing exportService gracefully without crashing and alerts user", async () => {
		const alertMock = mock(async () => {});
		const appState = createTestAppState({ dialogService: { alert: alertMock } });
		const doc = new DocumentSession(
			appState.storage,
			"Content",
			{ scheme: "file", path: "/test/Test.md", name: "Test.md" },
			"Test.md",
			appState.workspace
		);
		appState.workspace.documents = [doc];
		appState.workspace.tabs = [{ id: doc.id, type: "document" }];
		appState.workspace.activeTabId = doc.id;

		await appState.commands.execute("transformer.exportHTML");
		expect(alertMock).toHaveBeenCalledTimes(1);
	});

	it("alerts user when exportFile method is unavailable on exportService", async () => {
		const alertMock = mock(async () => {});
		const appState = createTestAppState({ exportService: {} as any, dialogService: { alert: alertMock } });
		const doc = new DocumentSession(
			appState.storage,
			"Content",
			{ scheme: "file", path: "/test/Test.md", name: "Test.md" },
			"Test.md",
			appState.workspace
		);
		appState.workspace.documents = [doc];
		appState.workspace.tabs = [{ id: doc.id, type: "document" }];
		appState.workspace.activeTabId = doc.id;

		await appState.commands.execute("transformer.exportHTML");
		expect(alertMock).toHaveBeenCalledTimes(1);
	});

	it("no-ops when activeDocument is not present", async () => {
		const exportService: ExportService = {
			exportFile: mock(async () => {})
		};
		const appState = createTestAppState({ exportService });
		appState.workspace.documents = [];
		appState.workspace.tabs = [];
		appState.workspace.activeTabId = "";

		await appState.commands.execute("transformer.exportHTML");
		expect(exportService.exportFile).not.toHaveBeenCalled();
	});

	it("copies transformed HTML to clipboard via clipboardService", async () => {
		let clipboardText = "";
		const clipboardService: ClipboardService = {
			writeText: mock(async (text) => {
				clipboardText = text;
			})
		};
		const appState = createTestAppState({ clipboardService });
		const doc = new DocumentSession(
			appState.storage,
			"# Copy Me\n\nSome body text.",
			{ scheme: "file", path: "/test/Copy.md", name: "Copy.md" },
			"Copy.md",
			appState.workspace
		);
		appState.workspace.documents = [doc];
		appState.workspace.tabs = [{ id: doc.id, type: "document" }];
		appState.workspace.activeTabId = doc.id;

		await appState.commands.execute("transformer.copyHTML");
		expect(clipboardService.writeText).toHaveBeenCalledTimes(1);
		expect(clipboardText).toContain("<h1");
		expect(clipboardText).toContain("Copy Me");
		expect(clipboardText).toContain("Some body text.");
	});

	it("handles copyHTML when no activeDocument is present", async () => {
		const clipboardService: ClipboardService = {
			writeText: mock(async () => {})
		};
		const appState = createTestAppState({ clipboardService });
		appState.workspace.documents = [];
		appState.workspace.tabs = [];
		appState.workspace.activeTabId = "";

		await appState.commands.execute("transformer.copyHTML");
		expect(clipboardService.writeText).not.toHaveBeenCalled();
	});
});
