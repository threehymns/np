import { describe, test, expect } from 'bun:test';
import { MultiSchemeStorage, type StorageProvider, type FileOrigin, type StorageEntry } from '../src/storage';

class MockStorageProvider implements StorageProvider {
	public calls: { method: string; args: any[] }[] = [];

	constructor(public scheme: string) {}

	async pickFile(): Promise<FileOrigin | null> {
		this.calls.push({ method: 'pickFile', args: [] });
		return { scheme: this.scheme, path: 'picked-file.txt', name: 'picked-file.txt' };
	}

	async pickDirectory(): Promise<FileOrigin | null> {
		this.calls.push({ method: 'pickDirectory', args: [] });
		return { scheme: this.scheme, path: 'picked-dir', name: 'picked-dir' };
	}

	async saveFile(content: string, existingOrigin?: FileOrigin): Promise<FileOrigin | null> {
		this.calls.push({ method: 'saveFile', args: [content, existingOrigin] });
		return existingOrigin || { scheme: this.scheme, path: 'new-saved-file.txt', name: 'new-saved-file.txt' };
	}

	async readFile(origin: FileOrigin): Promise<string> {
		this.calls.push({ method: 'readFile', args: [origin] });
		return `content of ${origin.path}`;
	}

	async readDirectory(origin: FileOrigin): Promise<StorageEntry[]> {
		this.calls.push({ method: 'readDirectory', args: [origin] });
		return [{ name: 'file.txt', kind: 'file', origin: { scheme: this.scheme, path: `${origin.path}/file.txt`, name: 'file.txt' } }];
	}

	async verifyPermission(origin: FileOrigin, readWrite?: boolean): Promise<boolean> {
		this.calls.push({ method: 'verifyPermission', args: [origin, readWrite] });
		return true;
	}

	async queryPermission(origin: FileOrigin, readWrite?: boolean): Promise<'granted' | 'prompt' | 'denied'> {
		this.calls.push({ method: 'queryPermission', args: [origin, readWrite] });
		return 'granted';
	}

	async createFile(parent: FileOrigin, name: string): Promise<FileOrigin> {
		this.calls.push({ method: 'createFile', args: [parent, name] });
		return { scheme: this.scheme, path: `${parent.path}/${name}`, name };
	}

	async createDirectory(parent: FileOrigin, name: string): Promise<FileOrigin> {
		this.calls.push({ method: 'createDirectory', args: [parent, name] });
		return { scheme: this.scheme, path: `${parent.path}/${name}`, name };
	}

	async deleteEntry(origin: FileOrigin): Promise<void> {
		this.calls.push({ method: 'deleteEntry', args: [origin] });
	}

	async renameEntry(origin: FileOrigin, newName: string): Promise<FileOrigin> {
		this.calls.push({ method: 'renameEntry', args: [origin, newName] });
		const pathParts = origin.path.split('/');
		pathParts[pathParts.length - 1] = newName;
		return { scheme: this.scheme, path: pathParts.join('/'), name: newName };
	}
}

