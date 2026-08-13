import type { StorageProvider, FileOrigin, StorageEntry, PermissionState } from '@np/core';

export class ElectronStorage implements StorageProvider {
	scheme = 'file';

	async checkPermission(path: string): Promise<PermissionState> {
		return 'granted';
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

	async saveFile(content: string, existingOrigin?: FileOrigin): Promise<FileOrigin | null> {
		let origin = existingOrigin;
		if (!origin) {
			const picked = await this.pickFile();
			if (!picked) return null;
			origin = picked;
		}
		await window.electronAPI.writeFile(origin.path, content);
		return origin;
	}

	async readFile(origin: FileOrigin): Promise<string> {
		const buffer = await window.electronAPI.readFile(origin.path);
		return new TextDecoder().decode(buffer);
	}

	async readDirectory(origin: FileOrigin): Promise<StorageEntry[]> {
		const entries = await window.electronAPI.readDirectory(origin.path);
		return entries.map(e => ({
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
