import { isNotFoundError, type StorageProvider, type FileOrigin, type StorageEntry, type SaveFileOptions } from '@np/core';

export class ElectronStorage implements StorageProvider {
	scheme = 'file';

	/**
	 * Converts an ENOENT-shaped IPC result (main resolves with a marker for
	 * expected missing files) or a rejected IPC error into a normalized
	 * NotFoundError the rest of the app recognizes.
	 */
	private toNotFoundError(err: any, originPath: string): Error {
		const notFound = new Error(err?.message || `File not found: ${originPath}`, { cause: err });
		notFound.name = 'NotFoundError';
		(notFound as any).code = 'ENOENT';
		return notFound;
	}

	async pickFile(): Promise<FileOrigin | null> {
		const res = await window.electronAPI.openFile();
		if (!res) return null;
		return {
			scheme: this.scheme,
			path: res.path,
			name: res.name
		};
	}

	async pickDirectory(): Promise<FileOrigin | null> {
		const res = await window.electronAPI.openDirectory();
		if (!res) return null;
		return {
			scheme: this.scheme,
			path: res.path,
			name: res.name
		};
	}

	async saveFile(content: string, existingOrigin?: FileOrigin, options?: SaveFileOptions): Promise<FileOrigin | null> {
		let origin = existingOrigin;
		if (!origin) {
			const suggestedName = options?.suggestedName || 'untitled.md';
			const startDir = options?.startDirectory?.path;
			const separator = startDir?.includes('\\') ? '\\' : '/';
			const defaultPath = startDir
				? `${startDir.replace(/[/\\]+$/, '')}${separator}${suggestedName}`
				: suggestedName;
			const filePath = await window.electronAPI.saveFileDialog({ defaultPath });
			if (!filePath) return null;
			origin = {
				scheme: this.scheme,
				path: filePath,
				name: filePath.split(/[/\\]/).pop() ?? filePath
			};
		}
		await window.electronAPI.writeFile(origin.path, content);
		return origin;
	}

	async readFile(origin: FileOrigin): Promise<string> {
		const result = await window.electronAPI.readFile(origin.path).catch((e: any) => {
			if (isNotFoundError(e)) {
				throw this.toNotFoundError(e, origin.path);
			}
			throw e;
		});
		if (isNotFoundError(result)) {
			throw this.toNotFoundError(result, origin.path);
		}
		return new TextDecoder().decode(result as Uint8Array);
	}

	async readDirectory(origin: FileOrigin): Promise<StorageEntry[]> {
		const result = await window.electronAPI.readDirectory(origin.path).catch((e: any) => {
			if (isNotFoundError(e)) {
				throw this.toNotFoundError(e, origin.path);
			}
			throw e;
		});
		if (isNotFoundError(result)) {
			throw this.toNotFoundError(result, origin.path);
		}
		return (result as Array<{ name: string; kind: 'file' | 'directory'; path: string }>).map(e => ({
			name: e.name,
			kind: e.kind,
			origin: {
				scheme: this.scheme,
				path: e.path,
				name: e.name
			}
		}));
	}

	async verifyPermission(origin: FileOrigin, readWrite?: boolean): Promise<boolean> {
		return true;
	}

	async queryPermission(origin: FileOrigin, readWrite?: boolean): Promise<'granted' | 'prompt' | 'denied'> {
		return 'granted';
	}

	async createFile(parent: FileOrigin, name: string): Promise<FileOrigin> {
		const separator = parent.path.includes('\\') ? '\\' : '/';
		const filePath = parent.path.endsWith(separator) ? `${parent.path}${name}` : `${parent.path}${separator}${name}`;
		await window.electronAPI.writeFile(filePath, '');
		return {
			scheme: this.scheme,
			path: filePath,
			name
		};
	}

	async createDirectory(parent: FileOrigin, name: string): Promise<FileOrigin> {
		const separator = parent.path.includes('\\') ? '\\' : '/';
		const dirPath = parent.path.endsWith(separator) ? `${parent.path}${name}` : `${parent.path}${separator}${name}`;
		await window.electronAPI.createDirectory(dirPath);
		return {
			scheme: this.scheme,
			path: dirPath,
			name
		};
	}

	async deleteEntry(origin: FileOrigin): Promise<void> {
		await window.electronAPI.deleteEntry(origin.path);
	}

	async renameEntry(origin: FileOrigin, newName: string): Promise<FileOrigin> {
		const newPath = await window.electronAPI.renameEntry(origin.path, newName);
		return {
			scheme: this.scheme,
			path: newPath,
			name: newName
		};
	}
}