describe('MultiSchemeStorage Provider Dispatch and Routing', () => {
	test('throws error when no default scheme is configured', async () => {
		const storage = new MultiSchemeStorage();
		expect(storage.pickFile()).rejects.toThrow('No default scheme configured');
		expect(storage.pickDirectory()).rejects.toThrow('No default scheme configured');
		expect(storage.saveFile('test')).rejects.toThrow('No scheme available for saveFile');
	});

	test('registers providers and routes scheme-less calls to the default provider', async () => {
		const storage = new MultiSchemeStorage();
		const browserProvider = new MockStorageProvider('browser');
		const fileProvider = new MockStorageProvider('file');

		storage.registerProvider('browser', browserProvider);
		storage.registerProvider('file', fileProvider);

		// First registered scheme defaults to defaultScheme if not specified
		// Let's verify defaults
		const pickedFile = await storage.pickFile();
		expect(pickedFile).toEqual({ scheme: 'browser', path: 'picked-file.txt', name: 'picked-file.txt' });
		expect(browserProvider.calls[0]).toEqual({ method: 'pickFile', args: [] });

		const pickedDir = await storage.pickDirectory();
		expect(pickedDir).toEqual({ scheme: 'browser', path: 'picked-dir', name: 'picked-dir' });
		expect(browserProvider.calls[1]).toEqual({ method: 'pickDirectory', args: [] });

		const savedFile = await storage.saveFile('content');
		expect(savedFile).toEqual({ scheme: 'browser', path: 'new-saved-file.txt', name: 'new-saved-file.txt' });
		expect(browserProvider.calls[2]).toEqual({ method: 'saveFile', args: ['content', undefined] });

		// Change default scheme and try again
		storage.setDefaultScheme('file');
		const pickedFile2 = await storage.pickFile();
		expect(pickedFile2).toEqual({ scheme: 'file', path: 'picked-file.txt', name: 'picked-file.txt' });
		expect(fileProvider.calls[0]).toEqual({ method: 'pickFile', args: [] });
	});

	test('routes CRUD operations to target provider based on origin.scheme', async () => {
		const storage = new MultiSchemeStorage();
		const browserProvider = new MockStorageProvider('browser');
		const fileProvider = new MockStorageProvider('file');

		storage.registerProvider('browser', browserProvider);
		storage.registerProvider('file', fileProvider);

		const fileOrigin: FileOrigin = { scheme: 'file', path: '/etc/hosts', name: 'hosts' };
		const browserOrigin: FileOrigin = { scheme: 'browser', path: 'notes/draft.md', name: 'draft.md' };

		// readFile
		const fileContent = await storage.readFile(fileOrigin);
		expect(fileContent).toBe('content of /etc/hosts');
		expect(fileProvider.calls.find(c => c.method === 'readFile')).toEqual({
			method: 'readFile',
			args: [fileOrigin]
		});
		expect(browserProvider.calls.find(c => c.method === 'readFile')).toBeUndefined();

		const browserContent = await storage.readFile(browserOrigin);
		expect(browserContent).toBe('content of notes/draft.md');
		expect(browserProvider.calls.find(c => c.method === 'readFile')).toEqual({
			method: 'readFile',
			args: [browserOrigin]
		});

		// readDirectory
		await storage.readDirectory(fileOrigin);
		expect(fileProvider.calls.find(c => c.method === 'readDirectory')).toEqual({
			method: 'readDirectory',
			args: [fileOrigin]
		});

		// saveFile with origin
		await storage.saveFile('updated', fileOrigin);
		expect(fileProvider.calls.find(c => c.method === 'saveFile')).toEqual({
			method: 'saveFile',
			args: ['updated', fileOrigin]
		});

		// verifyPermission & queryPermission
		await storage.verifyPermission(browserOrigin, true);
		expect(browserProvider.calls.find(c => c.method === 'verifyPermission')).toEqual({
			method: 'verifyPermission',
			args: [browserOrigin, true]
		});

		await storage.queryPermission(browserOrigin, false);
		expect(browserProvider.calls.find(c => c.method === 'queryPermission')).toEqual({
			method: 'queryPermission',
			args: [browserOrigin, false]
		});

		// createFile & createDirectory
		await storage.createFile(fileOrigin, 'new-file.txt');
		expect(fileProvider.calls.find(c => c.method === 'createFile')).toEqual({
			method: 'createFile',
			args: [fileOrigin, 'new-file.txt']
		});

		await storage.createDirectory(fileOrigin, 'subdir');
		expect(fileProvider.calls.find(c => c.method === 'createDirectory')).toEqual({
			method: 'createDirectory',
			args: [fileOrigin, 'subdir']
		});

		// deleteEntry & renameEntry
		await storage.deleteEntry(browserOrigin);
		expect(browserProvider.calls.find(c => c.method === 'deleteEntry')).toEqual({
			method: 'deleteEntry',
			args: [browserOrigin]
		});

		await storage.renameEntry(browserOrigin, 'new-draft.md');
		expect(browserProvider.calls.find(c => c.method === 'renameEntry')).toEqual({
			method: 'renameEntry',
			args: [browserOrigin, 'new-draft.md']
		});
	});

	test('throws descriptive error when no provider matches the scheme', async () => {
		const storage = new MultiSchemeStorage();
		const browserProvider = new MockStorageProvider('browser');
		storage.registerProvider('browser', browserProvider);

		const alienOrigin: FileOrigin = { scheme: 'alien', path: 'area51', name: 'ufo' };

		expect(storage.readFile(alienOrigin)).rejects.toThrow('No storage provider registered for scheme: alien');
		expect(storage.readDirectory(alienOrigin)).rejects.toThrow('No storage provider registered for scheme: alien');
		expect(storage.verifyPermission(alienOrigin)).rejects.toThrow('No storage provider registered for scheme: alien');
		expect(storage.queryPermission(alienOrigin)).rejects.toThrow('No storage provider registered for scheme: alien');
		expect(storage.createFile(alienOrigin, 'a')).rejects.toThrow('No storage provider registered for scheme: alien');
		expect(storage.createDirectory(alienOrigin, 'b')).rejects.toThrow('No storage provider registered for scheme: alien');
		expect(storage.deleteEntry(alienOrigin)).rejects.toThrow('No storage provider registered for scheme: alien');
		expect(storage.renameEntry(alienOrigin, 'c')).rejects.toThrow('No storage provider registered for scheme: alien');
	});
});
