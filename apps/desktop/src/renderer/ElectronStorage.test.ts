import '../../../../tests/contract/rune-setup';
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { ElectronStorage } from './ElectronStorage';

describe('ElectronStorage.saveFile', () => {
	let mockSaveFileDialog: ReturnType<typeof mock>;
	let mockWriteFile: ReturnType<typeof mock>;

	beforeEach(() => {
		mockSaveFileDialog = mock(async () => '/tmp/notes/new-file.md');
		mockWriteFile = mock(async (_path: string, _content: string) => {});

		(globalThis as any).window = {
			electronAPI: {
				saveFileDialog: mockSaveFileDialog,
				writeFile: mockWriteFile
			}
		};
	});

	afterEach(() => {
		delete (globalThis as any).window;
	});

	it('saves untitled file via save dialog and returns a FileOrigin', async () => {
		const storage = new ElectronStorage();
		const origin = await storage.saveFile('hello', undefined);

		expect(mockSaveFileDialog).toHaveBeenCalledWith({ defaultPath: 'untitled.md' });
		expect(mockWriteFile).toHaveBeenCalledWith('/tmp/notes/new-file.md', 'hello');
		expect(origin).toEqual({ scheme: 'file', path: '/tmp/notes/new-file.md', name: 'new-file.md' });
	});

	it('roots the save dialog at the workspace folder with the draft title', async () => {
		const storage = new ElectronStorage();
		const origin = await storage.saveFile('hello', undefined, {
			suggestedName: 'My Draft.md',
			startDirectory: { scheme: 'file', path: '/tmp/notes', name: 'notes' }
		});

		expect(mockSaveFileDialog).toHaveBeenCalledWith({ defaultPath: '/tmp/notes/My Draft.md' });
		expect(mockWriteFile).toHaveBeenCalledWith('/tmp/notes/new-file.md', 'hello');
		expect(origin).toEqual({ scheme: 'file', path: '/tmp/notes/new-file.md', name: 'new-file.md' });
	});

	it('falls back to the suggested name alone when no workspace folder is open', async () => {
		const storage = new ElectronStorage();
		await storage.saveFile('hello', undefined, { suggestedName: 'Untitled 1.md' });

		expect(mockSaveFileDialog).toHaveBeenCalledWith({ defaultPath: 'Untitled 1.md' });
	});

	it('returns null and writes nothing when the save dialog is cancelled', async () => {
		mockSaveFileDialog.mockResolvedValueOnce(null);
		const storage = new ElectronStorage();
		const origin = await storage.saveFile('hello', undefined);

		expect(origin).toBeNull();
		expect(mockWriteFile).not.toHaveBeenCalled();
	});

	it('writes directly without a dialog when an origin exists', async () => {
		const storage = new ElectronStorage();
		const existing = { scheme: 'file', path: '/tmp/notes/existing.md', name: 'existing.md' };
		const origin = await storage.saveFile('updated', existing);

		expect(mockSaveFileDialog).not.toHaveBeenCalled();
		expect(mockWriteFile).toHaveBeenCalledWith('/tmp/notes/existing.md', 'updated');
		expect(origin).toEqual(existing);
	});
});

describe('ElectronStorage.readFile and readDirectory error normalization', () => {
	let mockReadFile: ReturnType<typeof mock>;
	let mockReadDirectory: ReturnType<typeof mock>;

	beforeEach(() => {
		mockReadFile = mock(async () => new Uint8Array());
		mockReadDirectory = mock(async () => []);

		(globalThis as any).window = {
			electronAPI: {
				readFile: mockReadFile,
				readDirectory: mockReadDirectory
			}
		};
	});

	afterEach(() => {
		delete (globalThis as any).window;
	});

	it('normalizes a resolved not-found marker from readFile to NotFoundError with ENOENT code', async () => {
		// Main resolves with a marker instead of rejecting (no handler error log).
		mockReadFile.mockResolvedValueOnce({
			name: 'NotFoundError',
			code: 'ENOENT',
			message: "ENOENT: no such file or directory, open '/tmp/notes/deleted.md'"
		});
		const storage = new ElectronStorage();
		const origin = { scheme: 'file', path: '/tmp/notes/deleted.md', name: 'deleted.md' };

		let err: any;
		try {
			await storage.readFile(origin);
		} catch (e) {
			err = e;
		}
		expect(err).toBeDefined();
		expect((err as any).name).toBe('NotFoundError');
		expect((err as any).code).toBe('ENOENT');
		expect((err as any).message).toContain('ENOENT');
	});

	it('normalizes a rejected Electron IPC ENOENT error in readFile to NotFoundError with ENOENT code', async () => {
		mockReadFile.mockRejectedValueOnce(
			new Error("Error invoking remote method 'fs:readFile': Error: ENOENT: no such file or directory, open '/tmp/notes/deleted.md'")
		);
		const storage = new ElectronStorage();
		const origin = { scheme: 'file', path: '/tmp/notes/deleted.md', name: 'deleted.md' };

		let err: any;
		try {
			await storage.readFile(origin);
		} catch (e) {
			err = e;
		}
		expect(err).toBeDefined();
		expect((err as any).name).toBe('NotFoundError');
		expect((err as any).code).toBe('ENOENT');
	});

	it('normalizes a resolved not-found marker from readDirectory to NotFoundError with ENOENT code', async () => {
		mockReadDirectory.mockResolvedValueOnce({
			name: 'NotFoundError',
			code: 'ENOENT',
			message: "ENOENT: no such file or directory, scandir '/tmp/notes/missing'"
		});
		const storage = new ElectronStorage();
		const origin = { scheme: 'file', path: '/tmp/notes/missing', name: 'missing' };

		let err: any;
		try {
			await storage.readDirectory(origin);
		} catch (e) {
			err = e;
		}
		expect(err).toBeDefined();
		expect((err as any).name).toBe('NotFoundError');
		expect((err as any).code).toBe('ENOENT');
	});

	it('normalizes Electron IPC ENOENT error in readDirectory to NotFoundError with ENOENT code', async () => {
		mockReadDirectory.mockRejectedValueOnce(
			new Error("Error invoking remote method 'fs:readDirectory': Error: ENOENT: no such file or directory, scandir '/tmp/notes/missing'")
		);
		const storage = new ElectronStorage();
		const origin = { scheme: 'file', path: '/tmp/notes/missing', name: 'missing' };

		let err: any;
		try {
			await storage.readDirectory(origin);
		} catch (e) {
			err = e;
		}
		expect(err).toBeDefined();
		expect((err as any).name).toBe('NotFoundError');
		expect((err as any).code).toBe('ENOENT');
	});

	it('passes through non-ENOENT errors in readFile unchanged', async () => {
		const original = new Error('EACCES: permission denied');
		mockReadFile.mockRejectedValueOnce(original);
		const storage = new ElectronStorage();
		const origin = { scheme: 'file', path: '/tmp/notes/locked.md', name: 'locked.md' };

		await expect(storage.readFile(origin)).rejects.toBe(original);
	});
});
