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

		expect(mockSaveFileDialog).toHaveBeenCalled();
		expect(mockWriteFile).toHaveBeenCalledWith('/tmp/notes/new-file.md', 'hello');
		expect(origin).toEqual({ scheme: 'file', path: '/tmp/notes/new-file.md', name: 'new-file.md' });
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
