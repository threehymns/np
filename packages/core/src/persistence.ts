import type { FileOrigin } from './storage';

export interface SerializedDocument {
	id: string;
	origin: FileOrigin | null;
	untitledTitle?: string;
	draftContent?: string;
	isModified: boolean;
	virtualTabType?: 'diff' | 'document';
}

export interface SessionPersistence {
	saveOpenFiles(origins: SerializedDocument[], folderUri?: string): Promise<void>;
	loadOpenFiles(folderUri?: string): Promise<SerializedDocument[]>;
	saveRootFolder(origin: FileOrigin | null): Promise<void>;
	loadRootFolder(): Promise<FileOrigin | null>;
	saveRecentFolders(origins: FileOrigin[]): Promise<void>;
	loadRecentFolders(): Promise<FileOrigin[]>;
	saveExpandedPaths(paths: string[], folderUri?: string): Promise<void>;
	loadExpandedPaths(folderUri?: string): Promise<string[]>;
	saveActiveDocumentId(id: string, folderUri?: string): Promise<void>;
	loadActiveDocumentId(folderUri?: string): Promise<string | null>;
	loadAll(): Promise<Record<string, any>>;
}

export type WorkspacePersistence = SessionPersistence;

export class MemorySessionPersistence implements SessionPersistence {
	private states = new Map<string, {
		openFiles: SerializedDocument[];
		activeDocumentId: string | null;
		expandedPaths: string[];
	}>();

	private rootFolder: FileOrigin | null = null;
	private recentFolders: FileOrigin[] = [];

	private getOrCreateState(folderUri = '') {
		let state = this.states.get(folderUri);
		if (!state) {
			state = {
				openFiles: [],
				activeDocumentId: null,
				expandedPaths: []
			};
			this.states.set(folderUri, state);
		}
		return state;
	}

	async loadAll(): Promise<Record<string, any>> {
		const map: Record<string, any> = {
			rootFolder: this.rootFolder,
			recentFolders: this.recentFolders
		};
		
		for (const [folderUri, state] of this.states.entries()) {
			const suffix = folderUri ? `:${folderUri}` : '';
			map[`open-files${suffix}`] = state.openFiles;
			map[`active-id${suffix}`] = state.activeDocumentId;
			map[`expanded-paths${suffix}`] = state.expandedPaths;
		}

		// Direct global properties mapping
		const globalState = this.getOrCreateState('');
		map.openFiles = globalState.openFiles;
		map.activeDocumentId = globalState.activeDocumentId;
		map.expandedPaths = globalState.expandedPaths;

		return map;
	}

	async saveOpenFiles(origins: SerializedDocument[], folderUri = ''): Promise<void> {
		this.getOrCreateState(folderUri).openFiles = origins;
	}

	async loadOpenFiles(folderUri = ''): Promise<SerializedDocument[]> {
		return this.getOrCreateState(folderUri).openFiles;
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

	async saveExpandedPaths(paths: string[], folderUri = ''): Promise<void> {
		this.getOrCreateState(folderUri).expandedPaths = paths;
	}

	async loadExpandedPaths(folderUri = ''): Promise<string[]> {
		return this.getOrCreateState(folderUri).expandedPaths;
	}

	async saveActiveDocumentId(id: string, folderUri = ''): Promise<void> {
		this.getOrCreateState(folderUri).activeDocumentId = id;
	}

	async loadActiveDocumentId(folderUri = ''): Promise<string | null> {
		return this.getOrCreateState(folderUri).activeDocumentId;
	}
}

export { MemorySessionPersistence as MemoryWorkspacePersistence };

