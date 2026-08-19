import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { IsomorphicGitAdapter } from './isomorphic-git';
import type { FileOrigin } from '@np/core';
import git, { type StatusRow } from 'isomorphic-git';
import { browserHandleRegistry } from './storage';

// Mutable, typed view of the isomorphic-git module so tests can swap functions
// in/out without resorting to `any`.
const mockGit = git as unknown as {
	statusMatrix: typeof git.statusMatrix;
	add: typeof git.add;
	updateIndex: typeof git.updateIndex;
	remove: typeof git.remove;
	resetIndex: typeof git.resetIndex;
	checkout: typeof git.checkout;
};

describe('IsomorphicGitAdapter', () => {
	const rootOrigin: FileOrigin = { scheme: 'browser', path: '/test/repo', name: 'repo' };
	let mockDirectoryHandle: any;

	beforeEach(() => {
		mockDirectoryHandle = {
			kind: 'directory',
			name: 'repo',
			queryPermission: mock(async () => 'granted'),
			getDirectoryHandle: mock(async (name: string) => {
				if (name === '.git') return { kind: 'directory', name: '.git' };
				throw Object.assign(new Error('NotFoundError: directory not found'), { name: 'NotFoundError' });
			}),
			keys: async function* () { yield '.git'; yield 'file.txt'; },
			getFileHandle: mock(async (name: string) => {
				return {
					kind: 'file',
					name,
					getFile: mock(async () => ({
						text: mock(async () => 'workdir file text'),
						arrayBuffer: mock(async () => new TextEncoder().encode('workdir file text').buffer),
						size: 17,
						lastModified: Date.now()
					}))
				};
			}),
			removeEntry: mock(async () => {})
		};

		browserHandleRegistry.register('browser:///test/repo', mockDirectoryHandle);
	});

	it('getChanges returns change metadata without reading blobs or full files', async () => {
		const readBlobSpy = mock(async () => ({ blob: new Uint8Array() }));
		const origReadBlob = git.readBlob;
		(git as any).readBlob = readBlobSpy;

		const statusMatrixSpy = mock(async (): Promise<StatusRow[]> => [
			['staged.txt', 0, 1, 1], // Added staged
			['modified.txt', 1, 2, 1], // Modified unstaged
			['clean.txt', 1, 1, 1] // Unmodified
		]);
		const origStatusMatrix = git.statusMatrix;
		mockGit.statusMatrix = statusMatrixSpy;

		try {
			const adapter = new IsomorphicGitAdapter(rootOrigin);
			const changes = await adapter.getChanges();

			expect(changes.length).toBe(2);
			expect(changes[0].filepath).toBe('staged.txt');
			expect(changes[0].staged).toBe(true);
			expect(changes[0].status).toBe('A');

			expect(changes[1].filepath).toBe('modified.txt');
			expect(changes[1].staged).toBe(false);
			expect(changes[1].status).toBe('M');

			// Verify git.readBlob was NOT called during getChanges
			expect(readBlobSpy).not.toHaveBeenCalled();
		} finally {
			(git as any).readBlob = origReadBlob;
			mockGit.statusMatrix = origStatusMatrix;
		}
	});

	it('counts lines for untracked files during getChanges without reading blobs', async () => {
		const readBlobSpy = mock(async () => ({ blob: new Uint8Array() }));
		const origReadBlob = git.readBlob;
		(git as any).readBlob = readBlobSpy;

		const statusMatrixSpy = mock(async (): Promise<StatusRow[]> => [
			['untracked.txt', 0, 2, 0] // Untracked (present in workdir only)
		]);
		const origStatusMatrix = git.statusMatrix;
		mockGit.statusMatrix = statusMatrixSpy;

		try {
			const adapter = new IsomorphicGitAdapter(rootOrigin);
			const changes = await adapter.getChanges();

			expect(changes.length).toBe(1);
			expect(changes[0].filepath).toBe('untracked.txt');
			expect(changes[0].status).toBe('U');
			expect(changes[0].additions).toBe(1);
			expect(changes[0].deletions).toBe(0);

			// Git blob reads must still be avoided during getChanges
			expect(readBlobSpy).not.toHaveBeenCalled();
		} finally {
			(git as any).readBlob = origReadBlob;
			mockGit.statusMatrix = origStatusMatrix;
		}
	});

	it('propagates error when statusMatrix fails in getChanges', async () => {
		const statusMatrixSpy = mock(async () => {
			throw new Error('Status matrix failed');
		});
		const origStatusMatrix = git.statusMatrix;
		mockGit.statusMatrix = statusMatrixSpy;

		try {
			const adapter = new IsomorphicGitAdapter(rootOrigin);
			await expect(adapter.getChanges()).rejects.toThrow('Status matrix failed');
		} finally {
			mockGit.statusMatrix = origStatusMatrix;
		}
	});

	it('propagates raw NotReadableError when reading worktree content in getFileDiff', async () => {
		const readBlobSpy = mock(async ({ oid }: { oid: string }) => {
			if (oid === 'head-commit-oid') {
				return { blob: new TextEncoder().encode('head text') };
			}
			return { blob: new Uint8Array() };
		});
		const resolveRefSpy = mock(async () => 'head-commit-oid');
		const walkSpy = mock(async ({ map }: { map: Function }) => {
			await map('blocked.txt', [{
				type: async () => 'blob',
				oid: async () => 'head-commit-oid'
			}]);
		});

		const origReadBlob = git.readBlob;
		const origResolveRef = git.resolveRef;
		const origWalk = git.walk;
		(git as any).readBlob = readBlobSpy;
		(git as any).resolveRef = resolveRefSpy;
		(git as any).walk = walkSpy;

		mockDirectoryHandle.getFileHandle = mock(async () => ({
			kind: 'file',
			name: 'blocked.txt',
			getFile: mock(async () => {
				throw Object.assign(new Error('NotReadableError: file is locked'), { name: 'NotReadableError' });
			})
		}));

		try {
			const adapter = new IsomorphicGitAdapter(rootOrigin);
			await expect(adapter.getFileDiff('blocked.txt', { staged: false })).rejects.toMatchObject({
				name: 'NotReadableError'
			});
		} finally {
			(git as any).readBlob = origReadBlob;
			(git as any).resolveRef = origResolveRef;
			(git as any).walk = origWalk;
		}
	});

	it('propagates permission (EACCES) errors when reading worktree content in getFileDiff', async () => {
		const readBlobSpy = mock(async ({ oid }: { oid: string }) => {
			return { blob: new TextEncoder().encode('head text') };
		});
		const resolveRefSpy = mock(async () => 'head-commit-oid');
		const walkSpy = mock(async ({ map }: { map: Function }) => {
			await map('blocked.txt', [{
				type: async () => 'blob',
				oid: async () => 'head-commit-oid'
			}]);
		});

		const origReadBlob = git.readBlob;
		const origResolveRef = git.resolveRef;
		const origWalk = git.walk;
		(git as any).readBlob = readBlobSpy;
		(git as any).resolveRef = resolveRefSpy;
		(git as any).walk = walkSpy;

		mockDirectoryHandle.getFileHandle = mock(async () => {
			throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
		});

		try {
			const adapter = new IsomorphicGitAdapter(rootOrigin);
			await expect(adapter.getFileDiff('blocked.txt', { staged: false })).rejects.toThrow('EACCES');
		} finally {
			(git as any).readBlob = origReadBlob;
			(git as any).resolveRef = origResolveRef;
			(git as any).walk = origWalk;
		}
	});

	it('does not treat message-only ENOENT errors as missing files in getFileDiff', async () => {
		const readBlobSpy = mock(async ({ oid }: { oid: string }) => {
			return { blob: new TextEncoder().encode('head text') };
		});
		const resolveRefSpy = mock(async () => 'head-commit-oid');
		const walkSpy = mock(async ({ map }: { map: Function }) => {
			await map('blocked.txt', [{
				type: async () => 'blob',
				oid: async () => 'head-commit-oid'
			}]);
		});

		const origReadBlob = git.readBlob;
		const origResolveRef = git.resolveRef;
		const origWalk = git.walk;
		(git as any).readBlob = readBlobSpy;
		(git as any).resolveRef = resolveRefSpy;
		(git as any).walk = walkSpy;

		mockDirectoryHandle.getFileHandle = mock(async () => ({
			kind: 'file',
			name: 'blocked.txt',
			getFile: mock(async () => {
				throw new Error('ENOENT: no such file or directory');
			})
		}));

		try {
			const adapter = new IsomorphicGitAdapter(rootOrigin);
			await expect(adapter.getFileDiff('blocked.txt', { staged: false })).rejects.toThrow(
				'ENOENT: no such file or directory'
			);
		} finally {
			(git as any).readBlob = origReadBlob;
			(git as any).resolveRef = origResolveRef;
			(git as any).walk = origWalk;
		}
	});

	it('stageAll does a single statusMatrix pass and stages every change in one batch', async () => {
		const statusMatrixSpy = mock(async (): Promise<StatusRow[]> => [
			['new.txt', 0, 2, 0], // Untracked
			['mod.txt', 1, 2, 1], // Modified unstaged
			['del.txt', 1, 0, 1], // Deleted from worktree
			['clean.txt', 1, 1, 1] // Unmodified
		]);
		const addSpy = mock(async (_args: { filepath: string }) => {});
		const removeIndexSpy = mock(async (_args: { filepath: string; remove: boolean; force: boolean }) => {});
		const origStatusMatrix = git.statusMatrix;
		const origAdd = git.add;
		const origUpdateIndex = git.updateIndex;
		mockGit.statusMatrix = statusMatrixSpy;
		mockGit.add = addSpy;
		mockGit.updateIndex = removeIndexSpy;

		try {
			const adapter = new IsomorphicGitAdapter(rootOrigin);
			await adapter.stageAll();

			expect(statusMatrixSpy).toHaveBeenCalledTimes(1);
			expect(addSpy).toHaveBeenCalledTimes(2);
			expect(addSpy.mock.calls.map(([args]: [{ filepath: string }]) => args.filepath).sort()).toEqual(['mod.txt', 'new.txt']);
			expect(removeIndexSpy).toHaveBeenCalledTimes(1);
			expect(removeIndexSpy.mock.calls[0][0].filepath).toBe('del.txt');
			// Index-only removal: the worktree is never touched by staging.
			expect(removeIndexSpy.mock.calls[0][0].remove).toBe(true);
			expect(removeIndexSpy.mock.calls[0][0].force).toBe(true);
		} finally {
			mockGit.statusMatrix = origStatusMatrix;
			mockGit.add = origAdd;
			mockGit.updateIndex = origUpdateIndex;
		}
	});

	it('unstageAll does a single statusMatrix pass and resets only staged entries', async () => {
		const statusMatrixSpy = mock(async (): Promise<StatusRow[]> => [
			['staged.txt', 1, 2, 2], // Staged modification
			['both.txt', 1, 3, 2], // Staged + unstaged
			['untracked.txt', 0, 2, 0], // Untracked (not staged)
			['clean.txt', 1, 1, 1] // Unmodified
		]);
		const resetIndexSpy = mock(async (_args: { filepath: string }) => {});
		const origStatusMatrix = git.statusMatrix;
		const origResetIndex = git.resetIndex;
		mockGit.statusMatrix = statusMatrixSpy;
		mockGit.resetIndex = resetIndexSpy;

		try {
			const adapter = new IsomorphicGitAdapter(rootOrigin);
			await adapter.unstageAll();

			expect(statusMatrixSpy).toHaveBeenCalledTimes(1);
			expect(resetIndexSpy).toHaveBeenCalledTimes(2);
			expect(resetIndexSpy.mock.calls.map(([args]: [{ filepath: string }]) => args.filepath).sort()).toEqual(['both.txt', 'staged.txt']);
		} finally {
			mockGit.statusMatrix = origStatusMatrix;
			mockGit.resetIndex = origResetIndex;
		}
	});

	it('discardAll does a single statusMatrix pass, unlinks untracked and restores tracked', async () => {
		const statusMatrixSpy = mock(async (): Promise<StatusRow[]> => [
			['new.txt', 0, 2, 0], // Untracked
			['mod.txt', 1, 2, 2], // Staged + unstaged tracked change
			['clean.txt', 1, 1, 1] // Unmodified
		]);
		const checkoutSpy = mock(async (_args: { filepaths: string[]; force: boolean }) => {});
		const removeIndexSpy = mock(async (_args: { filepath: string; remove: boolean; force: boolean }) => {});
		const origStatusMatrix = git.statusMatrix;
		const origCheckout = git.checkout;
		const origUpdateIndex = git.updateIndex;
		mockGit.statusMatrix = statusMatrixSpy;
		mockGit.checkout = checkoutSpy;
		mockGit.updateIndex = removeIndexSpy;

		try {
			const adapter = new IsomorphicGitAdapter(rootOrigin);
			await adapter.discardAll();

			expect(statusMatrixSpy).toHaveBeenCalledTimes(1);
			expect(checkoutSpy).toHaveBeenCalledTimes(1);
			expect(checkoutSpy.mock.calls[0][0].filepaths).toEqual(['mod.txt']);
			expect(checkoutSpy.mock.calls[0][0].force).toBe(true);
			expect(removeIndexSpy).toHaveBeenCalledTimes(1);
			expect(removeIndexSpy.mock.calls[0][0].filepath).toBe('new.txt');
			// Index-only removal: the worktree is never touched by discardAll.
			expect(removeIndexSpy.mock.calls[0][0].remove).toBe(true);
			expect(removeIndexSpy.mock.calls[0][0].force).toBe(true);
		} finally {
			mockGit.statusMatrix = origStatusMatrix;
			mockGit.checkout = origCheckout;
			mockGit.updateIndex = origUpdateIndex;
		}
	});

	it('detect returns false when permission is not granted', async () => {
		const adapter = new IsomorphicGitAdapter(rootOrigin);
		mockDirectoryHandle.queryPermission = mock(async () => 'prompt');
		const result = await adapter.detect(rootOrigin.path);
		expect(result).toBe(false);
	});

	it('switchBranch blocks with the file named when a snapshot worktree read fails', async () => {
		const statusMatrixSpy = mock(async (): Promise<StatusRow[]> => [
			['blocked.txt', 1, 2, 1] // Modified unstaged
		]);
		const checkoutSpy = mock(async () => {});
		const walkSpy = mock(async ({ map }: { map: Function }) => {
			await map('blocked.txt', [{
				type: async () => 'blob',
				oid: async () => 'staged-oid'
			}]);
		});
		const readBlobSpy = mock(async ({ oid }: { oid: string }) => ({ blob: new Uint8Array(1), oid: 'same-oid' }));
		const resolveRefSpy = mock(async ({ ref }: { ref: string }) => (ref === 'HEAD' ? 'head-oid' : 'target-oid'));
		const currentBranchSpy = mock(async () => 'main');
		const origStatusMatrix = git.statusMatrix;
		const origCheckout = git.checkout;
		const origWalk = git.walk;
		const origReadBlob = git.readBlob;
		const origResolveRef = git.resolveRef;
		const origCurrentBranch = git.currentBranch;
		mockGit.statusMatrix = statusMatrixSpy;
		mockGit.checkout = checkoutSpy;
		(git as any).walk = walkSpy;
		(git as any).readBlob = readBlobSpy;
		(git as any).resolveRef = resolveRefSpy;
		(git as any).currentBranch = currentBranchSpy;
		mockDirectoryHandle.getFileHandle = mock(async () => {
			throw Object.assign(new Error('NotReadableError: blocked'), { name: 'NotReadableError' });
		});

		try {
			const adapter = new IsomorphicGitAdapter(rootOrigin);
			const result = await adapter.switchBranch('feature');

			expect(result.status).toBe('blocked');
			if (result.status === 'blocked') {
				expect(result.reason).toBe('unreadable');
				expect(result.files).toEqual(['blocked.txt']);
			}
			const forcedCalls = checkoutSpy.mock.calls.filter(([args]: [{ force?: boolean }]) => args.force);
			expect(forcedCalls.length).toBe(0);
		} finally {
			mockGit.statusMatrix = origStatusMatrix;
			mockGit.checkout = origCheckout;
			(git as any).walk = origWalk;
			(git as any).readBlob = origReadBlob;
			(git as any).resolveRef = origResolveRef;
			(git as any).currentBranch = origCurrentBranch;
		}
	});

	it('switchBranch proceeds past a worktree file that vanished mid-snapshot, restoring it as deleted', async () => {
		const statusMatrixSpy = mock(async (): Promise<StatusRow[]> => [
			['blocked.txt', 1, 2, 1] // Modified unstaged
		]);
		const checkoutSpy = mock(async () => {});
		const walkSpy = mock(async ({ map }: { map: Function }) => {
			await map('blocked.txt', [{
				type: async () => 'blob',
				oid: async () => 'staged-oid'
			}]);
		});
		const readBlobSpy = mock(async () => ({ blob: new Uint8Array(1), oid: 'same-oid' }));
		const resolveRefSpy = mock(async ({ ref }: { ref: string }) => (ref === 'HEAD' ? 'head-oid' : 'target-oid'));
		const currentBranchSpy = mock(async () => 'main');
		const addSpy = mock(async () => {});
		const origStatusMatrix = git.statusMatrix;
		const origCheckout = git.checkout;
		const origWalk = git.walk;
		const origReadBlob = git.readBlob;
		const origResolveRef = git.resolveRef;
		const origCurrentBranch = git.currentBranch;
		const origAdd = git.add;
		mockGit.statusMatrix = statusMatrixSpy;
		mockGit.checkout = checkoutSpy;
		mockGit.add = addSpy;
		(git as any).walk = walkSpy;
		(git as any).readBlob = readBlobSpy;
		(git as any).resolveRef = resolveRefSpy;
		(git as any).currentBranch = currentBranchSpy;
		let reads = 0;
		mockDirectoryHandle.getFileHandle = mock(async () => {
			reads++;
			if (reads === 1) {
				// The file vanishes between the status scan and the snapshot read.
				throw Object.assign(new Error('NotFoundError: gone'), { name: 'NotFoundError' });
			}
			return {
				kind: 'file',
				name: 'blocked.txt',
				getFile: mock(async () => ({
					text: mock(async () => 'workdir file text'),
					arrayBuffer: mock(async () => new TextEncoder().encode('workdir file text').buffer),
					size: 17,
					lastModified: Date.now()
				})),
				createWritable: mock(async () => ({
					write: mock(async () => {}),
					close: mock(async () => {})
				}))
			};
		});

		try {
			const adapter = new IsomorphicGitAdapter(rootOrigin);
			const result = await adapter.switchBranch('feature');

			expect(result.status).toBe('switched');
			const forcedCalls = checkoutSpy.mock.calls.filter(([args]: [{ force?: boolean }]) => args.force);
			expect(forcedCalls.length).toBe(1);
		} finally {
			mockGit.statusMatrix = origStatusMatrix;
			mockGit.checkout = origCheckout;
			mockGit.add = origAdd;
			(git as any).walk = origWalk;
			(git as any).readBlob = origReadBlob;
			(git as any).resolveRef = origResolveRef;
			(git as any).currentBranch = origCurrentBranch;
		}
	});

	it('switchBranch blocks with the file named when a snapshot staged-blob read fails', async () => {
		const statusMatrixSpy = mock(async (): Promise<StatusRow[]> => [
			['blocked.txt', 1, 1, 2] // Staged modification
		]);
		const checkoutSpy = mock(async () => {});
		const walkSpy = mock(async ({ map }: { map: Function }) => {
			await map('blocked.txt', [{
				type: async () => 'blob',
				oid: async () => 'staged-oid'
			}]);
		});
		const readBlobSpy = mock(async ({ oid }: { oid: string }) => {
			if (oid === 'staged-oid') throw new Error('odb corrupted');
			return { blob: new Uint8Array(1), oid: 'same-oid' };
		});
		const resolveRefSpy = mock(async ({ ref }: { ref: string }) => (ref === 'HEAD' ? 'head-oid' : 'target-oid'));
		const currentBranchSpy = mock(async () => 'main');
		const origStatusMatrix = git.statusMatrix;
		const origCheckout = git.checkout;
		const origWalk = git.walk;
		const origReadBlob = git.readBlob;
		const origResolveRef = git.resolveRef;
		const origCurrentBranch = git.currentBranch;
		mockGit.statusMatrix = statusMatrixSpy;
		mockGit.checkout = checkoutSpy;
		(git as any).walk = walkSpy;
		(git as any).readBlob = readBlobSpy;
		(git as any).resolveRef = resolveRefSpy;
		(git as any).currentBranch = currentBranchSpy;

		try {
			const adapter = new IsomorphicGitAdapter(rootOrigin);
			const result = await adapter.switchBranch('feature');

			expect(result.status).toBe('blocked');
			if (result.status === 'blocked') {
				expect(result.reason).toBe('unreadable');
				expect(result.files).toEqual(['blocked.txt']);
			}
			const forcedCalls = checkoutSpy.mock.calls.filter(([args]: [{ force?: boolean }]) => args.force);
			expect(forcedCalls.length).toBe(0);
		} finally {
			mockGit.statusMatrix = origStatusMatrix;
			mockGit.checkout = origCheckout;
			(git as any).walk = origWalk;
			(git as any).readBlob = origReadBlob;
			(git as any).resolveRef = origResolveRef;
			(git as any).currentBranch = origCurrentBranch;
		}
	});

	it('switchBranch blocks naming every unreadable file, not just the first', async () => {
		const statusMatrixSpy = mock(async (): Promise<StatusRow[]> => [
			['blocked-a.txt', 1, 2, 1], // Modified unstaged
			['blocked-b.txt', 1, 2, 1] // Modified unstaged
		]);
		const checkoutSpy = mock(async () => {});
		const walkSpy = mock(async ({ map }: { map: Function }) => {
			for (const name of ['blocked-a.txt', 'blocked-b.txt']) {
				await map(name, [{
					type: async () => 'blob',
					oid: async () => 'staged-oid'
				}]);
			}
		});
		const readBlobSpy = mock(async () => ({ blob: new Uint8Array(1), oid: 'same-oid' }));
		const resolveRefSpy = mock(async ({ ref }: { ref: string }) => (ref === 'HEAD' ? 'head-oid' : 'target-oid'));
		const currentBranchSpy = mock(async () => 'main');
		const origStatusMatrix = git.statusMatrix;
		const origCheckout = git.checkout;
		const origWalk = git.walk;
		const origReadBlob = git.readBlob;
		const origResolveRef = git.resolveRef;
		const origCurrentBranch = git.currentBranch;
		mockGit.statusMatrix = statusMatrixSpy;
		mockGit.checkout = checkoutSpy;
		(git as any).walk = walkSpy;
		(git as any).readBlob = readBlobSpy;
		(git as any).resolveRef = resolveRefSpy;
		(git as any).currentBranch = currentBranchSpy;
		mockDirectoryHandle.getFileHandle = mock(async () => {
			throw Object.assign(new Error('NotReadableError: blocked'), { name: 'NotReadableError' });
		});

		try {
			const adapter = new IsomorphicGitAdapter(rootOrigin);
			const result = await adapter.switchBranch('feature');

			expect(result.status).toBe('blocked');
			if (result.status === 'blocked') {
				expect(result.reason).toBe('unreadable');
				expect(result.files).toEqual(['blocked-a.txt', 'blocked-b.txt']);
			}
			const forcedCalls = checkoutSpy.mock.calls.filter(([args]: [{ force?: boolean }]) => args.force);
			expect(forcedCalls.length).toBe(0);
		} finally {
			mockGit.statusMatrix = origStatusMatrix;
			mockGit.checkout = origCheckout;
			(git as any).walk = origWalk;
			(git as any).readBlob = origReadBlob;
			(git as any).resolveRef = origResolveRef;
			(git as any).currentBranch = origCurrentBranch;
		}
	});
});
