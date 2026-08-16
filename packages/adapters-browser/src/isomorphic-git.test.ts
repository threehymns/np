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
				throw new Error('Directory not found');
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

		const statusMatrixSpy = mock(async () => [
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

		const statusMatrixSpy = mock(async () => [
			['untracked.txt', 0, 1, 0] // Untracked (present in workdir only)
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

	it('loads on-demand diff content via getFileDiff for staged changes', async () => {
		const readBlobSpy = mock(async ({ oid }: { oid: string }) => {
			if (oid === 'head-commit-oid') {
				return { blob: new TextEncoder().encode('head text') };
			}
			if (oid === 'staged-blob-oid') {
				return { blob: new TextEncoder().encode('staged text') };
			}
			return { blob: new Uint8Array() };
		});
		const resolveRefSpy = mock(async () => 'head-commit-oid');
		const walkSpy = mock(async ({ map }: { map: Function }) => {
			await map('staged.txt', [{
				type: async () => 'blob',
				oid: async () => 'staged-blob-oid'
			}]);
		});

		const origReadBlob = git.readBlob;
		const origResolveRef = git.resolveRef;
		const origWalk = git.walk;
		(git as any).readBlob = readBlobSpy;
		(git as any).resolveRef = resolveRefSpy;
		(git as any).walk = walkSpy;

		try {
			const adapter = new IsomorphicGitAdapter(rootOrigin);
			const diff = await adapter.getFileDiff('staged.txt', { staged: true });

			expect(diff.originalContent).toBe('head text');
			expect(diff.modifiedContent).toBe('staged text');
			expect(diff.stagedContent).toBe('staged text');
			expect(readBlobSpy).toHaveBeenCalled();
		} finally {
			(git as any).readBlob = origReadBlob;
			(git as any).resolveRef = origResolveRef;
			(git as any).walk = origWalk;
		}
	});

	it('loads on-demand diff content via getFileDiff for unstaged changes', async () => {
		const readBlobSpy = mock(async ({ oid }: { oid: string }) => {
			if (oid === 'staged-blob-oid') {
				return { blob: new TextEncoder().encode('staged text') };
			}
			return { blob: new Uint8Array() };
		});
		const resolveRefSpy = mock(async () => 'head-commit-oid');
		const walkSpy = mock(async ({ map }: { map: Function }) => {
			await map('unstaged.txt', [{
				type: async () => 'blob',
				oid: async () => 'staged-blob-oid'
			}]);
		});

		const origReadBlob = git.readBlob;
		const origResolveRef = git.resolveRef;
		const origWalk = git.walk;
		(git as any).readBlob = readBlobSpy;
		(git as any).resolveRef = resolveRefSpy;
		(git as any).walk = walkSpy;

		try {
			const adapter = new IsomorphicGitAdapter(rootOrigin);
			const diff = await adapter.getFileDiff('unstaged.txt', { staged: false });

			expect(diff.originalContent).toBe('staged text');
			expect(diff.modifiedContent).toBe('workdir file text');
			expect(diff.stagedContent).toBe('staged text');
		} finally {
			(git as any).readBlob = origReadBlob;
			(git as any).resolveRef = origResolveRef;
			(git as any).walk = origWalk;
		}
	});

	it('loads on-demand diff content via getFileDiff for untracked files', async () => {
		const resolveRefSpy = mock(async () => { throw new Error('Not found'); });
		const walkSpy = mock(async ({ map }: { map: Function }) => {});

		const origResolveRef = git.resolveRef;
		const origWalk = git.walk;
		(git as any).resolveRef = resolveRefSpy;
		(git as any).walk = walkSpy;

		try {
			const adapter = new IsomorphicGitAdapter(rootOrigin);
			const diff = await adapter.getFileDiff('untracked.txt');

			expect(diff.originalContent).toBe('');
			expect(diff.modifiedContent).toBe('workdir file text');
		} finally {
			(git as any).resolveRef = origResolveRef;
			(git as any).walk = origWalk;
		}
	});

	it('loads on-demand diff content via getFileDiff for deleted files without disk reads', async () => {
		const readBlobSpy = mock(async ({ oid }: { oid: string }) => {
			if (oid === 'head-commit-oid') {
				return { blob: new TextEncoder().encode('deleted head text') };
			}
			return { blob: new Uint8Array() };
		});
		const resolveRefSpy = mock(async () => 'head-commit-oid');
		const walkSpy = mock(async ({ map }: { map: Function }) => {
			await map('deleted.txt', [{
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

		// Mock file not found in workdir
		mockDirectoryHandle.getFileHandle = mock(async () => {
			throw new Error('NotFoundError: file not found');
		});

		try {
			const adapter = new IsomorphicGitAdapter(rootOrigin);
			const diff = await adapter.getFileDiff('deleted.txt', { staged: false });

			expect(diff.originalContent).toBe('deleted head text');
			expect(diff.modifiedContent).toBe('');
		} finally {
			(git as any).readBlob = origReadBlob;
			(git as any).resolveRef = origResolveRef;
			(git as any).walk = origWalk;
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

	it('resolves original content for renamed files via HEAD tree oid matching', async () => {
		const oldBlobOid = 'renamed-blob-oid-1234';
		const oldContent = 'export function hello() { return "world"; }';
		const newContent = 'export function hello() { return "world"; }';

		const readBlobSpy = mock(async ({ filepath, oid }: { filepath?: string; oid?: string }) => {
			if (filepath === 'new-name.ts') {
				throw new Error('NotFoundError: Does not exist in HEAD');
			}
			if (oid === oldBlobOid) {
				return { blob: new TextEncoder().encode(oldContent) };
			}
			return { blob: new Uint8Array() };
		});

		const resolveRefSpy = mock(async () => 'head-commit-oid');

		const walkSpy = mock(async ({ trees, map }: { trees: any[]; map: Function }) => {
			// If STAGE() walker
			if (trees && trees.length === 1 && trees[0] === 'STAGE_WALKER') {
				await map('new-name.ts', [{
					type: async () => 'blob',
					oid: async () => oldBlobOid
				}]);
			}
			// If TREE() walker (HEAD)
			if (trees && trees.length === 1 && trees[0] === 'HEAD_TREE_WALKER') {
				await map('old-name.ts', [{
					type: async () => 'blob',
					oid: async () => oldBlobOid
				}]);
			}
		});

		const origReadBlob = git.readBlob;
		const origResolveRef = git.resolveRef;
		const origWalk = git.walk;
		const origStage = git.STAGE;
		const origTree = git.TREE;

		(git as any).readBlob = readBlobSpy;
		(git as any).resolveRef = resolveRefSpy;
		(git as any).walk = walkSpy;
		(git as any).STAGE = () => 'STAGE_WALKER';
		(git as any).TREE = () => 'HEAD_TREE_WALKER';

		try {
			const adapter = new IsomorphicGitAdapter(rootOrigin);
			const diff = await adapter.getFileDiff('new-name.ts', { staged: true });

			expect(diff.originalContent).toBe(oldContent);
			expect(diff.modifiedContent).toBe(oldContent);
			expect(diff.stagedContent).toBe(oldContent);
		} finally {
			(git as any).readBlob = origReadBlob;
			(git as any).resolveRef = origResolveRef;
			(git as any).walk = origWalk;
			(git as any).STAGE = origStage;
			(git as any).TREE = origTree;
		}
	});

	it('resolves original content for unstaged renamed files via workdir hash and HEAD tree oid matching', async () => {
		const content = 'export const foo = "bar";';
		const contentOid = 'foo-bar-oid-5678';

		const readBlobSpy = mock(async ({ filepath, oid }: { filepath?: string; oid?: string }) => {
			if (filepath === 'renamed-workdir.ts') {
				throw new Error('NotFoundError: Does not exist in HEAD');
			}
			if (oid === contentOid) {
				return { blob: new TextEncoder().encode(content) };
			}
			return { blob: new Uint8Array() };
		});

		const resolveRefSpy = mock(async () => 'head-commit-oid');
		const hashBlobSpy = mock(async () => ({ oid: contentOid }));

		const walkSpy = mock(async ({ trees, map }: { trees: any[]; map: Function }) => {
			// STAGE() returns nothing for unstaged rename
			if (trees && trees.length === 1 && trees[0] === 'STAGE_WALKER') {
				return;
			}
			// TREE() walker (HEAD) returns old path with matching oid
			if (trees && trees.length === 1 && trees[0] === 'HEAD_TREE_WALKER') {
				await map('original-file.ts', [{
					type: async () => 'blob',
					oid: async () => contentOid
				}]);
			}
		});

		const origReadBlob = git.readBlob;
		const origResolveRef = git.resolveRef;
		const origHashBlob = git.hashBlob;
		const origWalk = git.walk;
		const origStage = git.STAGE;
		const origTree = git.TREE;

		(git as any).readBlob = readBlobSpy;
		(git as any).resolveRef = resolveRefSpy;
		(git as any).hashBlob = hashBlobSpy;
		(git as any).walk = walkSpy;
		(git as any).STAGE = () => 'STAGE_WALKER';
		(git as any).TREE = () => 'HEAD_TREE_WALKER';

		mockDirectoryHandle.getFileHandle = mock(async () => ({
			kind: 'file',
			name: 'renamed-workdir.ts',
			getFile: mock(async () => ({
				text: mock(async () => content),
				arrayBuffer: mock(async () => new TextEncoder().encode(content).buffer),
				size: content.length,
				lastModified: Date.now()
			}))
		}));

		try {
			const adapter = new IsomorphicGitAdapter(rootOrigin);
			const diff = await adapter.getFileDiff('renamed-workdir.ts', { staged: false });

			expect(diff.originalContent).toBe(content);
			expect(diff.modifiedContent).toBe(content);
		} finally {
			(git as any).readBlob = origReadBlob;
			(git as any).resolveRef = origResolveRef;
			(git as any).hashBlob = origHashBlob;
			(git as any).walk = origWalk;
			(git as any).STAGE = origStage;
			(git as any).TREE = origTree;
		}
	});

	it('loads on-demand diff content via getFileDiff for staged deleted files', async () => {
		const readBlobSpy = mock(async ({ oid }: { oid: string }) => {
			if (oid === 'head-commit-oid') {
				return { blob: new TextEncoder().encode('deleted head text') };
			}
			return { blob: new Uint8Array() };
		});
		const resolveRefSpy = mock(async () => 'head-commit-oid');
		const walkSpy = mock(async ({ map }: { map: Function }) => {});

		const origReadBlob = git.readBlob;
		const origResolveRef = git.resolveRef;
		const origWalk = git.walk;
		(git as any).readBlob = readBlobSpy;
		(git as any).resolveRef = resolveRefSpy;
		(git as any).walk = walkSpy;

		try {
			const adapter = new IsomorphicGitAdapter(rootOrigin);
			const diff = await adapter.getFileDiff('deleted.txt', { staged: true });

			expect(diff.originalContent).toBe('deleted head text');
			expect(diff.modifiedContent).toBe('');
			expect(diff.stagedContent).toBe('');
		} finally {
			(git as any).readBlob = origReadBlob;
			(git as any).resolveRef = origResolveRef;
			(git as any).walk = origWalk;
		}
	});

	it('loads on-demand diff content via getFileDiff for staged deleted files recreated in worktree', async () => {
		const readBlobSpy = mock(async ({ oid }: { oid: string }) => {
			if (oid === 'head-commit-oid') {
				return { blob: new TextEncoder().encode('deleted head text') };
			}
			return { blob: new Uint8Array() };
		});
		const resolveRefSpy = mock(async () => 'head-commit-oid');
		const walkSpy = mock(async ({ map }: { map: Function }) => {});

		const origReadBlob = git.readBlob;
		const origResolveRef = git.resolveRef;
		const origWalk = git.walk;
		(git as any).readBlob = readBlobSpy;
		(git as any).resolveRef = resolveRefSpy;
		(git as any).walk = walkSpy;

		mockDirectoryHandle.getFileHandle = mock(async () => ({
			kind: 'file',
			name: 'deleted.txt',
			getFile: mock(async () => ({
				text: mock(async () => 'recreated in worktree'),
				arrayBuffer: mock(async () => new TextEncoder().encode('recreated in worktree').buffer),
				size: 'recreated in worktree'.length,
				lastModified: Date.now()
			}))
		}));

		try {
			const adapter = new IsomorphicGitAdapter(rootOrigin);
			const diff = await adapter.getFileDiff('deleted.txt', { staged: false });

			expect(diff.originalContent).toBe('');
			expect(diff.modifiedContent).toBe('recreated in worktree');
			expect(diff.stagedContent).toBe('');
		} finally {
			(git as any).readBlob = origReadBlob;
			(git as any).resolveRef = origResolveRef;
			(git as any).walk = origWalk;
		}
	});

	it('resolves original content for renamed and modified files via deleted candidate matching', async () => {
		const oldContent = 'export function oldFunc() { return 1; }';
		const newContent = 'export function newFunc() { return 2; }';
		const oldOid = 'old-blob-oid-9999';
		const newOid = 'new-blob-oid-8888';

		const readBlobSpy = mock(async ({ filepath, oid }: { filepath?: string; oid?: string }) => {
			if (filepath === 'renamed-modified.ts') {
				throw new Error('NotFoundError: Does not exist in HEAD');
			}
			if (oid === oldOid) {
				return { blob: new TextEncoder().encode(oldContent) };
			}
			return { blob: new Uint8Array() };
		});

		const resolveRefSpy = mock(async () => 'head-commit-oid');
		const hashBlobSpy = mock(async () => ({ oid: newOid }));

		const walkSpy = mock(async ({ trees, map }: { trees: any[]; map: Function }) => {
			if (trees && trees.length === 1 && trees[0] === 'STAGE_WALKER') {
				return;
			}
			if (trees && trees.length === 1 && trees[0] === 'HEAD_TREE_WALKER') {
				await map('old-file.ts', [{
					type: async () => 'blob',
					oid: async () => oldOid
				}]);
			}
		});

		const origReadBlob = git.readBlob;
		const origResolveRef = git.resolveRef;
		const origHashBlob = git.hashBlob;
		const origWalk = git.walk;
		const origStage = git.STAGE;
		const origTree = git.TREE;

		(git as any).readBlob = readBlobSpy;
		(git as any).resolveRef = resolveRefSpy;
		(git as any).hashBlob = hashBlobSpy;
		(git as any).walk = walkSpy;
		(git as any).STAGE = () => 'STAGE_WALKER';
		(git as any).TREE = () => 'HEAD_TREE_WALKER';

		mockDirectoryHandle.getFileHandle = mock(async (name: string) => {
			if (name === 'old-file.ts') {
				throw new Error('NotFoundError: file not found');
			}
			return {
				kind: 'file',
				name: 'renamed-modified.ts',
				getFile: mock(async () => ({
					text: mock(async () => newContent),
					arrayBuffer: mock(async () => new TextEncoder().encode(newContent).buffer),
					size: newContent.length,
					lastModified: Date.now()
				}))
			};
		});

		try {
			const adapter = new IsomorphicGitAdapter(rootOrigin);
			const diff = await adapter.getFileDiff('renamed-modified.ts', { staged: false });

			expect(diff.originalContent).toBe(oldContent);
			expect(diff.modifiedContent).toBe(newContent);
		} finally {
			(git as any).readBlob = origReadBlob;
			(git as any).resolveRef = origResolveRef;
			(git as any).hashBlob = origHashBlob;
			(git as any).walk = origWalk;
			(git as any).STAGE = origStage;
			(git as any).TREE = origTree;
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
		const removeSpy = mock(async (_args: { filepath: string }) => {});
		const origStatusMatrix = git.statusMatrix;
		const origAdd = git.add;
		const origRemove = git.remove;
		mockGit.statusMatrix = statusMatrixSpy;
		mockGit.add = addSpy;
		mockGit.remove = removeSpy;

		try {
			const adapter = new IsomorphicGitAdapter(rootOrigin);
			await adapter.stageAll();

			expect(statusMatrixSpy).toHaveBeenCalledTimes(1);
			expect(addSpy).toHaveBeenCalledTimes(2);
			expect(addSpy.mock.calls.map(([args]: [{ filepath: string }]) => args.filepath).sort()).toEqual(['mod.txt', 'new.txt']);
			expect(removeSpy).toHaveBeenCalledTimes(1);
			expect(removeSpy.mock.calls[0][0].filepath).toBe('del.txt');
		} finally {
			mockGit.statusMatrix = origStatusMatrix;
			mockGit.add = origAdd;
			mockGit.remove = origRemove;
		}
	});

	it('unstageAll does a single statusMatrix pass and resets only staged entries', async () => {
		const statusMatrixSpy = mock(async (): Promise<StatusRow[]> => [
			['staged.txt', 1, 2, 2], // Staged modification
			['both.txt', 1, 2, 2], // Staged + unstaged
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
		const removeSpy = mock(async (_args: { filepath: string }) => {});
		const origStatusMatrix = git.statusMatrix;
		const origCheckout = git.checkout;
		const origRemove = git.remove;
		mockGit.statusMatrix = statusMatrixSpy;
		mockGit.checkout = checkoutSpy;
		mockGit.remove = removeSpy;

		try {
			const adapter = new IsomorphicGitAdapter(rootOrigin);
			await adapter.discardAll();

			expect(statusMatrixSpy).toHaveBeenCalledTimes(1);
			expect(checkoutSpy).toHaveBeenCalledTimes(1);
			expect(checkoutSpy.mock.calls[0][0].filepaths).toEqual(['mod.txt']);
			expect(checkoutSpy.mock.calls[0][0].force).toBe(true);
			expect(removeSpy).toHaveBeenCalledTimes(1);
			expect(removeSpy.mock.calls[0][0].filepath).toBe('new.txt');
		} finally {
			mockGit.statusMatrix = origStatusMatrix;
			mockGit.checkout = origCheckout;
			mockGit.remove = origRemove;
		}
	});

	it('detect returns true when the filesystem shim lists a .git directory', async () => {
		const adapter = new IsomorphicGitAdapter(rootOrigin);
		const result = await adapter.detect(rootOrigin.path);
		expect(result).toBe(true);
	});

	it('detect returns false when no .git directory is present', async () => {
		const adapter = new IsomorphicGitAdapter(rootOrigin);
		mockDirectoryHandle.keys = async function* () { yield 'README.md'; };
		const result = await adapter.detect(rootOrigin.path);
		expect(result).toBe(false);
	});

	it('detect returns false when permission is not granted', async () => {
		const adapter = new IsomorphicGitAdapter(rootOrigin);
		mockDirectoryHandle.queryPermission = mock(async () => 'prompt');
		const result = await adapter.detect(rootOrigin.path);
		expect(result).toBe(false);
	});
});


