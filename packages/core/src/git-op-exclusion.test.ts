import "../../../tests/contract/rune-setup";
import { describe, it, expect, mock } from "bun:test";
import { applyHunkAction, registerCoreCommands, CommandRegistry, type HunkRange } from "./commands.svelte";
import type { GitChange, VCSAdapter } from "./project/vcs";

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
		for (let i = 0; i < 10; i++) await Promise.resolve();

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
		for (let i = 0; i < 10; i++) await Promise.resolve();

		expect(adapter.stageFile as any).toHaveBeenCalledTimes(1);
		expect(repo.isBusy).toBe(true);

		gate.resolve();
		await Promise.all([first, second]);

		expect(adapter.stageFile as any).toHaveBeenCalledTimes(2);
		expect(repo.isBusy).toBe(false);
	});
});
