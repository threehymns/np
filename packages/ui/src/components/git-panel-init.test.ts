import "../../../../tests/contract/rune-setup";
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { GitInitController } from "./git-actions";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("GitPanel Empty State - GitInitController & Initialization Lifecycle (Ticket #120)", () => {
	let mockWorkspace: any;
	let mockAppState: any;
	let controller: GitInitController;

	const rootOrigin = { scheme: "file", path: "/workspace/project", name: "project" };

	beforeEach(() => {
		mockWorkspace = {
			rootOrigin,
			hasRootPermission: true,
			repository: null,
			initializeRepository: mock(async () => {
				mockWorkspace.repository = { currentBranch: "main", changes: [] };
				return true;
			})
		};

		mockAppState = {
			workspace: mockWorkspace,
			commands: {
				execute: mock(async () => true)
			}
		};

		controller = new GitInitController(() => mockAppState);
	});

	describe("1. Idle state and permission gating", () => {
		it("enables initialization when workspace folder is open with write permission", () => {
			mockWorkspace.rootOrigin = rootOrigin;
			mockWorkspace.hasRootPermission = true;

			expect(controller.canInitialize).toBe(true);
			expect(controller.isInitializing).toBe(false);
			expect(controller.error).toBeNull();
		});

		it("disables initialization when no workspace folder is open (rootOrigin is null)", async () => {
			mockWorkspace.rootOrigin = null;
			mockWorkspace.hasRootPermission = true;

			expect(controller.canInitialize).toBe(false);

			const result = await controller.initialize();
			expect(result).toBe(false);
			expect(mockWorkspace.initializeRepository).not.toHaveBeenCalled();
			expect(controller.isInitializing).toBe(false);
			expect(controller.error).toBeNull();
		});

		it("disables initialization when write permission is not granted (hasRootPermission is false)", async () => {
			mockWorkspace.rootOrigin = rootOrigin;
			mockWorkspace.hasRootPermission = false;

			expect(controller.canInitialize).toBe(false);

			const result = await controller.initialize();
			expect(result).toBe(false);
			expect(mockWorkspace.initializeRepository).not.toHaveBeenCalled();
			expect(controller.isInitializing).toBe(false);
			expect(controller.error).toBeNull();
		});
	});

	describe("2. Busy state and double-click / double-submission prevention", () => {
		it("manages busy lifecycle and prevents duplicate in-flight initialization calls", async () => {
			let resolveInit!: () => void;
			const initDeferred = new Promise<void>((r) => (resolveInit = r));

			let initCallCount = 0;
			mockWorkspace.initializeRepository = mock(async () => {
				initCallCount++;
				await initDeferred;
				mockWorkspace.repository = { currentBranch: "main", changes: [] };
				return true;
			});

			expect(controller.isInitializing).toBe(false);

			// First click: begins initialization
			const initPromise1 = controller.initialize();
			expect(controller.isInitializing).toBe(true);
			expect(initCallCount).toBe(1);

			// Second click while in flight: should be ignored immediately
			const initPromise2 = controller.initialize();
			expect(controller.isInitializing).toBe(true);
			expect(initCallCount).toBe(1);

			const result2 = await initPromise2;
			expect(result2).toBe(false);
			expect(initCallCount).toBe(1);

			// Complete the first operation
			resolveInit();
			const result1 = await initPromise1;
			expect(result1).toBe(true);
			expect(controller.isInitializing).toBe(false);
			expect(controller.error).toBeNull();
		});
	});

	describe("3. Error presentation and retry lifecycle", () => {
		it("captures thrown error message, presents error state, and resets busy flag", async () => {
			mockWorkspace.initializeRepository = mock(async () => {
				throw new Error("Filesystem write permission denied");
			});

			const result = await controller.initialize();

			expect(result).toBe(false);
			expect(controller.isInitializing).toBe(false);
			expect(controller.error).toBe("Filesystem write permission denied");
		});

		it("handles non-throwing falsy returns when workspace is not initialized", async () => {
			mockWorkspace.initializeRepository = mock(async () => false);

			const result = await controller.initialize();

			expect(result).toBe(false);
			expect(controller.isInitializing).toBe(false);
			expect(controller.error).toBe("Failed to initialize repository");
		});

		it("retries initialization, clears existing error, and transitions to success", async () => {
			let attempt = 0;
			mockWorkspace.initializeRepository = mock(async () => {
				attempt++;
				if (attempt === 1) {
					throw new Error("Temporary locked file error");
				}
				mockWorkspace.repository = { currentBranch: "main", changes: [] };
				return true;
			});

			// Initial failed attempt
			const firstResult = await controller.initialize();
			expect(firstResult).toBe(false);
			expect(controller.error).toBe("Temporary locked file error");

			// Retry attempt
			const retryResult = await controller.retry();
			expect(retryResult).toBe(true);
			expect(attempt).toBe(2);
			expect(controller.error).toBeNull();
			expect(controller.isInitializing).toBe(false);
		});

		it("allows resetting controller state explicitly", () => {
			controller.isInitializing = true;
			controller.error = "Some error";

			controller.reset();

			expect(controller.isInitializing).toBe(false);
			expect(controller.error).toBeNull();
		});
	});

	describe("4. Static template and contract audit of GitPanel.svelte", () => {
		const svelteContent = readFileSync(
			resolve(__dirname, "GitPanel.svelte"),
			"utf-8"
		);

		it("includes 'Initialize repository' button in empty state", () => {
			expect(svelteContent).toContain("Initialize repository");
		});

		it("wires empty state to GitInitController", () => {
			expect(svelteContent).toContain("initController");
			expect(svelteContent).toContain("initController.initialize()");
		});

		it("binds disabled state to permission gating and busy state", () => {
			expect(svelteContent).toContain("!initController.canInitialize || initController.isInitializing");
		});

		it("presents spinner loading state when isInitializing is true", () => {
			expect(svelteContent).toContain("initController.isInitializing");
			expect(svelteContent).toContain("animate-spin");
			expect(svelteContent).toContain("Initializing...");
		});

		it("presents error container and retry button when error is present", () => {
			expect(svelteContent).toContain("initController.error");
			expect(svelteContent).toContain("initController.retry()");
			expect(svelteContent).toContain("Retry");
		});

		it("displays helpful guidance messages for missing folder vs missing permission", () => {
			expect(svelteContent).toContain("!appState.workspace.rootOrigin");
			expect(svelteContent).toContain("!appState.workspace.hasRootPermission");
		});
	});
});
