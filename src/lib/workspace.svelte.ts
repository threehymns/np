import { DocumentSession } from './document.svelte';
import type { Storage } from './storage';
import { ProjectTree } from './project/tree.svelte';
import { Repository, type RepositorySafetyReport } from './project/repository.svelte';
import { saveHandles, loadHandles, saveActiveId, loadActiveId, saveRootHandle, loadRootHandle, saveRecentFolders, loadRecentFolders } from './persistence';

export class Workspace {
	documents = $state<DocumentSession[]>([]);
	activeDocumentId = $state<string>('');
	pendingCloseId = $state<string | null>(null);
	rootHandle = $state.raw<FileSystemDirectoryHandle | null>(null);
	repository = $state<Repository | null>(null);
	recentFolders = $state<FileSystemDirectoryHandle[]>([]);
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
					// Persist open files (handles)
					const handles = this.documents
						.map(doc => doc.origin?.handle)
						.filter((h): h is FileSystemFileHandle => !!h);
					
					saveHandles(handles);
				});

				$effect(() => {
					if (this.isRestoring) return;
					// Persist active document ID
					saveActiveId(this.activeDocumentId);
				});

				$effect(() => {
					if (this.isRestoring) return;
					// Persist root folder
					saveRootHandle(this.rootHandle);
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

	async openFile(specificHandle?: FileSystemFileHandle) {
		const origin = specificHandle 
			? { handle: specificHandle, name: specificHandle.name }
			: await this.storage.pickFile();
		
		if (!origin) return;

		// Check if already open
		const existing = this.documents.find(d => d.origin?.handle === origin.handle);
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

	async openDirectory(specificHandle?: FileSystemDirectoryHandle) {
		const handle = specificHandle || await this.storage.pickDirectory();
		if (!handle) return;
		
		// Verify permission if it's a specific handle (e.g. from recents)
		if (specificHandle) {
			const granted = await this.storage.verifyPermission(handle, true);
			if (!granted) return;
		}

		this.rootHandle = handle;
		this.hasRootPermission = true;
		this.repository = new Repository(handle);
		await this.repository.refresh();
		
		// Add to recent folders
		let existingIndex = -1;
		for (let i = 0; i < this.recentFolders.length; i++) {
			try {
				if (await handle.isSameEntry(this.recentFolders[i])) {
					existingIndex = i;
					break;
				}
			} catch (e) {
				// Ignore errors comparing handles
			}
		}

		const newRecent = [...this.recentFolders];
		if (existingIndex !== -1) {
			newRecent.splice(existingIndex, 1);
		}
		this.recentFolders = [handle, ...newRecent].slice(0, 10);

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
					if (doc.origin && this.rootHandle) {
						try {
							const parts = await this.rootHandle.resolve(doc.origin.handle);
							if (parts) return parts.join('/');
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
			const [handles, activeId, rootHandle, recentFolders] = await Promise.all([
				loadHandles(),
				loadActiveId(),
				loadRootHandle(),
				loadRecentFolders()
			]);
			
			this.recentFolders = recentFolders;

			if (rootHandle) {
				try {
					const permission = await rootHandle.queryPermission({ mode: 'readwrite' });
					
					if (permission === 'granted') {
						// Permission is already granted. We can initialize repository and tree immediately.
						try {
							await rootHandle.getDirectoryHandle('.git');
							this.rootHandle = rootHandle;
							this.hasRootPermission = true;
							this.repository = new Repository(rootHandle);
							await this.repository.refresh();
							await this.projectTree.scan(rootHandle);
						} catch (e: any) {
							if (e.name === 'NotFoundError') {
								// Not a git repo, basic access is fine.
								this.rootHandle = rootHandle;
								this.hasRootPermission = true;
								this.repository = null;
								await this.projectTree.scan(rootHandle);
							} else {
								this.rootHandle = rootHandle;
								this.hasRootPermission = false;
							}
						}
					} else {
						this.rootHandle = rootHandle;
						this.hasRootPermission = false;
					}
				} catch (e) {
					console.warn('[Workspace] Handle appears to be stale or invalid:', e);
					this.rootHandle = null;
					this.hasRootPermission = false;
				}
			}

			if (handles.length > 0) {
				const restoredDocs: DocumentSession[] = [];
				for (const handle of handles) {
					const origin = { handle, name: handle.name };
					let content = '';
					
					try {
						if (await handle.queryPermission() === 'granted') {
							content = await this.storage.readFile(origin);
						}
					} catch (e) {
						console.warn(`[Workspace] Failed to read restored file ${handle.name}`, e);
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
