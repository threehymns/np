import { DocumentSession } from './document.svelte';
import { type Storage, type FileOrigin, toURI } from './storage';
import { ProjectTree } from './project/tree.svelte';
import { Repository, type RepositorySafetyReport } from './project/repository.svelte';
import { type SessionPersistence, type SerializedDocument } from './persistence';
import type { SwitchResult, VCSAdapter } from './project/vcs';

export interface WorkspaceTab {
	id: string;
	type: 'document' | 'diff';
}

export class Workspace {
	documents = $state<DocumentSession[]>([]);
	tabs = $state<WorkspaceTab[]>([]);
	activeTabId = $state<string>('');
	pendingCloseId = $state<string | null>(null);
	rootOrigin = $state<FileOrigin | null>(null);
	repository = $state<Repository | null>(null);
	recentFolders = $state<FileOrigin[]>([]);
	projectTree = new ProjectTree(this);
	hasRootPermission = $state(false);
	
	storage: Storage;
	vcsFactory: (rootOrigin: FileOrigin) => VCSAdapter;
	persistence: SessionPersistence;
	private untitledCounter = 0;
	private isRestoring = $state(true);
	private restorePromise: Promise<void> | null = null;

	private saveOpenFilesTimeout: any = null;

	private debouncedSaveOpenFiles() {
		if (this.saveOpenFilesTimeout) {
			clearTimeout(this.saveOpenFilesTimeout);
		}
		this.saveOpenFilesTimeout = setTimeout(() => {
			this.flushSaveOpenFiles();
		}, 500);
	}

	private serializeTabs(): SerializedDocument[] {
		return this.tabs.map(tab => {
			if (tab.type === 'diff') {
				return {
					id: tab.id,
					origin: null,
					isModified: false,
					virtualTabType: 'diff'
				} as any;
			}
			const doc = this.documents.find(d => d.id === tab.id);
			if (!doc) return null;
			const serialized: SerializedDocument = {
				id: doc.id,
				origin: doc.origin ? $state.snapshot(doc.origin) : null,
				untitledTitle: doc.untitledTitle,
				isModified: doc.isModified
			};
			if (doc.isModified || !doc.origin) {
				serialized.draftContent = doc.content;
			}
			return serialized;
		}).filter(Boolean) as SerializedDocument[];
	}

	flushSaveOpenFiles() {
		if (this.isRestoring) return;

		const folderUri = this.rootOrigin ? toURI(this.rootOrigin) : '';
		const serializedDocs = this.serializeTabs();

		this.persistence.saveOpenFiles(serializedDocs, folderUri);

		if (this.saveOpenFilesTimeout) {
			clearTimeout(this.saveOpenFilesTimeout);
			this.saveOpenFilesTimeout = null;
		}
	}

	constructor(
		storage: Storage,
		vcsFactory: (rootOrigin: FileOrigin) => VCSAdapter,
		persistence: SessionPersistence
	) {
		this.storage = storage;
		this.vcsFactory = vcsFactory;
		this.persistence = persistence;

		$effect.root(() => {
			$effect(() => {
				const activeDoc = this.activeDocument;
				if (activeDoc && activeDoc.origin && activeDoc.content === '' && activeDoc.isLoaded === false) {
					activeDoc.loadContent();
				}
			});

			$effect(() => {
				if (this.isRestoring) return;
				
				const _folderUri = this.rootOrigin ? toURI(this.rootOrigin) : '';
				const _tabs = this.tabs.map(t => t.id).join(',');
				this.documents.forEach(doc => {
					const _c = doc.content;
					const _m = doc.isModified;
					const _o = doc.origin;
					const _t = doc.untitledTitle;
				});
				
				this.debouncedSaveOpenFiles();
			});

			$effect(() => {
				if (this.isRestoring) return;
				const folderUri = this.rootOrigin ? toURI(this.rootOrigin) : '';
				this.persistence.saveActiveDocumentId(this.activeTabId, folderUri);
			});

			$effect(() => {
				if (this.isRestoring) return;
				// Persist root folder
				this.persistence.saveRootFolder(this.rootOrigin ? $state.snapshot(this.rootOrigin) : null);
			});

			$effect(() => {
				if (this.isRestoring) return;
				// Persist recent folders
				this.persistence.saveRecentFolders($state.snapshot(this.recentFolders));
			});
		});
	}

