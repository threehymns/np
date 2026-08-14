import { describe, it, expect, mock } from "bun:test";
import { applyHunkAction, type HunkRange } from "./commands.svelte";
import type { GitChange } from "./project/vcs";

describe("applyHunkAction error handling", () => {
	it("handles missing adapter.updateIndexContent on stage via showAlert instead of throwing", async () => {
		const alerts: string[] = [];
		const appState: any = {
			workspace: {
				repository: {
					adapter: {},
					isBusy: false,
					refresh: mock(async () => {})
				}
			},
			dialogService: {
				alert: mock(async (msg: string) => {
					alerts.push(msg);
				})
			}
		};

		const change: GitChange = {
			filepath: "test.txt",
			status: "M",
			additions: 1,
			deletions: 0,
			diff: "",
			staged: false,
			originalContent: "a",
			modifiedContent: "b"
		};
		const hunk: HunkRange = { fromA: 0, toA: 1, fromB: 0, toB: 1 };

		await expect(applyHunkAction(appState, change, hunk, "stage")).resolves.toBeUndefined();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toContain("VCS adapter does not support updating index for hunk stage");
		expect(appState.workspace.repository.isBusy).toBe(false);
	});

	it("handles missing adapter.updateIndexContent on unstage via showAlert instead of throwing", async () => {
		const alerts: string[] = [];
		const appState: any = {
			workspace: {
				repository: {
					adapter: {},
					isBusy: false,
					refresh: mock(async () => {})
				}
			},
			dialogService: {
				alert: mock(async (msg: string) => {
					alerts.push(msg);
				})
			}
		};

		const change: GitChange = {
			filepath: "test.txt",
			status: "M",
			additions: 1,
			deletions: 0,
			diff: "",
			staged: true,
			originalContent: "a",
			modifiedContent: "b"
		};
		const hunk: HunkRange = { fromA: 0, toA: 1, fromB: 0, toB: 1 };

		await expect(applyHunkAction(appState, change, hunk, "unstage")).resolves.toBeUndefined();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toContain("VCS adapter does not support updating index for hunk unstage");
		expect(appState.workspace.repository.isBusy).toBe(false);
	});

	it("handles missing originalContent via showAlert instead of throwing", async () => {
		const alerts: string[] = [];
		const appState: any = {
			workspace: {
				repository: {
					adapter: {
						updateIndexContent: mock(async () => {})
					},
					isBusy: false,
					refresh: mock(async () => {})
				}
			},
			dialogService: {
				alert: mock(async (msg: string) => {
					alerts.push(msg);
				})
			}
		};

		const change: GitChange = {
			filepath: "test.txt",
			status: "M",
			additions: 1,
			deletions: 0,
			diff: "",
			staged: false,
			originalContent: undefined,
			modifiedContent: "b"
		};
		const hunk: HunkRange = { fromA: 0, toA: 1, fromB: 0, toB: 1 };

		await expect(applyHunkAction(appState, change, hunk, "stage")).resolves.toBeUndefined();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toContain("Cannot perform hunk stage: missing diff content for test.txt");
		expect(appState.workspace.repository.isBusy).toBe(false);
	});

	it("handles missing modifiedContent via showAlert instead of throwing", async () => {
		const alerts: string[] = [];
		const appState: any = {
			workspace: {
				repository: {
					adapter: {
						updateIndexContent: mock(async () => {})
					},
					isBusy: false,
					refresh: mock(async () => {})
				}
			},
			dialogService: {
				alert: mock(async (msg: string) => {
					alerts.push(msg);
				})
			}
		};

		const change: GitChange = {
			filepath: "test.txt",
			status: "M",
			additions: 1,
			deletions: 0,
			diff: "",
			staged: false,
			originalContent: "a",
			modifiedContent: undefined
		};
		const hunk: HunkRange = { fromA: 0, toA: 1, fromB: 0, toB: 1 };

		await expect(applyHunkAction(appState, change, hunk, "stage")).resolves.toBeUndefined();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toContain("Cannot perform hunk stage: missing diff content for test.txt");
		expect(appState.workspace.repository.isBusy).toBe(false);
	});

	it("handles missing adapter.updateFileContent on discard via showAlert", async () => {
		const alerts: string[] = [];
		const appState: any = {
			workspace: {
				repository: {
					adapter: {},
					isBusy: false,
					refresh: mock(async () => {})
				}
			},
			dialogService: {
				alert: mock(async (msg: string) => {
					alerts.push(msg);
				})
			}
		};

		const change: GitChange = {
			filepath: "test.txt",
			status: "M",
			additions: 1,
			deletions: 0,
			diff: "",
			staged: false,
			originalContent: "a",
			modifiedContent: "b"
		};
		const hunk: HunkRange = { fromA: 0, toA: 1, fromB: 0, toB: 1 };

		await expect(applyHunkAction(appState, change, hunk, "discard")).resolves.toBeUndefined();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toContain("VCS adapter does not support updating file content for hunk discard");
		expect(appState.workspace.repository.isBusy).toBe(false);
	});

	it("successfully applies hunk stage action when adapter and content are valid", async () => {
		let updatedFile = "";
		let updatedContent = "";
		let refreshed = false;

		const appState: any = {
			workspace: {
				repository: {
					adapter: {
						updateIndexContent: mock(async (file: string, content: string) => {
							updatedFile = file;
							updatedContent = content;
						})
					},
					isBusy: false,
					refresh: mock(async () => {
						refreshed = true;
					})
				}
			},
			dialogService: {
				alert: mock(async () => {})
			}
		};

		const change: GitChange = {
			filepath: "test.txt",
			status: "M",
			additions: 1,
			deletions: 0,
			diff: "",
			staged: false,
			originalContent: "line1\n",
			modifiedContent: "line1\nline2\n"
		};
		const hunk: HunkRange = { fromA: 6, toA: 6, fromB: 6, toB: 12 };

		await applyHunkAction(appState, change, hunk, "stage");
		expect(updatedFile).toBe("test.txt");
		expect(updatedContent).toBe("line1\nline2\n");
		expect(refreshed).toBe(true);
		expect(appState.workspace.repository.isBusy).toBe(false);
	});
});
