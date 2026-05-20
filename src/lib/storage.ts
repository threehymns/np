export interface FileOrigin {
	handle: FileSystemFileHandle;
	name: string;
}

export interface Storage {
	pickFile(): Promise<FileOrigin | null>;
	saveFile(content: string, existingOrigin?: FileOrigin): Promise<FileOrigin | null>;
	readFile(origin: FileOrigin): Promise<string>;
	verifyPermission(handle: FileSystemFileHandle, readWrite?: boolean): Promise<boolean>;
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

	async verifyPermission(handle: FileSystemFileHandle, readWrite = false): Promise<boolean> {
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
}
