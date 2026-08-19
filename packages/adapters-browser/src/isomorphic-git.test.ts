import { describe, it, expect, beforeEach, mock, type Mock } from 'bun:test';
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
					})),
					createWritable: mock(async () => ({
						write: mock(async () => {}),
						close: mock(async () => {})
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

	interface SwitchBranchMocks {
		statusMatrix: StatusRow[];
		readBlob?: (args: { oid: string }) => Promise<{ blob: Uint8Array; oid?: string }>;
		getFileHandle?: (name: string, opts?: { create?: boolean }) => Promise<unknown>;
	}

	async function withSwitchBranchMocks<T>(
		mocks: SwitchBranchMocks,
		fn: (spies: { checkout: Mock<() => Promise<void>>; add: Mock<() => Promise<void>> }) => Promise<T>
	): Promise<T> {
		const checkout = mock(async () => {});
		const add = mock(async () => {});
		const readBlob = mocks.readBlob ?? mock(async () => ({ blob: new Uint8Array(1), oid: 'same-oid' }));
		const resolveRef = mock(async ({ ref }: { ref: string }) => (ref === 'HEAD' ? 'head-oid' : 'target-oid'));
		const currentBranch = mock(async () => 'main');
		const walk = mock(async ({ map }: { map: (filepath: string, entries: unknown[]) => Promise<void> }) => {
			for (const [filepath] of mocks.statusMatrix) {
				await map(filepath as string, [{
					type: async () => 'blob',
					oid: async () => 'staged-oid'
				}]);
			}
		});
		const originals = {
			statusMatrix: mockGit.statusMatrix,
			checkout: mockGit.checkout,
			add: mockGit.add,
			readBlob: (git as any).readBlob,
			resolveRef: (git as any).resolveRef,
			currentBranch: (git as any).currentBranch,
			walk: (git as any).walk
		};
		const originalGetFileHandle = mockDirectoryHandle.getFileHandle;

		mockGit.statusMatrix = mock(async (): Promise<StatusRow[]> => mocks.statusMatrix);
		mockGit.checkout = checkout;
		mockGit.add = add;
		(git as any).readBlob = readBlob;
		(git as any).resolveRef = resolveRef;
		(git as any).currentBranch = currentBranch;
		(git as any).walk = walk;
		if (mocks.getFileHandle) {
			mockDirectoryHandle.getFileHandle = mock(mocks.getFileHandle);
		}

		try {
			return await fn({ checkout, add });
		} finally {
			mockGit.statusMatrix = originals.statusMatrix;
			mockGit.checkout = originals.checkout;
			mockGit.add = originals.add;
			(git as any).readBlob = originals.readBlob;
			(git as any).resolveRef = originals.resolveRef;
			(git as any).currentBranch = originals.currentBranch;
			(git as any).walk = originals.walk;
			mockDirectoryHandle.getFileHandle = originalGetFileHandle;
		}
	}

	function forcedCheckouts(checkout: Mock<() => Promise<void>>) {
		return checkout.mock.calls.filter(([args]: [{ force?: boolean }]) => args.force);
	}

	function fileError(name: string, message: string): Error {
		return Object.assign(new Error(message), { name });
	}

	it('switchBranch blocks with the file named when a snapshot worktree read fails', async () => {
		await withSwitchBranchMocks({
			statusMatrix: [['blocked.txt', 1, 2, 1]], // Modified unstaged
			getFileHandle: async () => { throw fileError('NotReadableError', 'NotReadableError: blocked'); }
		}, async ({ checkout }) => {
			const adapter = new IsomorphicGitAdapter(rootOrigin);
			const result = await adapter.switchBranch('feature');

			expect(result).toMatchObject({ status: 'blocked', reason: 'unreadable', files: ['blocked.txt'] });
			expect(forcedCheckouts(checkout).length).toBe(0);
		});
	});

	it('switchBranch proceeds past a worktree file that vanished mid-snapshot, restoring it as deleted', async () => {
		await withSwitchBranchMocks({
			statusMatrix: [['blocked.txt', 1, 2, 1]], // Modified unstaged
			getFileHandle: async (_name: string, opts?: { create?: boolean }) => {
				// Reads never see the file: it vanished between the status scan and the
				// snapshot read and stays gone through the pre-checkout re-read. Writes
				// (create: true) still work so the checkout and restore can proceed.
				if (opts?.create) {
					return {
						kind: 'file',
						name: 'blocked.txt',
						createWritable: mock(async () => ({
							write: mock(async () => {}),
							close: mock(async () => {})
						}))
					};
				}
				throw fileError('NotFoundError', 'NotFoundError: gone');
			}
		}, async ({ checkout }) => {
			const adapter = new IsomorphicGitAdapter(rootOrigin);
			const result = await adapter.switchBranch('feature');

			expect(result.status).toBe('switched');
			expect(forcedCheckouts(checkout).length).toBe(1);
		});
	});

	it('switchBranch preserves a dirty file recreated after the snapshot ENOENT read', async () => {
		let reads = 0;
		const state = { content: new Uint8Array(0) };
		await withSwitchBranchMocks({
			statusMatrix: [['recreated.txt', 1, 2, 1]], // Modified unstaged
			getFileHandle: async () => {
				reads++;
				if (reads === 1) {
					// The file vanishes between the status scan and the snapshot read.
					throw fileError('NotFoundError', 'NotFoundError: gone');
				}
				if (reads === 2) {
					// A concurrent filesystem operation recreates the dirty file
					// before the checkout begins.
					state.content = new TextEncoder().encode('recreated content\n');
				}
				return {
					kind: 'file',
					name: 'recreated.txt',
					getFile: mock(async () => ({
						text: mock(async () => new TextDecoder().decode(state.content)),
						arrayBuffer: mock(async () => state.content.buffer),
						size: state.content.length,
						lastModified: Date.now()
					})),
					createWritable: mock(async () => ({
						write: mock(async (data: Uint8Array | string) => {
							state.content = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
						}),
						close: mock(async () => {})
					}))
				};
			}
		}, async ({ checkout }) => {
			// An unlink at the end of restoration (the pre-fix behavior) would wipe
			// the recreated file; make it observable by clearing the file content.
			mockDirectoryHandle.removeEntry = mock(async () => {
				state.content = new Uint8Array(0);
			});

			const adapter = new IsomorphicGitAdapter(rootOrigin);
			const result = await adapter.switchBranch('feature');

			expect(result.status).toBe('switched');
			expect(forcedCheckouts(checkout).length).toBe(1);
			// The recreated local content survives the switch: restoration wrote it
			// back instead of unlinking the path.
			expect(new TextDecoder().decode(state.content)).toBe('recreated content\n');
		});
	});

	it('switchBranch keeps a dirty file recreated after the pre-checkout re-read', async () => {
		let reads = 0;
		const state = { content: new Uint8Array(0) };
		await withSwitchBranchMocks({
			statusMatrix: [['recreated.txt', 1, 2, 1]], // Modified unstaged
			getFileHandle: async (name: string, opts?: { create?: boolean }) => {
				if (opts?.create) {
					return {
						kind: 'file',
						name,
						createWritable: mock(async () => ({
							write: mock(async () => {}),
							close: mock(async () => {})
						}))
					};
				}
				reads++;
				if (reads <= 2) {
					// Gone at the snapshot read and still gone at the pre-checkout
					// re-read: the switch records it as deleted.
					throw fileError('NotFoundError', 'NotFoundError: gone');
				}
				// A concurrent operation recreates the file between the pre-checkout
				// re-read and restoration — the window only the restore-time check
				// can see.
				state.content = new TextEncoder().encode('recreated after re-read\n');
				return {
					kind: 'file',
					name,
					getFile: mock(async () => ({
						text: mock(async () => new TextDecoder().decode(state.content)),
						arrayBuffer: mock(async () => state.content.buffer),
						size: state.content.length,
						lastModified: Date.now()
					})),
					createWritable: mock(async () => ({
						write: mock(async () => {}),
						close: mock(async () => {})
					}))
				};
			}
		}, async ({ checkout }) => {
			// An unlink at the end of restoration would wipe the recreated file;
			// make it observable by clearing the file content.
			mockDirectoryHandle.removeEntry = mock(async () => {
				state.content = new Uint8Array(0);
			});

			const adapter = new IsomorphicGitAdapter(rootOrigin);
			const result = await adapter.switchBranch('feature');

			expect(result.status).toBe('switched');
			expect(forcedCheckouts(checkout).length).toBe(1);
			// The file recreated after the re-read survives: the final unlink only
			// runs when the path is confirmed absent.
			expect(new TextDecoder().decode(state.content)).toBe('recreated after re-read\n');
		});
	});

	it('switchBranch preserves a tracked file recreated after the status scan', async () => {
		const state = { content: new Uint8Array(0) };
		await withSwitchBranchMocks({
			statusMatrix: [['deleted.txt', 1, 0, 0]], // Tracked, deleted unstaged
			getFileHandle: async (name: string, opts?: { create?: boolean }) => {
				if (opts?.create) {
					return {
						kind: 'file',
						name,
						createWritable: mock(async () => ({
							write: mock(async () => {}),
							close: mock(async () => {})
						}))
					};
				}
				// The scan saw the deletion, but a concurrent operation recreates
				// the file before the checkout begins.
				state.content = new TextEncoder().encode('recreated content\n');
				return {
					kind: 'file',
					name,
					getFile: mock(async () => ({
						text: mock(async () => new TextDecoder().decode(state.content)),
						arrayBuffer: mock(async () => state.content.buffer),
						size: state.content.length,
						lastModified: Date.now()
					})),
					createWritable: mock(async () => ({
						write: mock(async () => {}),
						close: mock(async () => {})
					}))
				};
			}
		}, async ({ checkout }) => {
			// The file absent from the workdir is also absent from the index, so
			// the staged-blob walk yields no entry for it (the shared walk mock
			// yields one for every row).
			(git as any).walk = mock(async () => {});

			mockDirectoryHandle.removeEntry = mock(async () => {
				state.content = new Uint8Array(0);
			});

			const adapter = new IsomorphicGitAdapter(rootOrigin);
			const result = await adapter.switchBranch('feature');

			expect(result.status).toBe('switched');
			expect(forcedCheckouts(checkout).length).toBe(1);
			// The recreated content is carried across the switch instead of the
			// recorded deletion being applied.
			expect(new TextDecoder().decode(state.content)).toBe('recreated content\n');
		});
	});

	it('switchBranch restores staged content and unlinks worktree file when workdir was deleted', async () => {
		const stagedBytes = new TextEncoder().encode('staged blob text\n');
		let worktreeUnlinked = false;
		let addedFilePath: string | null = null;

		await withSwitchBranchMocks({
			statusMatrix: [['staged-deleted.txt', 1, 0, 2]], // Staged modification, worktree deleted
			readBlob: async () => ({ blob: stagedBytes, oid: 'staged-oid' })
		}, async ({ checkout }) => {
			(git as any).add = mock(async (opts: { filepath: string }) => {
				addedFilePath = opts.filepath;
			});
			mockDirectoryHandle.removeEntry = mock(async (name: string) => {
				if (name === 'staged-deleted.txt') {
					worktreeUnlinked = true;
				}
			});

			const adapter = new IsomorphicGitAdapter(rootOrigin);
			const result = await adapter.switchBranch('feature');

			expect(result.status).toBe('switched');
			expect(forcedCheckouts(checkout).length).toBe(1);
			expect(addedFilePath).toBe('staged-deleted.txt');
			expect(worktreeUnlinked).toBe(true);
		});
	});

	it('switchBranch blocks with the file named when a snapshot staged-blob read fails', async () => {
		await withSwitchBranchMocks({
			statusMatrix: [['blocked.txt', 1, 1, 2]], // Staged modification
			readBlob: async ({ oid }: { oid: string }) => {
				if (oid === 'staged-oid') throw new Error('odb corrupted');
				return { blob: new Uint8Array(1), oid: 'same-oid' };
			}
		}, async ({ checkout }) => {
			const adapter = new IsomorphicGitAdapter(rootOrigin);
			const result = await adapter.switchBranch('feature');

			expect(result).toMatchObject({ status: 'blocked', reason: 'unreadable', files: ['blocked.txt'] });
			expect(forcedCheckouts(checkout).length).toBe(0);
		});
	});

	it('switchBranch blocks naming every unreadable file, not just the first', async () => {
		await withSwitchBranchMocks({
			statusMatrix: [
				['blocked-a.txt', 1, 2, 1], // Modified unstaged
				['blocked-b.txt', 1, 2, 1] // Modified unstaged
			],
			getFileHandle: async () => { throw fileError('NotReadableError', 'NotReadableError: blocked'); }
		}, async ({ checkout }) => {
			const adapter = new IsomorphicGitAdapter(rootOrigin);
			const result = await adapter.switchBranch('feature');

			expect(result).toMatchObject({ status: 'blocked', reason: 'unreadable', files: ['blocked-a.txt', 'blocked-b.txt'] });
			expect(forcedCheckouts(checkout).length).toBe(0);
		});
	});
});
