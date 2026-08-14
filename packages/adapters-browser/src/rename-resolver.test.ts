import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { resolveRenamedHeadContent } from './rename-resolver';
import git from 'isomorphic-git';

describe('resolveRenamedHeadContent', () => {
	const mockFs = {
		promises: {
			readFile: mock(async () => {
				throw new Error('File not found');
			}),
			stat: mock(async () => {
				throw new Error('ENOENT');
			})
		}
	};

	let origWalk: any;
	let origReadBlob: any;
	let origTree: any;

	beforeEach(() => {
		origWalk = git.walk;
		origReadBlob = git.readBlob;
		origTree = git.TREE;
		(git as any).TREE = () => 'HEAD_TREE';
	});

	afterEach(() => {
		(git as any).walk = origWalk;
		(git as any).readBlob = origReadBlob;
		(git as any).TREE = origTree;
	});

	it('matches exact blob OID when present in HEAD tree', async () => {
		const targetOid = 'blob-oid-123';
		(git as any).walk = mock(async ({ map }: { map: Function }) => {
			await map('old/path.ts', [{
				type: async () => 'blob',
				oid: async () => targetOid
			}]);
		});
		(git as any).readBlob = mock(async ({ oid }: { oid: string }) => {
			if (oid === targetOid) {
				return { blob: new TextEncoder().encode('matched content') };
			}
			throw new Error('Blob not found');
		});

		const res = await resolveRenamedHeadContent({
			fs: mockFs,
			dir: '/repo',
			headCommit: 'head-oid',
			filepath: 'new/path.ts',
			stagedOid: targetOid
		});
		expect(res).toBe('matched content');
	});

	it('selects unique highest scoring candidate when blob OID does not match', async () => {
		(git as any).walk = mock(async ({ map }: { map: Function }) => {
			// deleted in src/: score = dir(2) + ext(1) = 3
			await map('src/old-name.ts', [{
				type: async () => 'blob',
				oid: async () => 'candidate-oid-1'
			}]);
			// deleted in other/: score = ext(1) = 1
			await map('other/unrelated.ts', [{
				type: async () => 'blob',
				oid: async () => 'candidate-oid-2'
			}]);
		});
		(git as any).readBlob = mock(async ({ oid }: { oid: string }) => {
			if (oid === 'candidate-oid-1') {
				return { blob: new TextEncoder().encode('old name content') };
			}
			throw new Error('Blob not found');
		});

		const res = await resolveRenamedHeadContent({
			fs: mockFs,
			dir: '/repo',
			headCommit: 'head-oid',
			filepath: 'src/new-name.ts',
			workdirContent: 'new modified content'
		});
		expect(res).toBe('old name content');
	});

	it('returns null when top candidate has zero score', async () => {
		(git as any).walk = mock(async ({ map }: { map: Function }) => {
			// deleted in docs/: different dir, different basename, different ext -> score 0
			await map('docs/readme.md', [{
				type: async () => 'blob',
				oid: async () => 'candidate-zero-score'
			}]);
		});
		(git as any).readBlob = mock(async () => {
			return { blob: new TextEncoder().encode('readme content') };
		});

		const res = await resolveRenamedHeadContent({
			fs: mockFs,
			dir: '/repo',
			headCommit: 'head-oid',
			filepath: 'src/component.tsx',
			workdirContent: 'const x = 1;'
		});
		expect(res).toBeNull();
	});

	it('returns null when candidates are tied for highest score (ambiguous)', async () => {
		(git as any).walk = mock(async ({ map }: { map: Function }) => {
			// Two files in src/ with .ts extension deleted -> both score 3
			await map('src/deleted1.ts', [{
				type: async () => 'blob',
				oid: async () => 'candidate-oid-1'
			}]);
			await map('src/deleted2.ts', [{
				type: async () => 'blob',
				oid: async () => 'candidate-oid-2'
			}]);
		});
		(git as any).readBlob = mock(async () => {
			return { blob: new TextEncoder().encode('some content') };
		});

		const res = await resolveRenamedHeadContent({
			fs: mockFs,
			dir: '/repo',
			headCommit: 'head-oid',
			filepath: 'src/new-target.ts',
			workdirContent: 'const target = true;'
		});
		expect(res).toBeNull();
	});
});
