import { describe, it, expect, mock } from "bun:test";
import { applyHunkAction, type HunkRange } from "./commands.svelte";
import type { GitChange, VCSAdapter } from "./project/vcs";

function createMockAppState(adapter: Partial<VCSAdapter> = {}, alerts: string[] = []) {
	return {
		appState: {
			workspace: {
				repository: {
					adapter,
					isBusy: false,
					refresh: mock(async () => {}),
					getFileDiff: async (filepath: string, options?: any) => {
						if (adapter.getFileDiff) {
							return await adapter.getFileDiff(filepath, options);
						}
						return null;
					}
				}
			},
			dialogService: {
				alert: mock(async (msg: string) => {
					alerts.push(msg);
				})
			}
		} as any,
		alerts
	};
}

function createTestChange(overrides: Partial<GitChange> = {}): GitChange {
	return {
		filepath: "test.txt",
		status: "M",
		additions: 1,
		deletions: 0,
		diff: "",
		staged: false,
		originalContent: "a",
		modifiedContent: "b",
		...overrides
	};
}

describe("applyHunkAction error handling", () => {
	it("handles missing adapter.updateIndexContent on stage via showAlert instead of throwing", async () => {
		const { appState, alerts } = createMockAppState();
		const change = createTestChange();
		const hunk: HunkRange = { fromA: 0, toA: 1, fromB: 0, toB: 1 };

		await expect(applyHunkAction(appState, change, hunk, "stage")).resolves.toBeUndefined();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toContain("VCS adapter does not support updating index for hunk stage");
		expect(appState.workspace.repository.isBusy).toBe(false);
	});

	it("handles missing adapter.updateIndexContent on unstage via showAlert instead of throwing", async () => {
		const { appState, alerts } = createMockAppState();
		const change = createTestChange({ staged: true });
		const hunk: HunkRange = { fromA: 0, toA: 1, fromB: 0, toB: 1 };

		await expect(applyHunkAction(appState, change, hunk, "unstage")).resolves.toBeUndefined();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toContain("VCS adapter does not support updating index for hunk unstage");
		expect(appState.workspace.repository.isBusy).toBe(false);
	});

	it("handles missing originalContent via showAlert instead of throwing", async () => {
		const { appState, alerts } = createMockAppState({
			updateIndexContent: mock(async () => {})
		});
		const change = createTestChange({ originalContent: undefined });
		const hunk: HunkRange = { fromA: 0, toA: 1, fromB: 0, toB: 1 };

		await expect(applyHunkAction(appState, change, hunk, "stage")).resolves.toBeUndefined();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toContain("Cannot perform hunk stage: missing diff content for test.txt");
		expect(appState.workspace.repository.isBusy).toBe(false);
	});

	it("handles missing modifiedContent via showAlert instead of throwing", async () => {
		const { appState, alerts } = createMockAppState({
			updateIndexContent: mock(async () => {})
		});
		const change = createTestChange({ modifiedContent: undefined });
		const hunk: HunkRange = { fromA: 0, toA: 1, fromB: 0, toB: 1 };

		await expect(applyHunkAction(appState, change, hunk, "stage")).resolves.toBeUndefined();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toContain("Cannot perform hunk stage: missing diff content for test.txt");
		expect(appState.workspace.repository.isBusy).toBe(false);
	});

	it("handles missing adapter.updateFileContent on discard via showAlert", async () => {
		const { appState, alerts } = createMockAppState();
		const change = createTestChange();
		const hunk: HunkRange = { fromA: 0, toA: 1, fromB: 0, toB: 1 };

		await expect(applyHunkAction(appState, change, hunk, "discard")).resolves.toBeUndefined();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toContain("VCS adapter does not support updating file content for hunk discard");
		expect(appState.workspace.repository.isBusy).toBe(false);
	});

	it("handles missing adapter.updateIndexContent on staged hunk discard via showAlert", async () => {
		let updateFileCalled = false;
		const { appState, alerts } = createMockAppState({
			updateFileContent: mock(async () => {
				updateFileCalled = true;
			})
		});
		const change = createTestChange({
			staged: true,
			originalContent: "line1\n",
			modifiedContent: "line1\nline2\n",
			stagedContent: "line1\nline2\n"
		});
		const hunk: HunkRange = { fromA: 6, toA: 6, fromB: 6, toB: 12 };

		await expect(applyHunkAction(appState, change, hunk, "discard")).resolves.toBeUndefined();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toContain("VCS adapter does not support updating index for hunk discard");
		expect(updateFileCalled).toBe(false);
		expect(appState.workspace.repository.isBusy).toBe(false);
	});

	it("successfully applies unstaged hunk discard when adapter only supports updateFileContent", async () => {
		let updatedWorktreeFile = "";
		let updatedWorktreeContent = "";
		const { appState } = createMockAppState({
			updateFileContent: mock(async (file: string, content: string) => {
				updatedWorktreeFile = file;
				updatedWorktreeContent = content;
			})
		});
		const change = createTestChange({
			originalContent: "line1\n",
			modifiedContent: "line1\nline2\n",
			stagedContent: "line1\n"
		});
		const hunk: HunkRange = { fromA: 6, toA: 6, fromB: 6, toB: 12 };

		await applyHunkAction(appState, change, hunk, "discard");
		expect(updatedWorktreeFile).toBe("test.txt");
		expect(updatedWorktreeContent).toBe("line1\n");
		expect(appState.workspace.repository.refresh).toHaveBeenCalled();
		expect(appState.workspace.repository.isBusy).toBe(false);
	});

	it("successfully applies hunk stage action when adapter and content are valid", async () => {
		let updatedFile = "";
		let updatedContent = "";
		const { appState } = createMockAppState({
			updateIndexContent: mock(async (file: string, content: string) => {
				updatedFile = file;
				updatedContent = content;
			})
		});
		const change = createTestChange({
			originalContent: "line1\n",
			modifiedContent: "line1\nline2\n"
		});
		const hunk: HunkRange = { fromA: 6, toA: 6, fromB: 6, toB: 12 };

		await applyHunkAction(appState, change, hunk, "stage");
		expect(updatedFile).toBe("test.txt");
		expect(updatedContent).toBe("line1\nline2\n");
		expect(appState.workspace.repository.refresh).toHaveBeenCalled();
		expect(appState.workspace.repository.isBusy).toBe(false);
	});

	it("successfully applies staged hunk discard when adapter supports updateIndexContent and updateFileContent", async () => {
		let updatedIndexFile = "";
		let updatedIndexContent = "";
		let updatedWorktreeFile = "";
		let updatedWorktreeContent = "";
		const { appState } = createMockAppState({
			updateIndexContent: mock(async (file: string, content: string) => {
				updatedIndexFile = file;
				updatedIndexContent = content;
			}),
			updateFileContent: mock(async (file: string, content: string) => {
				updatedWorktreeFile = file;
				updatedWorktreeContent = content;
			})
		});
		const change = createTestChange({
			staged: true,
			originalContent: "line1\n",
			modifiedContent: "line1\nline2\n",
			stagedContent: "line1\nline2\n"
		});
		const hunk: HunkRange = { fromA: 6, toA: 6, fromB: 6, toB: 12 };

		await applyHunkAction(appState, change, hunk, "discard");
		expect(updatedIndexFile).toBe("test.txt");
		expect(updatedIndexContent).toBe("line1\n");
		expect(updatedWorktreeFile).toBe("test.txt");
		expect(updatedWorktreeContent).toBe("line1\n");
		expect(appState.workspace.repository.refresh).toHaveBeenCalled();
		expect(appState.workspace.repository.isBusy).toBe(false);
	});

	it("resolves missing diff content via adapter.getFileDiff on stage", async () => {
		let updatedFile = "";
		let updatedContent = "";
		const getFileDiffMock = mock(async (filepath: string, options?: { staged?: boolean }) => {
			return {
				originalContent: "line1\n",
				modifiedContent: "line1\nline2\n",
				stagedContent: "line1\n"
			};
		});
		const { appState } = createMockAppState({
			getFileDiff: getFileDiffMock,
			updateIndexContent: mock(async (file: string, content: string) => {
				updatedFile = file;
				updatedContent = content;
			})
		});
		// Change without loaded originalContent / modifiedContent
		const change = createTestChange({
			originalContent: undefined,
			modifiedContent: undefined,
			stagedContent: undefined
		});
		const hunk: HunkRange = { fromA: 6, toA: 6, fromB: 6, toB: 12 };

		await applyHunkAction(appState, change, hunk, "stage");
		expect(getFileDiffMock).toHaveBeenCalledWith("test.txt", { staged: false });
		expect(updatedFile).toBe("test.txt");
		expect(updatedContent).toBe("line1\nline2\n");
		expect(appState.workspace.repository.refresh).toHaveBeenCalled();
		expect(appState.workspace.repository.isBusy).toBe(false);
	});

	it("resolves missing diff content via adapter.getFileDiff on unstage", async () => {
		let updatedFile = "";
		let updatedContent = "";
		const getFileDiffMock = mock(async (filepath: string, options?: { staged?: boolean }) => {
			return {
				originalContent: "line1\n",
				modifiedContent: "line1\nline2\n",
				stagedContent: "line1\nline2\n"
			};
		});
		const { appState } = createMockAppState({
			getFileDiff: getFileDiffMock,
			updateIndexContent: mock(async (file: string, content: string) => {
				updatedFile = file;
				updatedContent = content;
			})
		});
		const change = createTestChange({
			staged: true,
			originalContent: undefined,
			modifiedContent: undefined,
			stagedContent: undefined
		});
		const hunk: HunkRange = { fromA: 6, toA: 6, fromB: 6, toB: 12 };

		await applyHunkAction(appState, change, hunk, "unstage");
		expect(getFileDiffMock).toHaveBeenCalledWith("test.txt", { staged: true });
		expect(updatedFile).toBe("test.txt");
		expect(updatedContent).toBe("line1\n");
		expect(appState.workspace.repository.refresh).toHaveBeenCalled();
		expect(appState.workspace.repository.isBusy).toBe(false);
	});

	it("resolves missing diff content via adapter.getFileDiff on discard", async () => {
		let updatedWorktreeFile = "";
		let updatedWorktreeContent = "";
		const getFileDiffMock = mock(async (filepath: string, options?: { staged?: boolean }) => {
			return {
				originalContent: "line1\n",
				modifiedContent: "line1\nline2\n",
				stagedContent: "line1\n"
			};
		});
		const { appState } = createMockAppState({
			getFileDiff: getFileDiffMock,
			updateFileContent: mock(async (file: string, content: string) => {
				updatedWorktreeFile = file;
				updatedWorktreeContent = content;
			})
		});
		const change = createTestChange({
			staged: false,
			originalContent: undefined,
			modifiedContent: undefined,
			stagedContent: undefined
		});
		const hunk: HunkRange = { fromA: 6, toA: 6, fromB: 6, toB: 12 };

		await applyHunkAction(appState, change, hunk, "discard");
		expect(getFileDiffMock).toHaveBeenCalledWith("test.txt", { staged: false });
		expect(updatedWorktreeFile).toBe("test.txt");
		expect(updatedWorktreeContent).toBe("line1\n");
		expect(appState.workspace.repository.refresh).toHaveBeenCalled();
		expect(appState.workspace.repository.isBusy).toBe(false);
	});
});

