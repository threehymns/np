import '../../../../tests/contract/rune-setup';
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { ElectronSessionPersistence } from './ElectronSessionPersistence';
import type { SerializedDocument, FileOrigin } from '@np/core';

describe('ElectronSessionPersistence', () => {
	let mockPersistenceSave: ReturnType<typeof mock>;
	let mockPersistenceLoad: ReturnType<typeof mock>;
	let mockPersistenceLoadAll: ReturnType<typeof mock>;
	let persistence: ElectronSessionPersistence;

	beforeEach(() => {
		mockPersistenceSave = mock(async (_key: string, _value: any) => {});
		mockPersistenceLoad = mock(async (_key: string) => null);
		mockPersistenceLoadAll = mock(async () => ({}));

		(globalThis as any).window = {
			electronAPI: {
				persistenceSave: mockPersistenceSave,
				persistenceLoad: mockPersistenceLoad,
				persistenceLoadAll: mockPersistenceLoadAll
			}
		};

		persistence = new ElectronSessionPersistence();
	});

	afterEach(() => {
		delete (globalThis as any).window;
	});

	describe('openFiles', () => {
		it('saves and loads open files for the global workspace (no folderUri)', async () => {
			const files: SerializedDocument[] = [
				{
					id: 'doc-1',
					origin: { scheme: 'file', path: '/notes/doc1.md', name: 'doc1.md' },
					draftContent: 'draft content 1'
				},
				{
					id: 'doc-2',
					origin: null,
					untitledTitle: 'Untitled 1',
					draftContent: 'untitled draft'
				}
			];

			await persistence.saveOpenFiles(files);
			expect(mockPersistenceSave).toHaveBeenCalledWith('openFiles', files);

			mockPersistenceLoad.mockResolvedValueOnce(files);
			const loaded = await persistence.loadOpenFiles();
			expect(mockPersistenceLoad).toHaveBeenCalledWith('openFiles');
			expect(loaded).toEqual(files);
		});

		it('saves and loads open files for a specific folderUri', async () => {
			const folderUri = 'file:///workspace/my-project';
			const files: SerializedDocument[] = [
				{
					id: 'diff-tab-1',
					origin: null,
					virtualTabType: 'diff',
					diffFilepath: 'src/main.ts',
					diffStaged: true
				}
			];

			await persistence.saveOpenFiles(files, folderUri);
			expect(mockPersistenceSave).toHaveBeenCalledWith(`openFiles:${folderUri}`, files);

			mockPersistenceLoad.mockResolvedValueOnce(files);
			const loaded = await persistence.loadOpenFiles(folderUri);
			expect(mockPersistenceLoad).toHaveBeenCalledWith(`openFiles:${folderUri}`);
			expect(loaded).toEqual(files);
		});

		it('returns an empty array when loadOpenFiles finds nothing', async () => {
			mockPersistenceLoad.mockResolvedValueOnce(null);
			const loaded = await persistence.loadOpenFiles();
			expect(loaded).toEqual([]);
		});
	});

	describe('rootFolder', () => {
		it('saves and loads root folder origin', async () => {
			const origin: FileOrigin = { scheme: 'file', path: '/workspace/project', name: 'project' };

			await persistence.saveRootFolder(origin);
			expect(mockPersistenceSave).toHaveBeenCalledWith('rootFolder', origin);

			mockPersistenceLoad.mockResolvedValueOnce(origin);
			const loaded = await persistence.loadRootFolder();
			expect(mockPersistenceLoad).toHaveBeenCalledWith('rootFolder');
			expect(loaded).toEqual(origin);
		});

		it('saves null root folder when cleared', async () => {
			await persistence.saveRootFolder(null);
			expect(mockPersistenceSave).toHaveBeenCalledWith('rootFolder', null);

			mockPersistenceLoad.mockResolvedValueOnce(null);
			const loaded = await persistence.loadRootFolder();
			expect(loaded).toBeNull();
		});
	});

	describe('recentFolders', () => {
		it('saves and loads recent folders list', async () => {
			const recents: FileOrigin[] = [
				{ scheme: 'file', path: '/workspace/project-a', name: 'project-a' },
				{ scheme: 'file', path: '/workspace/project-b', name: 'project-b' }
			];

			await persistence.saveRecentFolders(recents);
			expect(mockPersistenceSave).toHaveBeenCalledWith('recentFolders', recents);

			mockPersistenceLoad.mockResolvedValueOnce(recents);
			const loaded = await persistence.loadRecentFolders();
			expect(mockPersistenceLoad).toHaveBeenCalledWith('recentFolders');
			expect(loaded).toEqual(recents);
		});

		it('returns an empty array when recentFolders is null/empty', async () => {
			mockPersistenceLoad.mockResolvedValueOnce(null);
			const loaded = await persistence.loadRecentFolders();
			expect(loaded).toEqual([]);
		});
	});

	describe('expandedPaths', () => {
		it('saves and loads expanded paths for global and scoped workspaces', async () => {
			const globalPaths = ['/a', '/a/b'];
			await persistence.saveExpandedPaths(globalPaths);
			expect(mockPersistenceSave).toHaveBeenCalledWith('expandedPaths', globalPaths);

			mockPersistenceLoad.mockResolvedValueOnce(globalPaths);
			const loadedGlobal = await persistence.loadExpandedPaths();
			expect(mockPersistenceLoad).toHaveBeenCalledWith('expandedPaths');
			expect(loadedGlobal).toEqual(globalPaths);

			const folderUri = 'file:///workspace/project';
			const folderPaths = ['/workspace/project/src', '/workspace/project/tests'];
			await persistence.saveExpandedPaths(folderPaths, folderUri);
			expect(mockPersistenceSave).toHaveBeenCalledWith(`expandedPaths:${folderUri}`, folderPaths);

			mockPersistenceLoad.mockResolvedValueOnce(folderPaths);
			const loadedFolder = await persistence.loadExpandedPaths(folderUri);
			expect(mockPersistenceLoad).toHaveBeenCalledWith(`expandedPaths:${folderUri}`);
			expect(loadedFolder).toEqual(folderPaths);
		});

		it('returns an empty array when expandedPaths is empty/null', async () => {
			mockPersistenceLoad.mockResolvedValueOnce(null);
			const loaded = await persistence.loadExpandedPaths('file:///empty');
			expect(loaded).toEqual([]);
		});
	});

	describe('activeDocumentId', () => {
		it('saves and loads active document id for global and scoped workspaces', async () => {
			await persistence.saveActiveDocumentId('doc-42');
			expect(mockPersistenceSave).toHaveBeenCalledWith('activeDocumentId', 'doc-42');

			mockPersistenceLoad.mockResolvedValueOnce('doc-42');
			const loadedGlobal = await persistence.loadActiveDocumentId();
			expect(mockPersistenceLoad).toHaveBeenCalledWith('activeDocumentId');
			expect(loadedGlobal).toBe('doc-42');

			const folderUri = 'file:///workspace/project';
			await persistence.saveActiveDocumentId('doc-99', folderUri);
			expect(mockPersistenceSave).toHaveBeenCalledWith(`activeDocumentId:${folderUri}`, 'doc-99');

			mockPersistenceLoad.mockResolvedValueOnce('doc-99');
			const loadedFolder = await persistence.loadActiveDocumentId(folderUri);
			expect(mockPersistenceLoad).toHaveBeenCalledWith(`activeDocumentId:${folderUri}`);
			expect(loadedFolder).toBe('doc-99');
		});

		it('returns null when activeDocumentId is null', async () => {
			mockPersistenceLoad.mockResolvedValueOnce(null);
			const loaded = await persistence.loadActiveDocumentId();
			expect(loaded).toBeNull();
		});
	});

	describe('loadAll', () => {
		it('returns the raw persisted snapshot directly without legacy key translation', async () => {
			const snapshot = {
				rootFolder: { scheme: 'file', path: '/project', name: 'project' },
				recentFolders: [{ scheme: 'file', path: '/project', name: 'project' }],
				'openFiles:file:///project': [
					{ id: 'doc-1', origin: { scheme: 'file', path: '/project/README.md', name: 'README.md' } }
				],
				'activeDocumentId:file:///project': 'doc-1',
				'expandedPaths:file:///project': ['/project/src']
			};

			mockPersistenceLoadAll.mockResolvedValueOnce(snapshot);
			const result = await persistence.loadAll();

			expect(mockPersistenceLoadAll).toHaveBeenCalledTimes(1);
			expect(result).toEqual(snapshot);
			// Verify legacy transformation keys are NOT created
			expect(result['open-files:file:///project']).toBeUndefined();
			expect(result['active-id:file:///project']).toBeUndefined();
			expect(result['expanded-paths:file:///project']).toBeUndefined();
		});

		it('returns an empty object when persistenceLoadAll returns null or undefined', async () => {
			mockPersistenceLoadAll.mockResolvedValueOnce(null);
			const result = await persistence.loadAll();
			expect(result).toEqual({});
		});
	});

	describe('full session roundtrip', () => {
		it('saves and restores full session state cleanly across multiple folders', async () => {
			const store: Record<string, any> = {};
			mockPersistenceSave.mockImplementation(async (key: string, value: any) => {
				store[key] = value;
			});
			mockPersistenceLoad.mockImplementation(async (key: string) => {
				return store[key] ?? null;
			});
			mockPersistenceLoadAll.mockImplementation(async () => {
				return { ...store };
			});

			const rootFolder: FileOrigin = { scheme: 'file', path: '/workspace/project-a', name: 'project-a' };
			const recentFolders: FileOrigin[] = [rootFolder];
			const folderUri = 'file:///workspace/project-a';

			const openFiles: SerializedDocument[] = [
				{
					id: 'doc-1',
					origin: { scheme: 'file', path: '/workspace/project-a/index.ts', name: 'index.ts' },
					draftContent: 'const a = 1;'
				},
				{
					id: 'tab-diff',
					origin: null,
					virtualTabType: 'diff',
					diffFilepath: 'src/app.ts',
					diffStaged: false
				}
			];
			const expandedPaths = ['/workspace/project-a/src'];
			const activeId = 'doc-1';

			// Save all aspects of the session
			await persistence.saveRootFolder(rootFolder);
			await persistence.saveRecentFolders(recentFolders);
			await persistence.saveOpenFiles(openFiles, folderUri);
			await persistence.saveExpandedPaths(expandedPaths, folderUri);
			await persistence.saveActiveDocumentId(activeId, folderUri);

			// Load each individually
			expect(await persistence.loadRootFolder()).toEqual(rootFolder);
			expect(await persistence.loadRecentFolders()).toEqual(recentFolders);
			expect(await persistence.loadOpenFiles(folderUri)).toEqual(openFiles);
			expect(await persistence.loadExpandedPaths(folderUri)).toEqual(expandedPaths);
			expect(await persistence.loadActiveDocumentId(folderUri)).toEqual(activeId);

			// Load wholesale via loadAll()
			const wholesale = await persistence.loadAll();
			expect(wholesale).toEqual({
				rootFolder,
				recentFolders,
				[`openFiles:${folderUri}`]: openFiles,
				[`expandedPaths:${folderUri}`]: expandedPaths,
				[`activeDocumentId:${folderUri}`]: activeId
			});
		});
	});
});
