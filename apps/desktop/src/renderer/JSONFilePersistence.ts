import type { WorkspacePersistence, FileOrigin } from '@np/core';

export class JSONFilePersistence implements WorkspacePersistence {
	async saveOpenFiles(origins: FileOrigin[]): Promise<void> {
		await window.electronAPI.persistenceSave('openFiles', origins);
	}

	async loadOpenFiles(): Promise<FileOrigin[]> {
		return (await window.electronAPI.persistenceLoad('openFiles')) || [];
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

	async saveExpandedPaths(paths: string[]): Promise<void> {
		await window.electronAPI.persistenceSave('expandedPaths', paths);
	}

	async loadExpandedPaths(): Promise<string[]> {
		return (await window.electronAPI.persistenceLoad('expandedPaths')) || [];
	}

	async saveActiveDocumentId(id: string): Promise<void> {
		await window.electronAPI.persistenceSave('activeDocumentId', id);
	}

	async loadActiveDocumentId(): Promise<string | null> {
		return await window.electronAPI.persistenceLoad('activeDocumentId');
	}
}
