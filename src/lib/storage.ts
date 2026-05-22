import { openDB } from './persistence';

export interface FileOrigin {
	scheme: string;
	path: string;
	name: string;
}

export function toURI(origin: FileOrigin): string {
	if (origin.scheme === 'file') {
		return `file://${origin.path.startsWith('/') ? '' : '/'}${origin.path}`;
	}
	return `${origin.scheme}://${origin.path}`;
}

export function parseURI(uriString: string): FileOrigin {
	const idx = uriString.indexOf('://');
	if (idx === -1) {
		throw new Error(`Invalid URI: ${uriString}`);
	}
	const scheme = uriString.slice(0, idx);
	const rest = uriString.slice(idx + 3);
	let path = rest;
	if (scheme === 'file' && !path.startsWith('/')) {
		path = '/' + path;
	}
	const name = path.split('/').pop() || '';
	return { scheme, path, name };
}

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

export interface Storage {
	pickFile(): Promise<FileOrigin | null>;
	pickDirectory(): Promise<FileOrigin | null>;
	saveFile(content: string, existingOrigin?: FileOrigin): Promise<FileOrigin | null>;
	readFile(origin: FileOrigin): Promise<string>;
	readDirectory(handle: FileSystemDirectoryHandle): Promise<FileSystemHandle[]>;
	verifyPermission(handle: FileSystemHandle, readWrite?: boolean): Promise<boolean>;
	createFile(parent: FileSystemDirectoryHandle, name: string): Promise<FileSystemFileHandle>;
	createDirectory(parent: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle>;
	deleteEntry(parent: FileSystemDirectoryHandle, name: string): Promise<void>;
}

export class FileStorage implements Storage {
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
			throw new Error(`Could not resolve file handle for URI: ${uri}`);
		}
		const file = await (resolved as FileSystemFileHandle).getFile();
		return await file.text();
	}

	async readDirectory(handle: FileSystemDirectoryHandle): Promise<FileSystemHandle[]> {
		const entries: FileSystemHandle[] = [];
		for await (const entry of handle.values()) {
			entries.push(entry);
		}
		return entries;
	}

	async verifyPermission(handle: FileSystemHandle, readWrite = false): Promise<boolean> {
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

	async createFile(parent: FileSystemDirectoryHandle, name: string): Promise<FileSystemFileHandle> {
		return await parent.getFileHandle(name, { create: true });
	}

	async createDirectory(parent: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle> {
		return await parent.getDirectoryHandle(name, { create: true });
	}

	async deleteEntry(parent: FileSystemDirectoryHandle, name: string): Promise<void> {
		return await (parent as any).removeEntry(name, { recursive: true });
	}

	async renameEntry(handle: FileSystemHandle, newName: string): Promise<void> {
		if ('move' in handle) {
			return await (handle as any).move(newName);
		} else {
			throw new Error('Renaming is not supported in this browser.');
		}
	}
}
