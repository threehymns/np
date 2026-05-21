import { DocumentSession } from './document.svelte';
import type { Storage } from './storage';
import { ProjectTree } from './project/tree.svelte';
import { saveHandles, loadHandles, saveActiveId, loadActiveId, saveRootHandle, loadRootHandle, saveRecentFolders, loadRecentFolders } from './persistence';

export class Workspace {
	documents = $state<DocumentSession[]>([]);
	activeDocumentId = $state<string>('');
	pendingCloseId = $state<string | null>(null);
	rootHandle = $state.raw<FileSystemDirectoryHandle | null>(null);
	recentFolders = $state.raw<FileSystemDirectoryHandle[]>([]);
	projectTree = new ProjectTree();
	hasRootPermission = $state(false);
	
	private storage: Storage;
	private untitledCounter = 0;
	private isRestoring = $state(false);

	constructor(storage: Storage) {
		this.storage = storage;
		
		// Initialize with a default untitled doc
		this.newFile();

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
					saveRecentFolders(this.recentFolders);
				});
			});
		}
	}

	get activeDocument() {
		return this.documents.find((doc) => doc.id === this.activeDocumentId);
	}

	reorderDocuments(newDocs: DocumentSession[]) {
		this.documents = newDocs;
	}

	async newFile() {
		this.untitledCounter++;
		const newDoc = new DocumentSession(this.storage, '', null, `Untitled ${this.untitledCounter}`);
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
		const newDoc = new DocumentSession(this.storage, content, origin);
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
	}

	async requestRootPermission() {
		if (!this.rootHandle) return false;
		const granted = await this.storage.verifyPermission(this.rootHandle, true);
		if (granted) {
			this.hasRootPermission = true;
			await this.projectTree.scan(this.rootHandle);
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

	private performClose(index: number, id: string) {
		if (this.documents.length === 1) {
			this.untitledCounter++;
			this.documents[0] = new DocumentSession(this.storage, '', null, `Untitled ${this.untitledCounter}`);
			this.activeDocumentId = this.documents[0].id;
		} else {
			this.documents.splice(index, 1);
			if (this.activeDocumentId === id) {
				this.activeDocumentId = this.documents[Math.max(0, index - 1)].id;
			}
		}
	}

	private async restoreSession() {
		this.isRestoring = true;
		try {
			const handles = await loadHandles();
			const activeId = await loadActiveId();
			const rootHandle = await loadRootHandle();
			const recentFolders = await loadRecentFolders();
			
			// Set recent folders first so they are available
			this.recentFolders = recentFolders;

			if (rootHandle) {
				this.rootHandle = rootHandle;
				if (await rootHandle.queryPermission({ mode: 'readwrite' }) === 'granted') {
					this.hasRootPermission = true;
					await this.projectTree.scan(rootHandle);
				} else {
					this.hasRootPermission = false;
				}
			}

			if (handles.length > 0) {
				const restoredDocs: DocumentSession[] = [];
				for (const handle of handles) {
					const origin = { handle, name: handle.name };
					let content = '';
					
					if (await handle.queryPermission() === 'granted') {
						try {
							content = await this.storage.readFile(origin);
						} catch (e) {
							console.error(`Failed to read restored file ${handle.name}`, e);
						}
					}
					
					const doc = new DocumentSession(this.storage, content, origin);
					restoredDocs.push(doc);
				}

				if (restoredDocs.length > 0) {
					this.documents = restoredDocs;
					if (activeId && restoredDocs.some(d => d.id === activeId)) {
						this.activeDocumentId = activeId;
					} else {
						this.activeDocumentId = restoredDocs[0].id;
					}
				}
			}
		} catch (e) {
			console.error('Failed to restore session', e);
		} finally {
			this.isRestoring = false;
		}
	}
}
