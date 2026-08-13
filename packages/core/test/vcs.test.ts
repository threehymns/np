import { describe, test, expect } from 'bun:test';
import type { VCSAdapter, VCSStatus, SwitchResult, GitChange, GitCommit } from '../src/project/vcs';

/**
 * A standard MockVCSAdapter implementing the VCSAdapter interface
 * to prove full conformance to the core contract.
 */
class MockVCSAdapter implements VCSAdapter {
	public rootPath: string | null = null;
	public currentBranch: string | null = 'master';
	public branches: string[] = ['master', 'feature-1', 'feature-2'];
	public status: VCSStatus = { isDirty: false, uncommittedFiles: [] };

	// Track calls for verification
	public calls: { method: string; args: any[] }[] = [];

	async detect(rootPath: string): Promise<boolean> {
		this.calls.push({ method: 'detect', args: [rootPath] });
		this.rootPath = rootPath;
		return rootPath.includes('.git') || rootPath.endsWith('project');
	}

	async getCurrentBranch(): Promise<string | null> {
		this.calls.push({ method: 'getCurrentBranch', args: [] });
		return this.currentBranch;
	}

	async getBranches(): Promise<string[]> {
		this.calls.push({ method: 'getBranches', args: [] });
		return this.branches;
	}

	async getStatus(): Promise<VCSStatus> {
		this.calls.push({ method: 'getStatus', args: [] });
		return this.status;
	}

	async switchBranch(branchName: string, options?: { dryRun?: boolean }): Promise<SwitchResult> {
		this.calls.push({ method: 'switchBranch', args: [branchName, options] });

		if (!this.branches.includes(branchName)) {
			return { status: 'error', message: `Branch ${branchName} does not exist` };
		}

		if (this.currentBranch === branchName) {
			return { status: 'noop' };
		}

		if (this.status.isDirty) {
			// Simulate conflicts
			if (this.status.uncommittedFiles.includes('conflict.txt')) {
				return {
					status: 'blocked',
					reason: 'conflict',
					files: ['conflict.txt']
				};
			}
			return {
				status: 'blocked',
				reason: 'worktree',
				files: this.status.uncommittedFiles
			};
		}

		if (!options?.dryRun) {
			this.currentBranch = branchName;
		}

		return { status: 'switched' };
	}

	// Optional methods for testing
	async getChanges(): Promise<GitChange[]> {
		this.calls.push({ method: 'getChanges', args: [] });
		return [
			{
				filepath: 'src/index.ts',
				status: 'M',
				additions: 5,
				deletions: 2,
				diff: '@@ -1,3 +1,6 @@\n...',
				staged: false
			}
		];
	}

	async getCommits(): Promise<GitCommit[]> {
		this.calls.push({ method: 'getCommits', args: [] });
		return [
			{
				hash: 'abc123f',
				author: 'Author <author@example.com>',
				message: 'Initial commit',
				date: '2023-10-01',
				files: ['package.json']
			}
		];
	}
}

/**
 * Reusable contract test suite for any VCSAdapter implementation.
 * Ensures the adapter adheres strictly to the contract/interface guidelines.
 */
function runVCSAdapterContractTests(createAdapter: () => Promise<VCSAdapter>) {
	test('detect should return boolean', async () => {
		const adapter = await createAdapter();
		const result = await adapter.detect('/path/to/project');
		expect(typeof result).toBe('boolean');
	});

	test('getCurrentBranch should return string or null', async () => {
		const adapter = await createAdapter();
		const branch = await adapter.getCurrentBranch();
		if (branch !== null) {
			expect(typeof branch).toBe('string');
		} else {
			expect(branch).toBeNull();
		}
	});

	test('getBranches should return an array of strings', async () => {
		const adapter = await createAdapter();
		const branches = await adapter.getBranches();
		expect(Array.isArray(branches)).toBe(true);
		for (const b of branches) {
			expect(typeof b).toBe('string');
		}
	});

	test('getStatus should return a valid VCSStatus object', async () => {
		const adapter = await createAdapter();
		const status = await adapter.getStatus();
		expect(status).toBeDefined();
		expect(typeof status.isDirty).toBe('boolean');
		expect(Array.isArray(status.uncommittedFiles)).toBe(true);
		for (const file of status.uncommittedFiles) {
			expect(typeof file).toBe('string');
		}
	});

	test('switchBranch should resolve to a valid SwitchResult', async () => {
		const adapter = await createAdapter();
		const result = await adapter.switchBranch('master');
		expect(result).toBeDefined();
		expect(['switched', 'noop', 'blocked', 'error']).toContain(result.status);

		if (result.status === 'blocked') {
			expect(['conflict', 'worktree']).toContain(result.reason);
			expect(Array.isArray(result.files)).toBe(true);
		} else if (result.status === 'error') {
			expect(typeof result.message).toBe('string');
		}
	});
}

