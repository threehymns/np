import { describe, test, expect } from 'bun:test';
import { MemorySessionPersistence, type SerializedDocument } from '../src/persistence';
import type { FileOrigin } from '../src/storage';

describe('MemorySessionPersistence (SessionPersistence CRUD Operations)', () => {
	test('returns default values when no data has been saved yet', async () => {
		const persistence = new MemorySessionPersistence();

		expect(await persistence.loadRootFolder()).toBeNull();
		expect(await persistence.loadRecentFolders()).toEqual([]);
		expect(await persistence.loadOpenFiles()).toEqual([]);
		expect(await persistence.loadOpenFiles('folder-a')).toEqual([]);
		expect(await persistence.loadExpandedPaths()).toEqual([]);
		expect(await persistence.loadActiveDocumentId()).toBeNull();
	});

	test('saves and loads root folder and recent folders', async () => {
		const persistence = new MemorySessionPersistence();
		const root: FileOrigin = { scheme: 'file', path: '/home/user/workspace', name: 'workspace' };
		const recent: FileOrigin[] = [
			{ scheme: 'file', path: '/home/user/workspace', name: 'workspace' },
			{ scheme: 'browser', path: 'project-xyz', name: 'project-xyz' }
		];

		await persistence.saveRootFolder(root);
		expect(await persistence.loadRootFolder()).toEqual(root);

		await persistence.saveRecentFolders(recent);
		expect(await persistence.loadRecentFolders()).toEqual(recent);

		// Can clear root folder
		await persistence.saveRootFolder(null);
		expect(await persistence.loadRootFolder()).toBeNull();
	});

	test('saves and loads global files and active document ID', async () => {
		const persistence = new MemorySessionPersistence();
		const openFiles: SerializedDocument[] = [
			{ id: 'doc-1', origin: null, untitledTitle: 'Untitled 1', isModified: true, draftContent: 'Draft' },
			{ id: 'doc-2', origin: { scheme: 'browser', path: 'file.md', name: 'file.md' }, isModified: false }
		];

		await persistence.saveOpenFiles(openFiles);
		expect(await persistence.loadOpenFiles()).toEqual(openFiles);

		await persistence.saveActiveDocumentId('doc-1');
		expect(await persistence.loadActiveDocumentId()).toBe('doc-1');

		await persistence.saveExpandedPaths(['node_modules', 'src']);
		expect(await persistence.loadExpandedPaths()).toEqual(['node_modules', 'src']);
	});

	test('correctly isolates and namespaces data based on folderUri', async () => {
		const persistence = new MemorySessionPersistence();
		const folderA = 'browser://folder-a';
		const folderB = 'file:///folder-b';

		const filesA: SerializedDocument[] = [
			{ id: 'a1', origin: { scheme: 'browser', path: 'folder-a/doc.txt', name: 'doc.txt' }, isModified: false }
		];
		const filesB: SerializedDocument[] = [
			{ id: 'b1', origin: { scheme: 'file', path: '/folder-b/doc.txt', name: 'doc.txt' }, isModified: true, draftContent: 'B' }
		];

		// Save folder-specific open files
		await persistence.saveOpenFiles(filesA, folderA);
		await persistence.saveOpenFiles(filesB, folderB);

		// Save folder-specific active ID
		await persistence.saveActiveDocumentId('a1', folderA);
		await persistence.saveActiveDocumentId('b1', folderB);

		// Save folder-specific expanded paths
		await persistence.saveExpandedPaths(['src'], folderA);
		await persistence.saveExpandedPaths(['dist', 'tests'], folderB);

		// Verify isolation
		expect(await persistence.loadOpenFiles(folderA)).toEqual(filesA);
		expect(await persistence.loadOpenFiles(folderB)).toEqual(filesB);
		expect(await persistence.loadOpenFiles()).toEqual([]); // Global state remains empty

		expect(await persistence.loadActiveDocumentId(folderA)).toBe('a1');
		expect(await persistence.loadActiveDocumentId(folderB)).toBe('b1');
		expect(await persistence.loadActiveDocumentId()).toBeNull();

		expect(await persistence.loadExpandedPaths(folderA)).toEqual(['src']);
		expect(await persistence.loadExpandedPaths(folderB)).toEqual(['dist', 'tests']);
		expect(await persistence.loadExpandedPaths()).toEqual([]);
	});

	test('loadAll returns a comprehensive snapshot of all persisted states', async () => {
		const persistence = new MemorySessionPersistence();
		const root: FileOrigin = { scheme: 'browser', path: 'workspace-root', name: 'workspace-root' };
		const recent: FileOrigin[] = [root];

		await persistence.saveRootFolder(root);
		await persistence.saveRecentFolders(recent);

		// Save global state
		await persistence.saveOpenFiles([{ id: 'g1', origin: null, isModified: false }]);
		await persistence.saveActiveDocumentId('g1');
		await persistence.saveExpandedPaths(['global-path']);

		// Save folder-specific state
		const folderUri = 'browser://workspace-root';
		await persistence.saveOpenFiles([{ id: 'f1', origin: null, isModified: true }], folderUri);
		await persistence.saveActiveDocumentId('f1', folderUri);
		await persistence.saveExpandedPaths(['folder-path'], folderUri);

		const snapshot = await persistence.loadAll();

		// Check global direct properties mapping
		expect(snapshot.rootFolder).toEqual(root);
		expect(snapshot.recentFolders).toEqual(recent);
		expect(snapshot.openFiles).toEqual([{ id: 'g1', origin: null, isModified: false }]);
		expect(snapshot.activeDocumentId).toBe('g1');
		expect(snapshot.expandedPaths).toEqual(['global-path']);

		// Check namespaced properties inside snapshot
		expect(snapshot['open-files']).toEqual([{ id: 'g1', origin: null, isModified: false }]);
		expect(snapshot[`open-files:${folderUri}`]).toEqual([{ id: 'f1', origin: null, isModified: true }]);
		expect(snapshot[`active-id:${folderUri}`]).toBe('f1');
		expect(snapshot[`expanded-paths:${folderUri}`]).toEqual(['folder-path']);
	});
});
