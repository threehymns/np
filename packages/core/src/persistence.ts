import type { FileOrigin } from './storage';

export interface WorkspacePersistence {
	saveOpenFiles(origins: FileOrigin[]): Promise<void>;
	loadOpenFiles(): Promise<FileOrigin[]>;
	saveRootFolder(origin: FileOrigin | null): Promise<void>;
	loadRootFolder(): Promise<FileOrigin | null>;
	saveRecentFolders(origins: FileOrigin[]): Promise<void>;
	loadRecentFolders(): Promise<FileOrigin[]>;
	saveExpandedPaths(paths: string[]): Promise<void>;
	loadExpandedPaths(): Promise<string[]>;
	saveActiveDocumentId(id: string): Promise<void>;
	loadActiveDocumentId(): Promise<string | null>;
}

export class MemoryWorkspacePersistence implements WorkspacePersistence {
	private openFiles: FileOrigin[] = [];
	private rootFolder: FileOrigin | null = null;
	private recentFolders: FileOrigin[] = [];
	private expandedPaths: string[] = [];
	private activeDocumentId: string | null = null;

	async saveOpenFiles(origins: FileOrigin[]): Promise<void> {
		this.openFiles = origins;
	}

	async loadOpenFiles(): Promise<FileOrigin[]> {
		return this.openFiles;
	}

	async saveRootFolder(origin: FileOrigin | null): Promise<void> {
		this.rootFolder = origin;
	}

	async loadRootFolder(): Promise<FileOrigin | null> {
		return this.rootFolder;
	}

	async saveRecentFolders(origins: FileOrigin[]): Promise<void> {
		this.recentFolders = origins;
	}

	async loadRecentFolders(): Promise<FileOrigin[]> {
		return this.recentFolders;
	}

	async saveExpandedPaths(paths: string[]): Promise<void> {
		this.expandedPaths = paths;
	}

	async loadExpandedPaths(): Promise<string[]> {
		return this.expandedPaths;
	}

	async saveActiveDocumentId(id: string): Promise<void> {
		this.activeDocumentId = id;
	}

	async loadActiveDocumentId(): Promise<string | null> {
		return this.activeDocumentId;
	}
}
