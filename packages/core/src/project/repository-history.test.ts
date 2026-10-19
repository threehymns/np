import "../../../../tests/contract/rune-setup";
import { describe, it, expect, mock } from "bun:test";
import { Repository, HISTORY_MAX_COUNT } from "./repository.svelte";
import type { VCSAdapter, GitHistoryCommit } from "./vcs";
import type { FileOrigin } from "../storage";
import { startWorkspaceGitWatcher, stopWorkspaceGitWatcher } from "../plugins/git/watch";

const rootOrigin: FileOrigin = { scheme: "file", path: "/test/repo", name: "repo" };

describe("Repository history log integration (Ticket #345)", () => {
	it("prefetches history commits on refresh()", async () => {
		const mockCommits: GitHistoryCommit[] = [
			{
				sha: "1111111222222233333334444444555555566666",
				shortSha: "1111111",
				subject: "feat: add history tab",
				author: "Hatch",
				timestamp: 1700000000
			}
		];

		const mockAdapter: VCSAdapter = {
			detect: async () => true,
			getCurrentBranch: async () => "main",
			getBranches: async () => ["main"],
			getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
			switchBranch: async () => ({ status: "noop" }),
			getChanges: async () => [],
			getCommits: async () => [],
			getHistory: mock(async () => mockCommits)
		};

		const repo = new Repository(rootOrigin, () => mockAdapter);
		expect(repo.historyCommits).toEqual([]);
		expect(repo.historyLoaded).toBe(false);

		await repo.refresh();

		expect(mockAdapter.getHistory).toHaveBeenCalled();
		expect(repo.historyCommits).toEqual(mockCommits);
		expect(repo.historyLoaded).toBe(true);
	});

	it("handles an adapter without getHistory gracefully", async () => {
		const mockAdapter: VCSAdapter = {
			detect: async () => true,
			getCurrentBranch: async () => "main",
			getBranches: async () => ["main"],
			getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
			switchBranch: async () => ({ status: "noop" }),
			getChanges: async () => [],
			getCommits: async () => []
		};

		const repo = new Repository(rootOrigin, () => mockAdapter);
		await repo.refresh();

		expect(repo.historyCommits).toEqual([]);
		expect(repo.historyLoaded).toBe(true);
	});

	it("handles getHistory failure during refresh without breaking other metadata", async () => {
		const mockAdapter: VCSAdapter = {
			detect: async () => true,
			getCurrentBranch: async () => "feat/history",
			getBranches: async () => ["feat/history"],
			getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
			switchBranch: async () => ({ status: "noop" }),
			getChanges: async () => [],
			getHistory: mock(async () => {
				throw new Error("git log failure");
			})
		};

		const repo = new Repository(rootOrigin, () => mockAdapter);
		const success = await repo.refresh();

		expect(success).toBe(true);
		expect(repo.currentBranch).toBe("feat/history");
		expect(repo.historyCommits).toEqual([]);
		expect(repo.historyLoaded).toBe(true);
	});

	it("updates aheadCount on refresh() when adapter provides getAheadCount (Ticket #346)", async () => {
		const mockAdapter: VCSAdapter = {
			detect: async () => true,
			getCurrentBranch: async () => "main",
			getBranches: async () => ["main"],
			getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
			switchBranch: async () => ({ status: "noop" }),
			getAheadCount: mock(async () => 3)
		};

		const repo = new Repository(rootOrigin, () => mockAdapter);
		expect(repo.aheadCount).toBe(0);

		await repo.refresh();

		expect(mockAdapter.getAheadCount).toHaveBeenCalled();
		expect(repo.aheadCount).toBe(3);
	});

	it("defaults aheadCount to 0 when adapter does not implement getAheadCount or fails", async () => {
		const mockAdapter: VCSAdapter = {
			detect: async () => true,
			getCurrentBranch: async () => "main",
			getBranches: async () => ["main"],
			getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
			switchBranch: async () => ({ status: "noop" }),
			getAheadCount: mock(async () => {
				throw new Error("rev-list error");
			})
		};

		const repo = new Repository(rootOrigin, () => mockAdapter);
		await repo.refresh();

		expect(repo.aheadCount).toBe(0);
	});

	it("updates aheadCount on refreshHistory() so watcher events refresh the unpushed indicator", async () => {
		const mockAdapter: VCSAdapter = {
			detect: async () => true,
			getCurrentBranch: async () => "main",
			getBranches: async () => ["main"],
			getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
			switchBranch: async () => ({ status: "noop" }),
			getChanges: async () => [],
			getCommits: async () => [],
			getHistory: mock(async () => []),
			getAheadCount: mock(async () => 2)
		};

		const repo = new Repository(rootOrigin, () => mockAdapter);
		expect(repo.aheadCount).toBe(0);

		await repo.refreshHistory();

		expect(mockAdapter.getAheadCount).toHaveBeenCalled();
		expect(repo.aheadCount).toBe(2);
	});

	it("caps history reads at HISTORY_MAX_COUNT by default but honors explicit overrides", async () => {
		const mockAdapter: VCSAdapter = {
			detect: async () => true,
			getCurrentBranch: async () => "main",
			getBranches: async () => ["main"],
			getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
			switchBranch: async () => ({ status: "noop" }),
			getChanges: async () => [],
			getCommits: async () => [],
			getHistory: mock(async (_options?: { branch?: string | null; maxCount?: number }) => {
				return [];
			})
		};

		const repo = new Repository(rootOrigin, () => mockAdapter);
		await repo.refresh();
		expect(mockAdapter.getHistory).toHaveBeenCalledWith({ maxCount: HISTORY_MAX_COUNT });

		await repo.refreshHistory({ maxCount: 5 });
		expect(mockAdapter.getHistory).toHaveBeenLastCalledWith({ maxCount: 5 });
	});

	it("discards a stale refreshHistory() result when a newer one lands first", async () => {
		const staleCommits: GitHistoryCommit[] = [
			{
				sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				shortSha: "aaaaaaa",
				subject: "stale",
				author: "Hatch",
				timestamp: 1700000000
			}
		];
		const freshCommits: GitHistoryCommit[] = [
			{
				sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
				shortSha: "bbbbbbb",
				subject: "fresh",
				author: "Hatch",
				timestamp: 1700000001
			}
		];

		const calls: Array<() => void> = [];
		const mockAdapter: VCSAdapter = {
			detect: async () => true,
			getCurrentBranch: async () => "main",
			getBranches: async () => ["main"],
			getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
			switchBranch: async () => ({ status: "noop" }),
			getChanges: async () => [],
			getCommits: async () => [],
			getHistory: mock(
				() =>
					new Promise<GitHistoryCommit[]>((resolve) => {
						calls.push(() => resolve(calls.length === 1 ? staleCommits : freshCommits));
					})
			)
		};

		const repo = new Repository(rootOrigin, () => mockAdapter);
		const first = repo.refreshHistory();
		const second = repo.refreshHistory();

		// Resolve out of order: the newer call lands first.
		calls[1]();
		await second;
		calls[0]();
		const firstResult = await first;

		expect(firstResult).toBe(false);
		expect(repo.historyCommits).toEqual(freshCommits);
	});

	it("keeps fetched history when the ahead-count read fails", async () => {
		const mockCommits: GitHistoryCommit[] = [
			{
				sha: "cccccccccccccccccccccccccccccccccccccccc",
				shortSha: "ccccccc",
				subject: "feat: something",
				author: "Hatch",
				timestamp: 1700000002
			}
		];

		const mockAdapter: VCSAdapter = {
			detect: async () => true,
			getCurrentBranch: async () => "main",
			getBranches: async () => ["main"],
			getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
			switchBranch: async () => ({ status: "noop" }),
			getChanges: async () => [],
			getCommits: async () => [],
			getHistory: mock(async () => mockCommits),
			getAheadCount: mock(async () => {
				throw new Error("rev-list failed");
			})
		};

		const repo = new Repository(rootOrigin, () => mockAdapter);
		const result = await repo.refreshHistory();

		expect(result).toBe(true);
		expect(repo.historyCommits).toEqual(mockCommits);
		expect(repo.aheadCount).toBe(0);
	});
});