	get activeTab() {
		return this.tabs.find(t => t.id === this.activeTabId);
	}

	get activeDocument() {
		if (this.activeTab?.type === 'document') {
			return this.documents.find((doc) => doc.id === this.activeTabId);
		}
		return undefined;
	}

	get activeDocumentId() {
		return this.activeTabId;
	}

	set activeDocumentId(value: string) {
		this.activeTabId = value;
	}

	get currentBranch() {
		return this.repository?.currentBranch ?? null;
	}

	get branches() {
		return this.repository?.branches ?? [];
	}

	setTabs(tabs: WorkspaceTab[]) {
		this.tabs = tabs;
		this.debouncedSaveOpenFiles();
	}

	moveTab(fromIdx: number, toIdx: number) {
		if (fromIdx < 0 || fromIdx >= this.tabs.length || toIdx < 0 || toIdx >= this.tabs.length || fromIdx === toIdx) {
			return;
		}
		const [movedTab] = this.tabs.splice(fromIdx, 1);
		this.tabs.splice(toIdx, 0, movedTab);
		this.debouncedSaveOpenFiles();
	}

	reorderDocuments(newDocs: DocumentSession[]) {
		// Retained for backward-compatibility; reorders documents array matching the documents in tabs
		this.documents = newDocs;
	}

	async newFile() {
		console.log('[Workspace] newFile called. Counter:', this.untitledCounter + 1);
		this.untitledCounter++;
		const newDoc = new DocumentSession(this.storage, '', null, `Untitled ${this.untitledCounter}`, this);
		this.documents.push(newDoc);
		this.tabs.push({ id: newDoc.id, type: 'document' });
		this.activeTabId = newDoc.id;
		console.log('[Workspace] newFile finished. documents count:', this.documents.length);
		return newDoc;
	}

	async openFile(specificOrigin?: FileOrigin) {
		let origin: FileOrigin | null = null;

		if (specificOrigin) {
			origin = specificOrigin;
		} else {
			origin = await this.storage.pickFile();
		}

		if (!origin) return;

		// Check if already open
		const targetUri = toURI(origin);
		const existing = this.documents.find(d => d.origin && toURI(d.origin) === targetUri);
		if (existing) {
			this.activeTabId = existing.id;
			return existing;
		}

		const content = await this.storage.readFile(origin);
		const newDoc = new DocumentSession(this.storage, content, origin, undefined, this);
		this.documents.push(newDoc);
		this.tabs.push({ id: newDoc.id, type: 'document' });
		this.activeTabId = newDoc.id;
		return newDoc;
	}

	async openDirectory(specificOrigin?: FileOrigin) {
		let origin: FileOrigin | null = null;

		if (specificOrigin) {
			origin = specificOrigin;
		} else {
			origin = await this.storage.pickDirectory();
		}

		if (!origin) return;
		
		// Verify permission
		const granted = await this.storage.verifyPermission(origin, true);
		if (!granted) return;

		// Save old state
		this.flushSaveOpenFiles();
		const oldFolderUri = this.rootOrigin ? toURI(this.rootOrigin) : '';
		await this.saveFolderState(oldFolderUri);

		this.isRestoring = true;

		this.rootOrigin = origin;
		this.hasRootPermission = true;

		this.repository = new Repository(origin, this.vcsFactory);
		await this.repository.refresh();
		
		// Add to recent folders
		const newRecent = this.recentFolders.filter(f => toURI(f) !== toURI(origin!));
		this.recentFolders = [origin, ...newRecent].slice(0, 10);

		// Reset project tree expansion state
		this.projectTree.resetExpansionState();

		await this.projectTree.scan(origin);

		// Load new folder state
		const folderUri = toURI(origin);
		await this.loadFolderState(folderUri);

		this.isRestoring = false;

		// Refresh permissions for already open files
		for (const doc of this.documents) {
			if (doc.origin) {
				doc.hasRootPermissionForFile().then(hasRoot => {
					if (hasRoot) {
						doc.permissionState = 'granted';
					}
				});
			}
		}
	}

