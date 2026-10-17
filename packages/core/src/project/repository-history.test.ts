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

	it("discards a stale refreshHistory() result when a newer one lands first", async () => {
		const staleCommits: GitHistoryCommit[] = [
			{
				sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				shortSha: "aaaaaaa",
				subject: "stale",
				author: "Hatch",
				authorName: "Hatch",
				timestamp: 1700000000
			}
		];
		const freshCommits: GitHistoryCommit[] = [
			{
				sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
				shortSha: "bbbbbbb",
				subject: "fresh",
				author: "Hatch",
				authorName: "Hatch",
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
});

