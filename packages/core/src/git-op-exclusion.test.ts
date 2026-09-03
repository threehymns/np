import "../../../tests/contract/rune-setup";
import { describe, it, expect, mock } from "bun:test";
import { applyHunkAction, registerCoreCommands, CommandRegistry, type HunkRange } from "./commands.svelte";
import { Repository, runExclusively } from "./project/repository.svelte";
import type { GitChange, VCSAdapter } from "./project/vcs";

// Overlap-timing like this cannot be produced deterministically against real
// git engines (ADR 0004 confines mocks to error paths and exact-call pinning),
// so these tests pin the queue semantics with fake adapters. Semantic outcomes
// of the operations themselves stay covered by tests/contract/.

// Yield to the event loop so the serialized git-op queue drains to its first
// awaited gate deterministically. A macrotask (setTimeout) is more robust than
// counting microtasks: `runExclusively` chains on the queue with `.then`, which
// is entirely microtask-scheduled, so a single macrotask fires after every
// pending microtask has resolved and the first op is parked on its gate.
const flushQueue = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function createTestChange(filepath: string): GitChange {
	return {
		filepath,
		status: "M",
		additions: 1,
		deletions: 0,
		diff: "",
		staged: false,
		originalContent: "a\nb\n",
		modifiedContent: "a\nc\n"
	};
}

const hunk: HunkRange = { fromA: 2, toA: 3, fromB: 2, toB: 3 };

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

describe("repository git operations serialize", () => {
	it("runs overlapping hunk actions one at a time and holds isBusy until the last completes", async () => {
		const gateA = deferred<void>();
		const writes: string[] = [];

		const adapter = {
			updateIndexContent: mock(async (filepath: string) => {
				writes.push(filepath);
				if (filepath === 'a.txt') await gateA.promise;
			})
		};
		const repo = {
			adapter,
			isBusy: false,
			refresh: mock(async () => {})
		};
		const appState = { workspace: { repository: repo }, dialogService: { alert: mock(async () => {}) } } as any;

		const first = applyHunkAction(appState, createTestChange('a.txt'), hunk, 'stage');
		const second = applyHunkAction(appState, createTestChange('b.txt'), hunk, 'stage');
		await flushQueue();

		expect(writes).toEqual(['a.txt']);
		expect(repo.isBusy).toBe(true);

		gateA.resolve();
		await Promise.all([first, second]);

		expect(writes).toEqual(['a.txt', 'b.txt']);
		expect(repo.isBusy).toBe(false);
	});

	it("holds isBusy across overlapping command-driven git ops until all finish", async () => {
		const gate = deferred<void>();
		const adapter: Partial<VCSAdapter> = {
			stageFile: mock(async () => {
				await gate.promise;
			})
		};
		const repo = {
			adapter,
			isBusy: false,
			changes: [],
			refresh: mock(async () => {})
		};
		const commands = new CommandRegistry();
		registerCoreCommands({ commands, workspace: { repository: repo }, dialogService: { alert: mock(async () => {}) } } as any);

		const first = commands.execute('git.stage', 'x.txt');
		const second = commands.execute('git.stage', 'y.txt');
		await flushQueue();

		expect(adapter.stageFile as any).toHaveBeenCalledTimes(1);
		expect(repo.isBusy).toBe(true);

		gate.resolve();
		await Promise.all([first, second]);

		expect(adapter.stageFile as any).toHaveBeenCalledTimes(2);
		expect(repo.isBusy).toBe(false);
	});

	it("refresh() does not stomp isBusy owned by the exclusive queue", async () => {
		const repo = new Repository(
			{ scheme: 'file', path: '/projects/np', name: 'np' },
			(): VCSAdapter => ({
				detect: mock(async () => true),
				getCurrentBranch: async () => 'main',
				getBranches: async () => ['main'],
				getStatus: async () => ({ isDirty: false, uncommittedFiles: [] })
			})
		);

		await runExclusively(repo, async () => {
			await repo.refresh();
			expect(repo.isBusy).toBe(true);
		});

		expect(repo.isBusy).toBe(false);
	});
});
