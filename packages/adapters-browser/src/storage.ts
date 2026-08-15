import { toURI, parseURI } from '@np/core/storage';
import type { StorageProvider, FileOrigin, StorageEntry } from '@np/core';
import { openDB } from './persistence';

export class BrowserHandleRegistry {
	private memRegistry = new Map<string, FileSystemHandle>();

	async register(uri: string, handle: FileSystemHandle): Promise<void> {
		this.memRegistry.set(uri, handle);
		
		if (typeof indexedDB === 'undefined') return;

		const db = await openDB();
		return new Promise((resolve, reject) => {
			try {
				const transaction = db.transaction('registry', 'readwrite');
				const store = transaction.objectStore('registry');
				const request = store.put(handle, uri);
				request.onsuccess = () => resolve();
				request.onerror = () => {
					if (request.error && request.error.name === 'DataCloneError') {
						resolve();
					} else {
						reject(request.error);
					}
				};
			} catch (e: any) {
				if (e.name === 'DataCloneError') {
					resolve();
				} else {
					reject(e);
				}
			}
		});
	}

	async loadAll(): Promise<void> {
		if (typeof indexedDB === 'undefined') return;

		const db = await openDB();
		return new Promise((resolve, reject) => {
			const transaction = db.transaction('registry', 'readonly');
			const store = transaction.objectStore('registry');
			
			const request = store.openCursor();
			request.onsuccess = (event) => {
				const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
				if (cursor) {
					this.memRegistry.set(cursor.key as string, cursor.value);
					cursor.continue();
				} else {
					resolve();
				}
			};
			request.onerror = () => reject(request.error);
		});
	}

	async get(uri: string): Promise<FileSystemHandle | null> {
		if (this.memRegistry.has(uri)) {
			return this.memRegistry.get(uri)!;
		}

		if (typeof indexedDB === 'undefined') return null;

		const db = await openDB();
		return new Promise((resolve, reject) => {
			const transaction = db.transaction('registry', 'readonly');
			const store = transaction.objectStore('registry');
			const request = store.get(uri);
			request.onsuccess = () => {
				const handle = request.result || null;
				if (handle) {
					this.memRegistry.set(uri, handle);
				}
				resolve(handle);
			};
			request.onerror = () => reject(request.error);
		});
	}

	async resolve(uri: string): Promise<FileSystemHandle | null> {
		let handle = await this.get(uri);
		if (handle) return handle;

		const parsed = parseURI(uri);
		const pathParts = parsed.path.split('/').filter(Boolean);

		for (let i = pathParts.length - 1; i >= 1; i--) {
			const parentPath = pathParts.slice(0, i).join('/');
			const parentUri = `${parsed.scheme}://${parentPath}`;
			const parentHandle = await this.get(parentUri);
			if (parentHandle && parentHandle.kind === 'directory') {
				const remainingParts = pathParts.slice(i);
				try {
					let current: FileSystemDirectoryHandle = parentHandle as FileSystemDirectoryHandle;
					for (let j = 0; j < remainingParts.length; j++) {
						const part = remainingParts[j];
						const isLast = j === remainingParts.length - 1;
						if (isLast) {
							try {
								return await current.getFileHandle(part);
							} catch {
								return await current.getDirectoryHandle(part);
							}
						} else {
							current = await current.getDirectoryHandle(part);
						}
					}
				} catch (e) {
					console.warn(`Failed to resolve descendant path ${remainingParts.join('/')} from parent ${parentUri}`, e);
				}
			}
		}

		return null;
	}
}

export const browserHandleRegistry = new BrowserHandleRegistry();

export class BrowserStorage implements StorageProvider {
	scheme = 'browser';

	async pickFile(): Promise<FileOrigin | null> {
		try {
			const [handle] = await window.showOpenFilePicker({
				types: [{ description: 'Markdown Files', accept: { 'text/markdown': ['.md'], 'text/plain': ['.txt'] } }],
				multiple: false
			});
			const path = handle.name;
			const origin: FileOrigin = { scheme: 'browser', path, name: handle.name };
			await browserHandleRegistry.register(toURI(origin), handle);
			return origin;
		} catch (e) {
			if ((e as Error).name === 'AbortError') return null;
			throw e;
		}
	}

	async pickDirectory(): Promise<FileOrigin | null> {
		try {
			const handle = await window.showDirectoryPicker();
			const path = handle.name;
			const origin: FileOrigin = { scheme: 'browser', path, name: handle.name };
			await browserHandleRegistry.register(toURI(origin), handle);
			return origin;
		} catch (e) {
			if ((e as Error).name === 'AbortError') return null;
			throw e;
		}
	}

	async saveFile(content: string, existingOrigin?: FileOrigin): Promise<FileOrigin | null> {
		try {
			let handle: FileSystemFileHandle;
			if (existingOrigin) {
				const uri = toURI(existingOrigin);
				const resolved = await browserHandleRegistry.resolve(uri);
				if (!resolved || resolved.kind !== 'file') {
					throw new Error(`Could not resolve file handle for URI: ${uri}`);
				}
				handle = resolved as FileSystemFileHandle;
			} else {
				handle = await window.showSaveFilePicker({
					suggestedName: 'untitled.md',
					types: [{ description: 'Markdown Files', accept: { 'text/markdown': ['.md'], 'text/plain': ['.txt'] } }]
				});
			}
			
			const writable = await handle.createWritable();
			await writable.write(content);
			await writable.close();
			
			const path = existingOrigin?.path ?? handle.name;
			const origin: FileOrigin = { scheme: 'browser', path, name: handle.name };
			await browserHandleRegistry.register(toURI(origin), handle);
			return origin;
		} catch (e) {
			if ((e as Error).name === 'AbortError') return null;
			throw e;
		}
	}

