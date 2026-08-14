(globalThis as any).$state = Object.assign(<T>(v: T) => v, {
	snapshot: <T>(v: T) => v,
	raw: <T>(v: T) => v
});
(globalThis as any).$derived = Object.assign(<T>(v: T) => v, {
	by: (fn: any) => fn()
});
(globalThis as any).$effect = Object.assign(() => {}, {
	root: (cb: () => void) => { cb(); return () => {}; }
});

import { describe, it, expect, mock } from 'bun:test';
import { Repository } from './repository.svelte';
import type { VCSAdapter, VCSStatus, GitChange } from './vcs';
import type { FileOrigin } from '../storage';

const mockOrigin: FileOrigin = { scheme: 'browser', path: '/test', name: 'test' };

function createMockAdapter(overrides: Partial<VCSAdapter> = {}): VCSAdapter {
	return {
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
