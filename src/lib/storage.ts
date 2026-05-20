export interface FileOrigin {
	handle: FileSystemFileHandle;
	name: string;
}

export interface Storage {
	pickFile(): Promise<FileOrigin | null>;
	pickDirectory(): Promise<FileSystemDirectoryHandle | null>;
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
			return { handle, name: handle.name };
		} catch (e) {
			if ((e as Error).name === 'AbortError') return null;
			throw e;
		}
	}

	async pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
		try {
			return await window.showDirectoryPicker();
		} catch (e) {
			if ((e as Error).name === 'AbortError') return null;
			throw e;
		}
	}

	async saveFile(content: string, existingOrigin?: FileOrigin): Promise<FileOrigin | null> {
		try {
			const handle = existingOrigin?.handle ?? await window.showSaveFilePicker({
				suggestedName: 'untitled.md',
				types: [{ description: 'Markdown Files', accept: { 'text/markdown': ['.md'], 'text/plain': ['.txt'] } }]
			});
			
			const writable = await handle.createWritable();
			await writable.write(content);
			await writable.close();
			
			return { handle, name: handle.name };
		} catch (e) {
			if ((e as Error).name === 'AbortError') return null;
			throw e;
		}
	}

	async readFile(origin: FileOrigin): Promise<string> {
		const file = await origin.handle.getFile();
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

		// Check if permission was already granted. If so, return true.
		if ((await handle.queryPermission(options)) === 'granted') {
			return true;
		}

		// Request permission. If the user grants permission, return true.
		if ((await handle.requestPermission(options)) === 'granted') {
			return true;
		}

		// The user didn't grant permission, so return false.
		return false;
	}

	async createFile(parent: FileSystemDirectoryHandle, name: string): Promise<FileSystemFileHandle> {
		return await parent.getFileHandle(name, { create: true });
	}

	async createDirectory(parent: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle> {
		return await parent.getDirectoryHandle(name, { create: true });
	}

	async deleteEntry(parent: FileSystemDirectoryHandle, name: string): Promise<void> {
		// removeEntry is supported in Chrome 86+
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
