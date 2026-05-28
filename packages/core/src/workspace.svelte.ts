import { DocumentSession } from './document.svelte';
import { type Storage, type FileOrigin, toURI } from './storage';
import { ProjectTree } from './project/tree.svelte';
import { Repository, type RepositorySafetyReport } from './project/repository.svelte';
import type { WorkspacePersistence } from './persistence';
import type { SwitchResult, VCSAdapter } from './project/vcs';

export class Workspace {
	documents = $state<DocumentSession[]>([]);
	activeDocumentId = $state<string>('');
	pendingCloseId = $state<string | null>(null);
	rootOrigin = $state<FileOrigin | null>(null);
	repository = $state<Repository | null>(null);
	recentFolders = $state<FileOrigin[]>([]);
	projectTree = new ProjectTree(this);
	hasRootPermission = $state(false);
	
	storage: Storage;
	vcsFactory: (rootOrigin: FileOrigin) => VCSAdapter;
	persistence: WorkspacePersistence;
	private untitledCounter = 0;
	private isRestoring = $state(true);

	constructor(
		storage: Storage,
		vcsFactory: (rootOrigin: FileOrigin) => VCSAdapter,
		persistence: WorkspacePersistence
	) {
		this.storage = storage;
		this.vcsFactory = vcsFactory;
		this.persistence = persistence;
		
		if (typeof window !== 'undefined') {
			this.restoreSession();

			$effect.root(() => {
				$effect(() => {
					const activeDoc = this.activeDocument;
					if (activeDoc && activeDoc.origin && activeDoc.content === '' && activeDoc.isLoaded === false) {
						activeDoc.loadContent();
					}
				});

				$effect(() => {
					if (this.isRestoring) return;
					// Persist open files (origins)
					const origins = this.documents
						.map(doc => doc.origin ? $state.snapshot(doc.origin) : null)
						.filter((o): o is FileOrigin => !!o);
					
					this.persistence.saveOpenFiles(origins);
				});

				$effect(() => {
					if (this.isRestoring) return;
					// Persist active document ID
					this.persistence.saveActiveDocumentId(this.activeDocumentId);
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
	}

	get activeDocument() {
		return this.documents.find((doc) => doc.id === this.activeDocumentId);
	}

	get currentBranch() {
		return this.repository?.currentBranch ?? null;
	}

	get branches() {
		return this.repository?.branches ?? [];
	}

	reorderDocuments(newDocs: DocumentSession[]) {
		this.documents = newDocs;
	}

	async newFile() {
		this.untitledCounter++;
		const newDoc = new DocumentSession(this.storage, '', null, `Untitled ${this.untitledCounter}`, this);
		this.documents.push(newDoc);
		this.activeDocumentId = newDoc.id;
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
			this.activeDocumentId = existing.id;
			return;
		}

		const content = await this.storage.readFile(origin);
		const newDoc = new DocumentSession(this.storage, content, origin, undefined, this);
		this.documents.push(newDoc);
		this.activeDocumentId = newDoc.id;
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

		this.rootOrigin = origin;
		this.hasRootPermission = true;

		this.repository = new Repository(origin, this.vcsFactory);
		await this.repository.refresh();
		
		// Add to recent folders
		const newRecent = this.recentFolders.filter(f => toURI(f) !== toURI(origin!));
		this.recentFolders = [origin, ...newRecent].slice(0, 10);

		await this.projectTree.scan(origin);

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
		const index = this.documents.findIndex(doc => doc.id === id);
		if (index === -1) return;

		const doc = this.documents[index];
		if (doc.isModified) {
			this.pendingCloseId = id;
			return;
		}

		this.finalizeClose(id);
	}

	finalizeClose(id: string, saveFirst = false) {
		const index = this.documents.findIndex(doc => doc.id === id);
		if (index === -1) return;

		const doc = this.documents[index];
		
		if (saveFirst) {
			doc.save().then(() => {
				this.performClose(index, id);
			});
		} else {
			this.performClose(index, id);
		}
		
		this.pendingCloseId = null;
	}

	private async performClose(index: number, id: string) {
		if (this.documents.length === 1) {
			this.untitledCounter++;
			this.documents[0] = new DocumentSession(this.storage, '', null, `Untitled ${this.untitledCounter}`, this);
			this.activeDocumentId = this.documents[0].id;
		} else {
			this.documents.splice(index, 1);
			if (this.activeDocumentId === id) {
				this.activeDocumentId = this.documents[Math.max(0, index - 1)].id;
			}
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

	private async restoreSession() {
		this.isRestoring = true;
		try {
			const all = await this.persistence.loadAll();
			
			const origins: FileOrigin[] = all.openFiles || [];
			const activeId: string | null = all.activeDocumentId || null;
			const rootOrigin: FileOrigin | null = all.rootFolder || null;
			const recentFolders: FileOrigin[] = all.recentFolders || [];
			
			this.recentFolders = recentFolders;

			if (origins.length > 0) {
				const restoredDocs: DocumentSession[] = origins.map(origin => 
					new DocumentSession(this.storage, '', origin, undefined, this)
				);

				this.documents = restoredDocs;
				if (activeId && restoredDocs.some(d => d.id === activeId)) {
					this.activeDocumentId = activeId;
				} else {
					this.activeDocumentId = restoredDocs[0].id;
				}
			}

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

			if (this.documents.length === 0) {
				await this.newFile();
			}
		} catch (e) {
			console.error('[Workspace] Failed to restore session', e);
		} finally {
			this.isRestoring = false;
		}
	}
}
