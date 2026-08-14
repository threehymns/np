import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { IsomorphicGitAdapter } from './isomorphic-git';
import type { FileOrigin } from '@np/core';
import git from 'isomorphic-git';
import { browserHandleRegistry } from './storage';

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
			})
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
		(git as any).statusMatrix = statusMatrixSpy;

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
			(git as any).statusMatrix = origStatusMatrix;
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
		const walkSpy = mock(async ({ map }: { map: Function }) => {});

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
});