	async requestRootPermission() {
		if (!this.rootOrigin) return false;
		const granted = await this.storage.verifyPermission(this.rootOrigin, true);
		if (granted) {
			console.log('[Workspace] Permission granted manually. Initializing repository...');
			this.hasRootPermission = true;

			this.repository = new Repository(this.rootOrigin, this.vcsFactory);
			
			// Fresh start for the adapter
			const adapter = (this.repository as any).adapter;
			if (adapter && typeof adapter.reset === 'function') {
				adapter.reset();
			}
			
			const success = await this.repository.refresh();
			console.log('[Workspace] Repository initialized after permission:', success);
			
			await this.projectTree.scan(this.rootOrigin);

			// Refresh permissions for already open files
			for (const doc of this.documents) {
				if (doc.origin) {
					doc.hasRootPermissionForFile().then(hasRoot => {
						if (hasRoot) {
							doc.permissionState = 'granted';
						}
					});
				}
			}
		}
		return granted;
	}

	closeDocument(id: string) {
		this.closeTab(id);
	}

	closeTab(id: string) {
		const tab = this.tabs.find(t => t.id === id);
		if (!tab) return;

		if (tab.type === 'document') {
			const index = this.documents.findIndex(doc => doc.id === id);
			if (index !== -1) {
				const doc = this.documents[index];
				if (doc.isModified) {
					this.pendingCloseId = id;
					return;
				}
			}
		}

		this.finalizeClose(id);
	}

	finalizeClose(id: string, saveFirst = false) {
		const tab = this.tabs.find(t => t.id === id);
		if (!tab) return;

		if (tab.type === 'document') {
			const index = this.documents.findIndex(doc => doc.id === id);
			if (index !== -1) {
				const doc = this.documents[index];
				if (saveFirst) {
					doc.save().then(
						(saved) => {
							if (saved) {
								this.performClose(id);
							}
							this.pendingCloseId = null;
						},
						(err) => {
							console.error('[Workspace] Save before close failed', err);
							this.pendingCloseId = null;
						}
					);
					return;
				} else {
					this.performClose(id);
					this.pendingCloseId = null;
					return;
				}
			}
		}

		this.performClose(id);
		this.pendingCloseId = null;
	}

	private async performClose(id: string) {
		const tabIndex = this.tabs.findIndex(t => t.id === id);
		if (tabIndex === -1) return;

		const tab = this.tabs[tabIndex];

		if (tab.type === 'document') {
			const docIndex = this.documents.findIndex(doc => doc.id === id);
			if (docIndex !== -1) {
				this.documents.splice(docIndex, 1);
			}
		}

		this.tabs.splice(tabIndex, 1);

		if (this.tabs.length === 0) {
			await this.newFile();
		} else if (this.activeTabId === id) {
			this.activeTabId = this.tabs[Math.max(0, tabIndex - 1)].id;
		}
	}

	async getBranchSafetyReport(targetBranch: string): Promise<RepositorySafetyReport | null> {
		if (!this.repository) return null;
		
		const modifiedFiles = await Promise.all(
			this.documents
				.filter(doc => doc.isModified)
				.map(async doc => {
					if (doc.origin && this.rootOrigin) {
						if (doc.origin.scheme === this.rootOrigin.scheme) {
							if (doc.origin.path.startsWith(this.rootOrigin.path + '/')) {
								return doc.origin.path.slice(this.rootOrigin.path.length + 1);
							} else if (doc.origin.path === this.rootOrigin.path) {
								return '';
							}
						}
					}
					return doc.fileName;
				})
		);
			
		return await this.repository.getSafetyReport(modifiedFiles, targetBranch);
	}

	async switchBranch(branchName: string): Promise<SwitchResult> {
		if (!this.repository || !this.rootOrigin) {
			return { status: 'error', message: 'No repository' };
		}

		try {
			const result = await this.repository.switchBranch(branchName);
			
			if (result.status === 'switched' || result.status === 'noop') {
				// Full reload after branch switch
				await this.projectTree.scan(this.rootOrigin);
				
				for (const doc of this.documents) {
					if (doc.origin) {
						try {
							await doc.loadContent();
						} catch (e) {
							// Ignored here; doc.loadContent() handles setting deletedOnDisk to true
						}
					}
				}
			}
			return result;
		} catch (e: any) {
			console.error('Failed to switch branch', e);
			return { status: 'error', message: e.message || 'Failed to switch branch' };
		}
	}