describe("History tab: .git-watch refresh (Ticket #349 / ADR 0027)", () => {
	it("updates historyCommits when a commit is made in the terminal while app is open", async () => {
		let eventCallback: any = null;
		let commits = [
			{
				sha: "1111111111111111111111111111111111111111",
				shortSha: "1111111",
				subject: "initial commit",
				author: "Dev",
				timestamp: 1700000000
			}
		];

		const mockAdapter: VCSAdapter = {
			detect: async () => true,
			getCurrentBranch: async () => "main",
			getBranches: async () => ["main"],
			getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
			switchBranch: async () => ({ status: "noop" }),
			getChanges: async () => [],
			getCommits: async () => [],
			getHistory: mock(async () => commits)
		};

		const repo = new Repository(rootOrigin, () => mockAdapter);
		await repo.refresh();
		expect(repo.historyCommits).toEqual(commits);

		const state: any = {
			workspace: {},
			ownerId: "git",
			repository: repo,
			disposed: false,
			pending: new Set(),
			disposables: [],
			currentOpenId: 1,
			isActive: () => true
		};

		await startWorkspaceGitWatcher(state, rootOrigin, repo, {
			gitRun: async () => ({ code: 0, stdout: ".git\n", stderr: "" }),
			watchDirectory: (dirPath: string, cb: any) => {
				eventCallback = cb;
				return () => {};
			},
			debounceMs: 20
		});

		// External commit made in terminal on branch main
		const newCommit = {
			sha: "2222222222222222222222222222222222222222",
			shortSha: "2222222",
			subject: "terminal commit",
			author: "Dev",
			timestamp: 1700000050
		};
		commits = [newCommit, ...commits];

		eventCallback([{ path: "/test/repo/.git/refs/heads/main", type: "update" }]);

		// Wait for debounce to settle
		await new Promise((r) => setTimeout(r, 50));

		// Verified: commit appears in historyCommits without any polling
		expect(repo.historyCommits).toEqual(commits);

		stopWorkspaceGitWatcher(state);
	});

	it("updates the commit list when switching branches in the terminal", async () => {
		let eventCallback: any = null;
		let featureCommits = [
			{
				sha: "3333333333333333333333333333333333333333",
				shortSha: "3333333",
				subject: "feature branch commit",
				author: "Dev",
				timestamp: 1700000100
			}
		];

		const mockAdapter: VCSAdapter = {
			detect: async () => true,
			getCurrentBranch: async () => "main",
			getBranches: async () => ["main", "feature"],
			getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
			switchBranch: async () => ({ status: "noop" }),
			getChanges: async () => [],
			getCommits: async () => [],
			getHistory: mock(async () => featureCommits)
		};

		const repo = new Repository(rootOrigin, () => mockAdapter);
		const state: any = {
			workspace: {},
			ownerId: "git",
			repository: repo,
			disposed: false,
			pending: new Set(),
			disposables: [],
			currentOpenId: 1,
			isActive: () => true
		};

		await startWorkspaceGitWatcher(state, rootOrigin, repo, {
			gitRun: async () => ({ code: 0, stdout: ".git\n", stderr: "" }),
			watchDirectory: (dirPath: string, cb: any) => {
				eventCallback = cb;
				return () => {};
			},
			debounceMs: 20
		});

		// External branch switch in terminal modifies HEAD
		eventCallback([{ path: "/test/repo/.git/HEAD", type: "update" }]);

		await new Promise((r) => setTimeout(r, 50));

		expect(repo.historyCommits).toEqual(featureCommits);

		stopWorkspaceGitWatcher(state);
	});

	it("keeps staging churn (index writes) from triggering history refetch", async () => {
		let eventCallback: any = null;
		let getHistoryCalls = 0;

		const mockAdapter: VCSAdapter = {
			detect: async () => true,
			getCurrentBranch: async () => "main",
			getBranches: async () => ["main"],
			getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
			switchBranch: async () => ({ status: "noop" }),
			getChanges: async () => [],
			getCommits: async () => [],
			getHistory: mock(async () => {
				getHistoryCalls++;
				return [];
			})
		};

		const repo = new Repository(rootOrigin, () => mockAdapter);
		const state: any = {
			workspace: {},
			ownerId: "git",
			repository: repo,
			disposed: false,
			pending: new Set(),
			disposables: [],
			currentOpenId: 1,
			isActive: () => true
		};

		await startWorkspaceGitWatcher(state, rootOrigin, repo, {
			gitRun: async () => ({ code: 0, stdout: ".git\n", stderr: "" }),
			watchDirectory: (dirPath: string, cb: any) => {
				eventCallback = cb;
				return () => {};
			},
			debounceMs: 20
		});

		// Staging file in terminal modifies index
		eventCallback([{ path: "/test/repo/.git/index", type: "update" }]);

		await new Promise((r) => setTimeout(r, 50));

		expect(getHistoryCalls).toBe(0);

		stopWorkspaceGitWatcher(state);
	});

	it("resolves the real git dir via git rev-parse --git-dir for linked worktrees", async () => {
		let watchedDirPath = "";
		let eventCallback: any = null;
		const worktreeCommits = [
			{
				sha: "4444444444444444444444444444444444444444",
				shortSha: "4444444",
				subject: "worktree commit",
				author: "Dev",
				timestamp: 1700000200
			}
		];

		const mockAdapter: VCSAdapter = {
			detect: async () => true,
			getCurrentBranch: async () => "feature-wt",
			getBranches: async () => ["feature-wt"],
			getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
			switchBranch: async () => ({ status: "noop" }),
			getChanges: async () => [],
			getCommits: async () => [],
			getHistory: mock(async () => worktreeCommits)
		};

		const repo = new Repository(rootOrigin, () => mockAdapter);
		const state: any = {
			workspace: {},
			ownerId: "git",
			repository: repo,
			disposed: false,
			pending: new Set(),
			disposables: [],
			currentOpenId: 1,
			isActive: () => true
		};

		// Linked worktree: .git is a pointer file, real git dir is under main repo worktrees
		const worktreeGitDir = "/workspace/main-repo/.git/worktrees/linked-wt";

		await startWorkspaceGitWatcher(state, rootOrigin, repo, {
			gitRun: async (_workingDir, args) => {
				if (args[0] === "rev-parse" && args[1] === "--git-dir") {
					return { code: 0, stdout: `${worktreeGitDir}\n`, stderr: "" };
				}
				return { code: 0, stdout: "", stderr: "" };
			},
			watchDirectory: (dirPath: string, cb: any) => {
				watchedDirPath = dirPath;
				eventCallback = cb;
				return () => {};
			},
			debounceMs: 20
		});

		// Verified: watches the real git dir, not the pointer file
		expect(watchedDirPath).toBe(worktreeGitDir);

		// Event in the linked worktree HEAD fires refresh
		eventCallback([{ path: `${worktreeGitDir}/HEAD`, type: "update" }]);
		await new Promise((r) => setTimeout(r, 50));

		expect(repo.historyCommits).toEqual(worktreeCommits);

		stopWorkspaceGitWatcher(state);
	});
});


