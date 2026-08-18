import type { FileOrigin } from './storage';

export interface SerializedDocument {
	id: string;
	origin: FileOrigin | null;
	untitledTitle?: string;
	/**
	 * Unsaved editor content, present only for modified or untitled documents
	 * so a draft can be restored without the file on disk having been touched.
	 */
	draftContent?: string;
	isModified: boolean;
	/**
	 * Tab kind for tabs that are not plain file-backed documents, e.g. `'diff'`
	 * for git-computed diff views. Omitted on ordinary document tabs.
	 */
	virtualTabType?: 'diff' | 'document';
}

/**
 * Persists workspace session state — open files, active tab, expanded paths,
 * root folder, and recent folders — so it can be restored on the next launch.
 * Implementations are backend-specific (IndexedDB in the browser, Electron IPC
 * file store on desktop, in-memory for tests) and each defines its own key
 * spellings, so session data is not portable across backends.
 *
 * `folderUri` scopes state to an open root folder; the empty string denotes the
 * global state used when no folder is open. A save/load pair must be called
 * with the same scope to see each other's data.
 *
 * {@link loadAll} is the wholesale-restore path: it returns one flat record of
 * every persisted key across all scopes, using the key spellings the restore
 * logic reads back (see each implementation for the exact keys).
 */
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

	/**
	 * Emits the global ('' folder) state under both key conventions: the scoped
	 * spellings above and the bare names (`openFiles`, `activeDocumentId`,
	 * `expandedPaths`), so consumers reading the legacy bare-key convention
	 * still find it.
	 */
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

