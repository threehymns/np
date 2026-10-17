import "../../../../tests/contract/rune-setup";
import { describe, it, expect, mock } from "bun:test";
import { Repository } from "./repository.svelte";
import type { VCSAdapter, GitHistoryCommit } from "./vcs";
import type { FileOrigin } from "../storage";

const rootOrigin: FileOrigin = { scheme: "file", path: "/test/repo", name: "repo" };

describe("Repository history log integration (Ticket #345)", () => {
	it("prefetches history commits on refresh()", async () => {
		const mockCommits: GitHistoryCommit[] = [
			{
				sha: "1111111222222233333334444444555555566666",
				shortSha: "1111111",
				subject: "feat: add history tab",
				author: "Hatch",
				authorName: "Hatch",
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
});

