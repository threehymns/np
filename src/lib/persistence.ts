/**
 * Simple IndexedDB wrapper for persisting FileSystemHandles.
 */

const DB_NAME = 'np-storage';
const STORE_NAME = 'handles';
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(STORE_NAME)) {
				db.createObjectStore(STORE_NAME);
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

export async function saveHandles(handles: FileSystemFileHandle[]): Promise<void> {
	const db = await openDB();
	return new Promise((resolve, reject) => {
		const transaction = db.transaction(STORE_NAME, 'readwrite');
		const store = transaction.objectStore(STORE_NAME);
		const request = store.put(handles, 'open-files');
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error);
	});
}

export async function loadHandles(): Promise<FileSystemFileHandle[]> {
	const db = await openDB();
	return new Promise((resolve, reject) => {
		const transaction = db.transaction(STORE_NAME, 'readonly');
		const store = transaction.objectStore(STORE_NAME);
		const request = store.get('open-files');
		request.onsuccess = () => resolve(request.result || []);
		request.onerror = () => reject(request.error);
	});
}

export async function saveActiveId(id: string): Promise<void> {
	const db = await openDB();
	return new Promise((resolve, reject) => {
		const transaction = db.transaction(STORE_NAME, 'readwrite');
		const store = transaction.objectStore(STORE_NAME);
		const request = store.put(id, 'active-id');
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error);
	});
}

export async function loadActiveId(): Promise<string | null> {
	const db = await openDB();
	return new Promise((resolve, reject) => {
		const transaction = db.transaction(STORE_NAME, 'readonly');
		const store = transaction.objectStore(STORE_NAME);
		const request = store.get('active-id');
		request.onsuccess = () => resolve(request.result || null);
		request.onerror = () => reject(request.error);
	});
}
