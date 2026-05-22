import type { WorkspacePersistence, FileOrigin } from '@np/core';

const DB_NAME = 'np-storage';
const STORE_NAME = 'handles';
const DB_VERSION = 2;

let dbPromise: Promise<IDBDatabase> | null = null;
export function openDB(): Promise<IDBDatabase> {
	if (dbPromise) return dbPromise;

	dbPromise = new Promise((resolve, reject) => {
		if (typeof indexedDB === 'undefined') {
			reject(new Error('indexedDB is not available'));
			return;
		}
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(STORE_NAME)) {
				db.createObjectStore(STORE_NAME);
			}
			if (!db.objectStoreNames.contains('registry')) {
				db.createObjectStore('registry');
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => {
			dbPromise = null;
			reject(request.error);
		};
	});

	return dbPromise;
}

export class IndexedDBWorkspacePersistence implements WorkspacePersistence {
	async saveOpenFiles(origins: FileOrigin[]): Promise<void> {
		const db = await openDB();
		return new Promise((resolve, reject) => {
			const transaction = db.transaction(STORE_NAME, 'readwrite');
			const store = transaction.objectStore(STORE_NAME);
			const request = store.put(origins, 'open-files');
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}

	async loadOpenFiles(): Promise<FileOrigin[]> {
		const db = await openDB();
		return new Promise((resolve, reject) => {
			const transaction = db.transaction(STORE_NAME, 'readonly');
			const store = transaction.objectStore(STORE_NAME);
			const request = store.get('open-files');
			request.onsuccess = () => resolve(request.result || []);
			request.onerror = () => reject(request.error);
		});
	}

	async saveRootFolder(origin: FileOrigin | null): Promise<void> {
		const db = await openDB();
		return new Promise((resolve, reject) => {
			const transaction = db.transaction(STORE_NAME, 'readwrite');
			const store = transaction.objectStore(STORE_NAME);
			const request = store.put(origin, 'root-folder');
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}

	async loadRootFolder(): Promise<FileOrigin | null> {
		const db = await openDB();
		return new Promise((resolve, reject) => {
			const transaction = db.transaction(STORE_NAME, 'readonly');
			const store = transaction.objectStore(STORE_NAME);
			const request = store.get('root-folder');
			request.onsuccess = () => resolve(request.result || null);
			request.onerror = () => reject(request.error);
		});
	}

	async saveRecentFolders(origins: FileOrigin[]): Promise<void> {
		const db = await openDB();
		return new Promise((resolve, reject) => {
			const transaction = db.transaction(STORE_NAME, 'readwrite');
			const store = transaction.objectStore(STORE_NAME);
			const request = store.put(origins, 'recent-folders');
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}

	async loadRecentFolders(): Promise<FileOrigin[]> {
		const db = await openDB();
		return new Promise((resolve, reject) => {
			const transaction = db.transaction(STORE_NAME, 'readonly');
			const store = transaction.objectStore(STORE_NAME);
			const request = store.get('recent-folders');
			request.onsuccess = () => resolve(request.result || []);
			request.onerror = () => reject(request.error);
		});
	}

	async saveExpandedPaths(paths: string[]): Promise<void> {
		const db = await openDB();
		return new Promise((resolve, reject) => {
			const transaction = db.transaction(STORE_NAME, 'readwrite');
			const store = transaction.objectStore(STORE_NAME);
			const request = store.put(paths, 'expanded-paths');
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}

	async loadExpandedPaths(): Promise<string[]> {
		const db = await openDB();
		return new Promise((resolve, reject) => {
			const transaction = db.transaction(STORE_NAME, 'readonly');
			const store = transaction.objectStore(STORE_NAME);
			const request = store.get('expanded-paths');
			request.onsuccess = () => resolve(request.result || []);
			request.onerror = () => reject(request.error);
		});
	}

	async saveActiveDocumentId(id: string): Promise<void> {
		const db = await openDB();
		return new Promise((resolve, reject) => {
			const transaction = db.transaction(STORE_NAME, 'readwrite');
			const store = transaction.objectStore(STORE_NAME);
			const request = store.put(id, 'active-id');
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}

	async loadActiveDocumentId(): Promise<string | null> {
		const db = await openDB();
		return new Promise((resolve, reject) => {
			const transaction = db.transaction(STORE_NAME, 'readonly');
			const store = transaction.objectStore(STORE_NAME);
			const request = store.get('active-id');
			request.onsuccess = () => resolve(request.result || null);
			request.onerror = () => reject(request.error);
		});
	}
}
