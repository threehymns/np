import type { SessionPersistence, FileOrigin, SerializedDocument } from '@np/core';

export class ElectronSessionPersistence implements SessionPersistence {
	async saveOpenFiles(origins: SerializedDocument[], folderUri = ''): Promise<void> {
		const key = folderUri ? `openFiles:${folderUri}` : 'openFiles';
		await window.electronAPI.persistenceSave(key, origins);
	}

	async loadOpenFiles(folderUri = ''): Promise<SerializedDocument[]> {
		const key = folderUri ? `openFiles:${folderUri}` : 'openFiles';
		return (await window.electronAPI.persistenceLoad(key)) || [];
	}

	async saveRootFolder(origin: FileOrigin | null): Promise<void> {
		await window.electronAPI.persistenceSave('rootFolder', origin);
	}

	async loadRootFolder(): Promise<FileOrigin | null> {
		return await window.electronAPI.persistenceLoad('rootFolder');
	}

	async saveRecentFolders(origins: FileOrigin[]): Promise<void> {
		await window.electronAPI.persistenceSave('recentFolders', origins);
	}

	async loadRecentFolders(): Promise<FileOrigin[]> {
		return (await window.electronAPI.persistenceLoad('recentFolders')) || [];
	}

	async saveExpandedPaths(paths: string[], folderUri = ''): Promise<void> {
		const key = folderUri ? `expandedPaths:${folderUri}` : 'expandedPaths';
		await window.electronAPI.persistenceSave(key, paths);
	}

	async loadExpandedPaths(folderUri = ''): Promise<string[]> {
		const key = folderUri ? `expandedPaths:${folderUri}` : 'expandedPaths';
		return (await window.electronAPI.persistenceLoad(key)) || [];
	}

	async saveActiveDocumentId(id: string, folderUri = ''): Promise<void> {
		const key = folderUri ? `activeDocumentId:${folderUri}` : 'activeDocumentId';
		await window.electronAPI.persistenceSave(key, id);
	}

	async loadActiveDocumentId(folderUri = ''): Promise<string | null> {
		const key = folderUri ? `activeDocumentId:${folderUri}` : 'activeDocumentId';
		return await window.electronAPI.persistenceLoad(key);
	}

	async loadAll(): Promise<Record<string, any>> {
		const all = await window.electronAPI.persistenceLoadAll();
		const keyPrefixes = {
			openFiles: 'open-files',
			activeDocumentId: 'active-id',
			expandedPaths: 'expanded-paths'
		};

		for (const key of Object.keys(all)) {
			for (const [legacyPrefix, normalizedPrefix] of Object.entries(keyPrefixes)) {
				if (key.startsWith(`${legacyPrefix}:`)) {
					const normalizedKey = `${normalizedPrefix}:${key.slice(legacyPrefix.length + 1)}`;
					if (!(normalizedKey in all)) {
						all[normalizedKey] = all[key];
					}
					delete all[key];
					break;
				}
			}
		}

		return all;
	}
}