describe('VCSAdapter Core Contract Assertions', () => {
	// Execute the shared contract tests on our MockVCSAdapter
	describe('Contract Verification', () => {
		runVCSAdapterContractTests(async () => new MockVCSAdapter());
	});

	// Additional adapter-specific behaviors
	describe('MockVCSAdapter Behavior tests', () => {
		test('correctly transitions branch on clean checkout', async () => {
			const adapter = new MockVCSAdapter();

			// Detect
			const isGit = await adapter.detect('/workspace/my-git-project');
			expect(isGit).toBe(true);

			// Initial state
			expect(await adapter.getCurrentBranch()).toBe('master');
			expect(await adapter.getBranches()).toEqual(['master', 'feature-1', 'feature-2']);

			// Switch branch
			const res = await adapter.switchBranch('feature-1');
			expect(res).toEqual({ status: 'switched' });
			expect(await adapter.getCurrentBranch()).toBe('feature-1');
		});

		test('returns noop if already on target branch', async () => {
			const adapter = new MockVCSAdapter();
			const res = await adapter.switchBranch('master');
			expect(res).toEqual({ status: 'noop' });
			expect(await adapter.getCurrentBranch()).toBe('master');
		});

		test('blocks branch checkout when worktree is dirty', async () => {
			const adapter = new MockVCSAdapter();
			adapter.status = { isDirty: true, uncommittedFiles: ['README.md'] };

			const res = await adapter.switchBranch('feature-1');
			expect(res).toEqual({
				status: 'blocked',
				reason: 'worktree',
				files: ['README.md']
			});
			// Should not switch branch
			expect(await adapter.getCurrentBranch()).toBe('master');
		});

		test('blocks branch checkout with conflict when conflicting file exists', async () => {
			const adapter = new MockVCSAdapter();
			adapter.status = { isDirty: true, uncommittedFiles: ['conflict.txt', 'README.md'] };

			const res = await adapter.switchBranch('feature-1');
			expect(res).toEqual({
				status: 'blocked',
				reason: 'conflict',
				files: ['conflict.txt']
			});
			// Should not switch branch
			expect(await adapter.getCurrentBranch()).toBe('master');
		});

		test('returns error when branch is invalid', async () => {
			const adapter = new MockVCSAdapter();
			const res = await adapter.switchBranch('non-existent-branch');
			expect(res.status).toBe('error');
			if (res.status === 'error') {
				expect(res.message).toBe('Branch non-existent-branch does not exist');
			}
		});

		test('does not switch branch when dryRun option is specified', async () => {
			const adapter = new MockVCSAdapter();
			const res = await adapter.switchBranch('feature-1', { dryRun: true });
			expect(res).toEqual({ status: 'switched' });
			expect(await adapter.getCurrentBranch()).toBe('master');
		});

		test('handles optional methods for file changes and commits', async () => {
			const adapter = new MockVCSAdapter();
			if (adapter.getChanges && adapter.getCommits) {
				const changes = await adapter.getChanges();
				expect(changes.length).toBe(1);
				expect(changes[0].filepath).toBe('src/index.ts');
				expect(changes[0].status).toBe('M');

				const commits = await adapter.getCommits();
				expect(commits.length).toBe(1);
				expect(commits[0].hash).toBe('abc123f');
				expect(commits[0].message).toBe('Initial commit');
			}
		});
	});
});
