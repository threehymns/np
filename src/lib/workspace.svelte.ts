import { DocumentSession } from './document.svelte';
import { type Storage, type FileOrigin, browserHandleRegistry, toURI } from './storage';
import { ProjectTree } from './project/tree.svelte';
import { Repository, type RepositorySafetyReport } from './project/repository.svelte';
import { saveHandles, loadHandles, saveActiveId, loadActiveId, saveRootHandle, loadRootHandle, saveRecentFolders, loadRecentFolders } from './persistence';

export class Workspace {
	documents = $state<DocumentSession[]>([]);
	activeDocumentId = $state<string>('');
	pendingCloseId = $state<string | null>(null);
	rootHandle = $state.raw<FileSystemDirectoryHandle | null>(null);
	rootOrigin = $state<FileOrigin | null>(null);
	repository = $state<Repository | null>(null);
	recentFolders = $state<FileOrigin[]>([]);
	projectTree = new ProjectTree();
	hasRootPermission = $state(false);
	
	private storage: Storage;
	private untitledCounter = 0;
	private isRestoring = $state(false);

	constructor(storage: Storage) {
		this.storage = storage;
		
		if (typeof window !== 'undefined') {
			this.restoreSession();

			$effect.root(() => {
				$effect(() => {
					if (this.isRestoring) return;
					// Persist open files (origins)
					const origins = this.documents
						.map(doc => doc.origin ? $state.snapshot(doc.origin) : null)
						.filter((o): o is FileOrigin => !!o);
					
					saveHandles(origins);
				});

				$effect(() => {
					if (this.isRestoring) return;
					// Persist active document ID
					saveActiveId(this.activeDocumentId);
				});

				$effect(() => {
					if (this.isRestoring) return;
					// Persist root folder
					saveRootHandle(this.rootOrigin ? $state.snapshot(this.rootOrigin) : null);
				});

				$effect(() => {
					if (this.isRestoring) return;
					// Persist recent folders
					saveRecentFolders($state.snapshot(this.recentFolders));
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

	async openFile(specificHandleOrOrigin?: FileSystemFileHandle | FileOrigin) {
		let origin: FileOrigin | null = null;
		let handle: FileSystemFileHandle | null = null;

		if (specificHandleOrOrigin) {
			if ('kind' in specificHandleOrOrigin) {
				handle = specificHandleOrOrigin;
				let path = handle.name;
				if (this.rootHandle && this.rootOrigin) {
					try {
						const parts = await this.rootHandle.resolve(handle);
						if (parts) {
							path = `${this.rootOrigin.path}/${parts.join('/')}`;
						}
					} catch (e) {
						// Ignored
					}
				}
				origin = { scheme: this.rootOrigin?.scheme ?? 'browser', path, name: handle.name };
				await browserHandleRegistry.register(toURI(origin), handle);
			} else {
				origin = specificHandleOrOrigin;
				const resolved = await browserHandleRegistry.resolve(toURI(origin));
				if (resolved && resolved.kind === 'file') {
					handle = resolved as FileSystemFileHandle;
				}
			}
		} else {
			origin = await this.storage.pickFile();
			if (origin) {
				const resolved = await browserHandleRegistry.resolve(toURI(origin));
				if (resolved && resolved.kind === 'file') {
					handle = resolved as FileSystemFileHandle;
				}
			}
		}

		if (!origin || !handle) return;

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

	async openDirectory(specificHandleOrOrigin?: FileSystemDirectoryHandle | FileOrigin) {
		let origin: FileOrigin | null = null;
		let handle: FileSystemDirectoryHandle | null = null;

		if (specificHandleOrOrigin) {
			if ('kind' in specificHandleOrOrigin) {
				handle = specificHandleOrOrigin;
				origin = { scheme: 'browser', path: handle.name, name: handle.name };
				await browserHandleRegistry.register(toURI(origin), handle);
			} else {
				origin = specificHandleOrOrigin;
				const resolved = await browserHandleRegistry.resolve(toURI(origin));
				if (resolved && resolved.kind === 'directory') {
					handle = resolved as FileSystemDirectoryHandle;
				}
			}
		} else {
			origin = await this.storage.pickDirectory();
			if (origin) {
				const resolved = await browserHandleRegistry.resolve(toURI(origin));
				if (resolved && resolved.kind === 'directory') {
					handle = resolved as FileSystemDirectoryHandle;
				}
			}
		}

		if (!handle || !origin) return;
		
		// Verify permission
		const granted = await this.storage.verifyPermission(handle, true);
		if (!granted) return;

		this.rootHandle = handle;
		this.rootOrigin = origin;
		this.hasRootPermission = true;
		this.repository = new Repository(handle);
		await this.repository.refresh();
		
		// Add to recent folders
		const newRecent = this.recentFolders.filter(f => toURI(f) !== toURI(origin!));
		this.recentFolders = [origin, ...newRecent].slice(0, 10);

		await this.projectTree.scan(handle);

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
		if (!this.rootHandle) return false;
		const granted = await this.storage.verifyPermission(this.rootHandle, true);
		if (granted) {
			console.log('[Workspace] Permission granted manually. Initializing repository...');
			this.hasRootPermission = true;
			this.repository = new Repository(this.rootHandle);
			
			// Fresh start for the adapter
			const adapter = (this.repository as any).adapter;
			if (adapter && typeof adapter.reset === 'function') {
				adapter.reset();
			}
			
			const success = await this.repository.refresh();
			console.log('[Workspace] Repository initialized after permission:', success);
			
			await this.projectTree.scan(this.rootHandle);

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
						// Safe fallback
						try {
							const handle = await browserHandleRegistry.resolve(toURI(doc.origin));
							if (handle && this.rootHandle) {
								const parts = await this.rootHandle.resolve(handle);
								if (parts) return parts.join('/');
							}
						} catch {}
					}
					return doc.fileName;
				})
		);
			
		return await this.repository.getSafetyReport(modifiedFiles, targetBranch);
	}

	async switchBranch(branchName: string) {
		if (!this.repository || !this.rootHandle) return;

		try {
			const success = await this.repository.switchBranch(branchName);
			
			if (success) {
				// Full reload after branch switch
				await this.projectTree.scan(this.rootHandle);
				
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
		} catch (e) {
			console.error('Failed to switch branch', e);
		}
	}

	private async restoreSession() {
		this.isRestoring = true;
		try {
			await browserHandleRegistry.loadAll();

			const [origins, activeId, rootOrigin, recentFolders] = await Promise.all([
				loadHandles(),
				loadActiveId(),
				loadRootHandle(),
				loadRecentFolders()
			]);
			
			this.recentFolders = recentFolders || [];

			if (rootOrigin) {
				this.rootOrigin = rootOrigin;

				const rootHandle = await browserHandleRegistry.resolve(toURI(rootOrigin));
				if (rootHandle && rootHandle.kind === 'directory') {
					try {
						const dirHandle = rootHandle as FileSystemDirectoryHandle;
						const permission = await dirHandle.queryPermission({ mode: 'readwrite' });
						
						if (permission === 'granted') {
							// Permission is already granted. We can initialize repository and tree immediately.
							try {
								await dirHandle.getDirectoryHandle('.git');
								this.rootHandle = dirHandle;
								this.hasRootPermission = true;
								this.repository = new Repository(dirHandle);
								await this.repository.refresh();
								await this.projectTree.scan(dirHandle);
							} catch (e: any) {
								if (e.name === 'NotFoundError') {
									// Not a git repo, basic access is fine.
									this.rootHandle = dirHandle;
									this.hasRootPermission = true;
									this.repository = null;
									await this.projectTree.scan(dirHandle);
								} else {
									this.rootHandle = dirHandle;
									this.hasRootPermission = false;
								}
							}
						} else {
							this.rootHandle = dirHandle;
							this.hasRootPermission = false;
						}
					} catch (e) {
						console.warn('[Workspace] Handle appears to be stale or invalid:', e);
						this.rootHandle = null;
						this.hasRootPermission = false;
					}
				}
			}

			if (origins.length > 0) {
				const restoredDocs: DocumentSession[] = [];
				for (const origin of origins) {
					let content = '';
					
					try {
						const handle = await browserHandleRegistry.resolve(toURI(origin));
						if (handle && await handle.queryPermission() === 'granted') {
							content = await this.storage.readFile(origin);
						}
					} catch (e) {
						console.warn(`[Workspace] Failed to read restored file ${origin.name}`, e);
					}
					
					const doc = new DocumentSession(this.storage, content, origin, undefined, this);
					restoredDocs.push(doc);
				}

				if (restoredDocs.length > 0) {
					this.documents = restoredDocs;
					if (activeId && restoredDocs.some(d => d.id === activeId)) {
						this.activeDocumentId = activeId;
					} else {
						this.activeDocumentId = restoredDocs[0].id;
					}
				} else if (this.documents.length === 0) {
					await this.newFile();
				}
			} else if (this.documents.length === 0) {
				await this.newFile();
			}
		} catch (e) {
			console.error('[Workspace] Failed to restore session', e);
		} finally {
			this.isRestoring = false;
		}
	}
}
