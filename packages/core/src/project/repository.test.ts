import "../../../../tests/contract/rune-setup";
import { describe, it, expect, mock } from 'bun:test';
import { Repository } from './repository.svelte';
import type { VCSAdapter, VCSStatus, GitChange } from './vcs';
import type { FileOrigin } from '../storage';

const mockOrigin: FileOrigin = { scheme: 'browser', path: '/test', name: 'test' };

function createMockAdapter(overrides: Partial<VCSAdapter> = {}): VCSAdapter {
	return {
		detect: mock(async () => true),
		getCurrentBranch: mock(async () => 'main'),
		getBranches: mock(async () => ['main']),
		getStatus: mock(async (): Promise<VCSStatus> => ({
			isDirty: false,
			uncommittedFiles: []
		})),
		switchBranch: mock(async () => ({ status: 'switched' as const })),
		...overrides
	};
}

describe('Repository.refresh', () => {
	it('catches getChanges failures and preserves dirty state from getStatus', async () => {
		const mockAdapter = createMockAdapter({
			getStatus: mock(async (): Promise<VCSStatus> => ({
				isDirty: true,
				uncommittedFiles: ['Unable to read git status']
			})),
			getChanges: mock(async (): Promise<GitChange[]> => {
				throw new Error('git statusMatrix failed');
			})
		});

		const repo = new Repository(mockOrigin, () => mockAdapter);
		const success = await repo.refresh();

		expect(success).toBe(true);
		expect(mockAdapter.getStatus).toHaveBeenCalled();
		expect(repo.changes).toEqual([]);
		expect(repo.uncommittedFiles).toEqual(['Unable to read git status']);
		expect(repo.isDirty).toBe(true);
	});

	it('populates changes and dirty state when getChanges succeeds', async () => {
		const mockChanges: GitChange[] = [
			{
				filepath: 'foo.ts',
				status: 'M',
				additions: 2,
				deletions: 1,
				diff: '',
				staged: false
			}
		];
		const mockAdapter = createMockAdapter({
			getStatus: mock(async (): Promise<VCSStatus> => ({
				isDirty: true,
				uncommittedFiles: ['foo.ts']
			})),
			getChanges: mock(async (): Promise<GitChange[]> => mockChanges)
		});

		const repo = new Repository(mockOrigin, () => mockAdapter);
		const success = await repo.refresh();

		expect(success).toBe(true);
		expect(repo.changes).toEqual(mockChanges);
		expect(repo.uncommittedFiles).toEqual(['foo.ts']);
		expect(repo.isDirty).toBe(true);
	});

	it('falls back to getStatus when getChanges is undefined on the adapter', async () => {
		const mockAdapter = createMockAdapter({
			getStatus: mock(async (): Promise<VCSStatus> => ({
				isDirty: true,
				uncommittedFiles: ['untracked.txt']
			}))
		});

		const repo = new Repository(mockOrigin, () => mockAdapter);
		const success = await repo.refresh();

		expect(success).toBe(true);
		expect(mockAdapter.getStatus).toHaveBeenCalled();
		expect(repo.changes).toEqual([]);
		expect(repo.uncommittedFiles).toEqual(['untracked.txt']);
		expect(repo.isDirty).toBe(true);
	});
});

describe('Repository bulk actions', () => {
	function createRepoWithBulk(overrides: Partial<VCSAdapter> = {}) {
		const stageAll = mock(async () => {});
		const unstageAll = mock(async () => {});
		const discardAll = mock(async () => {});
		const adapter = createMockAdapter({
			stageAll,
			unstageAll,
			discardAll,
			...overrides
		});
		const repo = new Repository(mockOrigin, () => adapter);
		return { repo, adapter, stageAll, unstageAll, discardAll };
	}

	it('stageAll delegates to the adapter and refreshes, returning true', async () => {
		const { repo, adapter, stageAll } = createRepoWithBulk();
		const result = await repo.stageAll();

		expect(result).toBe(true);
		expect(stageAll).toHaveBeenCalled();
		expect(adapter.getCurrentBranch).toHaveBeenCalled(); // refresh happened
	});

	it('unstageAll delegates to the adapter and refreshes, returning true', async () => {
		const { repo, unstageAll } = createRepoWithBulk();
		const result = await repo.unstageAll();

		expect(result).toBe(true);
		expect(unstageAll).toHaveBeenCalled();
	});

	it('discardAll delegates to the adapter and refreshes, returning true', async () => {
		const { repo, discardAll } = createRepoWithBulk();
		const result = await repo.discardAll();

		expect(result).toBe(true);
		expect(discardAll).toHaveBeenCalled();
	});

	it('returns false when the adapter does not implement stageAll', async () => {
		const adapter = createMockAdapter(); // no stageAll
		const repo = new Repository(mockOrigin, () => adapter);
		const result = await repo.stageAll();

		expect(result).toBe(false);
		expect(repo.isBusy).toBe(false);
	});

	it('manages the busy state cleanly around bulk operations', async () => {
		let busyDuringOp: boolean | undefined;
		const adapter = createMockAdapter({
			stageAll: mock(async () => { busyDuringOp = repo.isBusy; })
		});
		const repo = new Repository(mockOrigin, () => adapter);

		await repo.stageAll();

		expect(busyDuringOp).toBe(true);
		expect(repo.isBusy).toBe(false);
	});

	it('propagates adapter errors so the caller can surface them', async () => {
		const stageAll = mock(async () => { throw new Error('boom'); });
		const { repo } = createRepoWithBulk({ stageAll });
		await expect(repo.stageAll()).rejects.toThrow('boom');
		expect(repo.isBusy).toBe(false);
	});
});
