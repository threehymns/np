export interface FileOrigin {
	handle: FileSystemFileHandle;
	name: string;
}

export interface Storage {
	pickFile(): Promise<FileOrigin | null>;
	saveFile(content: string, existingOrigin?: FileOrigin): Promise<FileOrigin | null>;
	readFile(origin: FileOrigin): Promise<string>;
}

export class FileSystemStorage implements Storage {
	async pickFile(): Promise<FileOrigin | null> {
		try {
			const [handle] = await window.showOpenFilePicker({
				types: [{ description: 'Text Files', accept: { 'text/plain': ['.txt', '.md'] } }],
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
				suggestedName: 'untitled.txt',
				types: [{ description: 'Text Files', accept: { 'text/plain': ['.txt', '.md'] } }]
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
}