	async saveFolderState(folderUri: string) {
		console.log('[Workspace] saveFolderState start for:', folderUri);
		const serializedDocs = this.serializeTabs();

		await this.persistence.saveOpenFiles(serializedDocs, folderUri);
		await this.persistence.saveActiveDocumentId(this.activeTabId, folderUri);
		console.log('[Workspace] saveFolderState finished for:', folderUri);
	}

	async loadFolderState(folderUri: string) {
		console.log('[Workspace] loadFolderState start for:', folderUri);
		try {
			const origins = await this.persistence.loadOpenFiles(folderUri);
			console.log('[Workspace] loadOpenFiles returned:', origins);
			const activeId = await this.persistence.loadActiveDocumentId(folderUri);
			console.log('[Workspace] loadActiveDocumentId returned:', activeId);

			if (origins && origins.length > 0) {
				const restoredDocs: DocumentSession[] = [];
				const restoredTabs: WorkspaceTab[] = [];
				for (const serialized of origins) {
					const isNewSchema = serialized && typeof serialized === 'object' && ('id' in serialized);
					
					let doc: DocumentSession | null = null;
					if (isNewSchema) {
						if ((serialized as any).virtualTabType === 'diff') {
							restoredTabs.push({
								id: serialized.id,
								type: 'diff'
							});
							continue;
						}
						doc = new DocumentSession(
							this.storage,
							'',
							serialized.origin,
							serialized.untitledTitle || 'Untitled',
							this
						);
						doc.id = serialized.id as any;
						if (serialized.draftContent !== undefined) {
							doc.restoreDraft(serialized.draftContent);
						}
					} else {
						// Old schema compatibility
						const origin = serialized as unknown as FileOrigin;
						doc = new DocumentSession(this.storage, '', origin, undefined, this);
					}
					restoredDocs.push(doc);
					restoredTabs.push({
						id: doc.id,
						type: 'document'
					});
				}

				this.documents = restoredDocs;
				this.tabs = restoredTabs;
				if (activeId && restoredTabs.some(t => t.id === activeId)) {
					this.activeTabId = activeId;
				} else {
					this.activeTabId = restoredTabs[0]?.id || '';
				}
			} else {
				console.log('[Workspace] No origins found, creating new file');
				this.documents = [];
				this.tabs = [];
				await this.newFile();
			}
			console.log('[Workspace] loadFolderState finished. documents count:', this.documents.length);
		} catch (e) {
			console.error('[Workspace] Failed to load folder state', e);
			this.documents = [];
			this.tabs = [];
			await this.newFile();
		}
	}

	async restoreSession(force = false) {
		if (force) {
			this.restorePromise = null;
		}
		if (this.restorePromise) return this.restorePromise;

		this.restorePromise = (async () => {
			console.log('[Workspace] restoreSession start');
			this.isRestoring = true;
			try {
				const all = await this.persistence.loadAll();
				console.log('[Workspace] loadAll returned:', all);
				
				const rootOrigin: FileOrigin | null = all.rootFolder || null;
				const recentFolders: FileOrigin[] = all.recentFolders || [];
				
				this.recentFolders = recentFolders;

				if (rootOrigin) {
					this.rootOrigin = rootOrigin;

					const permission = await this.storage.queryPermission(rootOrigin, true);
					
					if (permission === 'granted') {
						this.hasRootPermission = true;
						// Initialize repo and tree in background
						(async () => {
							try {
								this.repository = new Repository(rootOrigin!, this.vcsFactory);
								await this.repository.refresh();
								await this.projectTree.scan(rootOrigin!);
							} catch (e: any) {
								console.error('[Workspace] Failed to initialize repo/tree during restore:', e);
							}
						})();
					} else {
						this.hasRootPermission = false;
					}
				}

				// Load namespaced state for the restored folder URI
				const folderUri = rootOrigin ? toURI(rootOrigin) : '';
				console.log('[Workspace] Restoring state for folderUri:', folderUri);
				await this.loadFolderState(folderUri);

			} catch (e) {
				console.error('[Workspace] Failed to restore session', e);
				this.documents = [];
				this.tabs = [];
				await this.newFile();
			} finally {
				this.isRestoring = false;
				console.log('[Workspace] restoreSession finished. isRestoring = false');
			}
		})();

		return this.restorePromise;
	}
}