	async readFile(origin: FileOrigin): Promise<string> {
		const uri = toURI(origin);
		const resolved = await browserHandleRegistry.resolve(uri);
		if (!resolved || resolved.kind !== 'file') {
			const err = new Error(`Could not resolve file handle for URI: ${uri}`);
			err.name = 'NotFoundError';
			throw err;
		}
		const file = await (resolved as FileSystemFileHandle).getFile();
		return await file.text();
	}

	async readDirectory(origin: FileOrigin): Promise<StorageEntry[]> {
		const uri = toURI(origin);
		const resolved = await browserHandleRegistry.resolve(uri);
		if (!resolved || resolved.kind !== 'directory') {
			throw new Error(`Could not resolve directory handle for URI: ${uri}`);
		}
		const dirHandle = resolved as FileSystemDirectoryHandle;
		const entries: StorageEntry[] = [];
		for await (const entry of dirHandle.values()) {
			const entryOrigin: FileOrigin = {
				scheme: origin.scheme,
				path: origin.path ? `${origin.path}/${entry.name}` : entry.name,
				name: entry.name
			};
			await browserHandleRegistry.register(toURI(entryOrigin), entry);
			entries.push({
				name: entry.name,
				kind: entry.kind,
				origin: entryOrigin
			});
		}
		return entries;
	}

	async verifyPermission(origin: FileOrigin, readWrite = false): Promise<boolean> {
		const uri = toURI(origin);
		const handle = await browserHandleRegistry.resolve(uri);
		if (!handle) return false;

		const options: FileSystemHandlePermissionDescriptor = {};
		if (readWrite) {
			options.mode = 'readwrite';
		}

		if ((await handle.queryPermission(options)) === 'granted') {
			return true;
		}

		if ((await handle.requestPermission(options)) === 'granted') {
			return true;
		}

		return false;
	}

	async queryPermission(origin: FileOrigin, readWrite = false): Promise<'granted' | 'prompt' | 'denied'> {
		const uri = toURI(origin);
		const handle = await browserHandleRegistry.resolve(uri);
		if (!handle) return 'prompt';

		const options: FileSystemHandlePermissionDescriptor = {};
		if (readWrite) {
			options.mode = 'readwrite';
		}
		const state = await handle.queryPermission(options);
		return state === 'granted' ? 'granted' : state === 'prompt' ? 'prompt' : 'denied';
	}

	async createFile(parent: FileOrigin, name: string): Promise<FileOrigin> {
		const uri = toURI(parent);
		const resolved = await browserHandleRegistry.resolve(uri);
		if (!resolved || resolved.kind !== 'directory') {
			throw new Error(`Could not resolve directory handle for URI: ${uri}`);
		}
		const parentHandle = resolved as FileSystemDirectoryHandle;
		const handle = await parentHandle.getFileHandle(name, { create: true });
		const origin: FileOrigin = {
			scheme: parent.scheme,
			path: parent.path ? `${parent.path}/${name}` : name,
			name
		};
		await browserHandleRegistry.register(toURI(origin), handle);
		return origin;
	}

	async createDirectory(parent: FileOrigin, name: string): Promise<FileOrigin> {
		const uri = toURI(parent);
		const resolved = await browserHandleRegistry.resolve(uri);
		if (!resolved || resolved.kind !== 'directory') {
			throw new Error(`Could not resolve directory handle for URI: ${uri}`);
		}
		const parentHandle = resolved as FileSystemDirectoryHandle;
		const handle = await parentHandle.getDirectoryHandle(name, { create: true });
		const origin: FileOrigin = {
			scheme: parent.scheme,
			path: parent.path ? `${parent.path}/${name}` : name,
			name
		};
		await browserHandleRegistry.register(toURI(origin), handle);
		return origin;
	}

	async deleteEntry(origin: FileOrigin): Promise<void> {
		const pathParts = origin.path.split('/').filter(Boolean);
		if (pathParts.length === 0) {
			throw new Error(`Cannot delete root directory: ${origin.path}`);
		}
		const name = pathParts.pop()!;
		const parentPath = pathParts.join('/');
		const parentOrigin: FileOrigin = {
			scheme: origin.scheme,
			path: parentPath,
			name: parentPath.split('/').pop() || ''
		};
		const parentUri = toURI(parentOrigin);
		const parentResolved = await browserHandleRegistry.resolve(parentUri);
		if (!parentResolved || parentResolved.kind !== 'directory') {
			throw new Error(`Could not resolve parent directory handle for URI: ${parentUri}`);
		}
		await (parentResolved as FileSystemDirectoryHandle).removeEntry(name, { recursive: true });
	}

	async renameEntry(origin: FileOrigin, newName: string): Promise<FileOrigin> {
		const uri = toURI(origin);
		const resolved = await browserHandleRegistry.resolve(uri);
		if (!resolved) {
			throw new Error(`Could not resolve handle for URI: ${uri}`);
		}
		if ('move' in resolved) {
			await (resolved as any).move(newName);
			const pathParts = origin.path.split('/').filter(Boolean);
			pathParts.pop();
			pathParts.push(newName);
			const newPath = pathParts.join('/');
			const newOrigin: FileOrigin = {
				scheme: origin.scheme,
				path: newPath,
				name: newName
			};
			await browserHandleRegistry.register(toURI(newOrigin), resolved);
			return newOrigin;
		} else {
			throw new Error('Renaming is not supported in this browser.');
		}
	}
}

if (typeof window !== 'undefined') {
	(window as any).browserHandleRegistry = browserHandleRegistry;
	(window as any).toURI = toURI;
	(window as any).parseURI = parseURI;
}
