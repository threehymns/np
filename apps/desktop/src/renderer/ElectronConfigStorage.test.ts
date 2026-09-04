import '../../../../tests/contract/rune-setup';
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { ElectronConfigStorage } from './ElectronConfigStorage';
import { Preferences } from '../../../../packages/core/src/preferences.svelte';
import { DEFAULT_CONFIG_CONTENT } from '../defaultConfig';

describe('ElectronConfigStorage', () => {
	let mockReadConfigFileSync: ReturnType<typeof mock>;
	let mockWriteConfigFile: ReturnType<typeof mock>;

	// Config writes are dispatched through ElectronConfigStorage's internal async
	// writeQueue (serializes concurrent setItem writes). Tests must yield to the
	// event loop for the queue to drain before asserting on writeConfigFile.
	const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

	beforeEach(() => {
		mockReadConfigFileSync = mock(() => null);
		mockWriteConfigFile = mock(async (_content: string) => {});

		(globalThis as any).window = {
			electronAPI: {
				readConfigFileSync: mockReadConfigFileSync,
				writeConfigFile: mockWriteConfigFile
			}
		};
	});

	afterEach(() => {
		delete (globalThis as any).window;
	});

	it('1. Comment preservation: preceding, inline, and trailing comments stay intact when modifying a key', async () => {
		const originalJsonc = `{
  // Header comment explaining zoom
  "zoom": 100, // inline comment on zoom
  /* block comment before theme */
  "theme": "default"
  // Trailing footer comment
}
`;
		mockReadConfigFileSync.mockReturnValue(originalJsonc);

		const storage = new ElectronConfigStorage();
		const prefs = new Preferences(storage);

		expect(prefs.zoom).toBe(100);
		expect(prefs.theme).toBe('default');

		// Modify zoom
		prefs.zoom = 120;
		await flush();

		expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
		const writtenText = mockWriteConfigFile.mock.calls[0][0];

		// Check that comments and structure are preserved
		expect(writtenText).toContain('// Header comment explaining zoom');
		expect(writtenText).toContain('// inline comment on zoom');
		expect(writtenText).toContain('/* block comment before theme */');
		expect(writtenText).toContain('// Trailing footer comment');
		expect(writtenText).toContain('"zoom": 120');
		expect(writtenText).toContain('"theme": "default"');
	});

	it('2. Unknown key preservation: unrecognized keys in config.json remain untouched when modifying settings', async () => {
		const jsoncWithCustomKeys = `{
  "customPluginSetting": {
    "enabled": true,
    "apiEndpoint": "https://example.local"
  },
  "zoom": 100,
  "experimentalFlag": "on"
}
`;
		mockReadConfigFileSync.mockReturnValue(jsoncWithCustomKeys);

		const storage = new ElectronConfigStorage();
		const prefs = new Preferences(storage);

		prefs.wordWrap = false;
		await flush();

		expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
		const writtenText = mockWriteConfigFile.mock.calls[0][0];

		expect(writtenText).toContain('"customPluginSetting"');
		expect(writtenText).toContain('"apiEndpoint": "https://example.local"');
		expect(writtenText).toContain('"experimentalFlag": "on"');
		expect(writtenText).toContain('"wordWrap": false');
	});

	it('3. Syntax-error fallback: invalid JSONC leaves the file untouched and falls back to defaults', () => {
		const invalidJsonc = `{
  "zoom": 120,
  "theme": "unclosed-string
  broken syntax
}
`;
		mockReadConfigFileSync.mockReturnValue(invalidJsonc);

		const storage = new ElectronConfigStorage();
		const prefs = new Preferences(storage);

		// Must fall back to default values in-memory
		expect(prefs.zoom).toBe(100);
		expect(prefs.theme).toBe('default');

		// Modifying preferences in UI must NOT overwrite the user's invalid file on disk
		prefs.zoom = 150;
		prefs.wordWrap = false;

		expect(mockWriteConfigFile).toHaveBeenCalledTimes(0);
	});

	it('4. Identical-write suppression: no write dispatched if updated text is identical to current text', () => {
		const validJsonc = `{
  // User config
  "zoom": 100
}
`;
		mockReadConfigFileSync.mockReturnValue(validJsonc);

		const storage = new ElectronConfigStorage();
		const prefs = new Preferences(storage);

		// Setting an identical value through setter
		prefs.zoom = 100;
		expect(mockWriteConfigFile).toHaveBeenCalledTimes(0);

		// Calling setItem directly with identical data that results in no text diff
		storage.setItem('np-prefs-v2', JSON.stringify({ zoom: 100 }));
		expect(mockWriteConfigFile).toHaveBeenCalledTimes(0);
	});

	it('5. Default template creation: DEFAULT_CONFIG_CONTENT is valid JSONC and parseable', async () => {
		mockReadConfigFileSync.mockReturnValue(DEFAULT_CONFIG_CONTENT);

		const storage = new ElectronConfigStorage();
		const prefs = new Preferences(storage);

		expect(prefs.wordWrap).toBe(true);
		expect(prefs.statusBar).toBe(true);
		expect(prefs.vimMode).toBe(false);
		expect(prefs.zoom).toBe(100);
		expect(prefs.theme).toBe('default');
		expect(prefs.appearanceMode).toBe('system');
		expect(prefs.sidebarVisible).toBe(true);
		expect(prefs.fileIconThemeId).toBe('phosphor');

		// Modify a value and verify template comments are preserved
		prefs.zoom = 110;
		await flush();
		expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
		const writtenText = mockWriteConfigFile.mock.calls[0][0];

		expect(writtenText).toContain('// Controls line wrapping in the editor.');
		expect(writtenText).toContain('// Editor and interface zoom level (percentage).');
		expect(writtenText).toContain('"zoom": 110');
	});

	it('6. Live-reload on external update: updateFromExternal updates cached text and prefs.reload() updates state without reciprocal write', () => {
		const initialJsonc = `{\n  "zoom": 100,\n  "theme": "default"\n}`;
		mockReadConfigFileSync.mockReturnValue(initialJsonc);

		const storage = new ElectronConfigStorage();
		const prefs = new Preferences(storage);

		expect(prefs.zoom).toBe(100);
		expect(prefs.theme).toBe('default');
		expect(mockWriteConfigFile).toHaveBeenCalledTimes(0);

		// External change: zoom changed to 120 and theme changed to "nord"
		const externalJsonc = `{\n  // Externally edited comment\n  "zoom": 120,\n  "theme": "nord"\n}`;
		const isValid = storage.updateFromExternal(externalJsonc);

		expect(isValid).toBe(true);
		expect(storage.getItem('np-prefs-v2')).toContain('"zoom":120');

		// Now simulate App.svelte receiving event and calling prefs.reload()
		prefs.reload();

		expect(prefs.zoom).toBe(120);
		expect(prefs.theme).toBe('nord');

		// Crucial acceptance criterion: reloading preferences does not trigger a reciprocal save back to disk!
		expect(mockWriteConfigFile).toHaveBeenCalledTimes(0);
	});

	it('7. Syntax errors on external update: updateFromExternal detects invalid JSONC, sets syntax error flag, and does not overwrite disk', () => {
		const initialJsonc = `{\n  "zoom": 100\n}`;
		mockReadConfigFileSync.mockReturnValue(initialJsonc);

		const storage = new ElectronConfigStorage();
		const prefs = new Preferences(storage);

		expect(prefs.zoom).toBe(100);

		// External change with syntax error
		const invalidJsonc = `{\n  "zoom": 120,\n  invalid_syntax\n}`;
		const isValid = storage.updateFromExternal(invalidJsonc);

		expect(isValid).toBe(false);
		// Storage should prevent writes because hasSyntaxErrors is true
		storage.setItem('np-prefs-v2', JSON.stringify({ zoom: 150 }));
		expect(mockWriteConfigFile).toHaveBeenCalledTimes(0);
	});

	it('8. Trailing comma tolerance: a legal trailing comma is not treated as a syntax error and settings still load', async () => {
		const jsoncWithTrailingComma = `{
  "zoom": 120,
  "theme": "default",
}
`;
		mockReadConfigFileSync.mockReturnValue(jsoncWithTrailingComma);

		const storage = new ElectronConfigStorage();
		const prefs = new Preferences(storage);

		// The actual stored value (not just the default) must load despite the trailing comma
		expect(prefs.zoom).toBe(120);
		expect(prefs.theme).toBe('default');

		// Writes must still work even though the file has a trailing comma
		prefs.zoom = 140;
		await flush();
		expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
	});

	it('9. Failed write is not treated as persisted: a repeat identical assignment retries rather than being suppressed', async () => {
		const validJsonc = `{\n  "zoom": 100\n}`;
		mockReadConfigFileSync.mockReturnValue(validJsonc);

		// Fail the first write attempt, succeed on subsequent ones
		let failNext = true;
		mockWriteConfigFile.mockImplementation(async (_content: string) => {
			if (failNext) {
				failNext = false;
				throw new Error('disk full');
			}
		});

		const storage = new ElectronConfigStorage();

		const payload = JSON.stringify({ zoom: 120 });
		storage.setItem('np-prefs-v2', payload);
		await flush();
		expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);

		// Identical payload again. Under the old behavior the failed text was
		// cached as persisted, suppressing this write; it must now retry.
		storage.setItem('np-prefs-v2', payload);
		await flush();
		expect(mockWriteConfigFile).toHaveBeenCalledTimes(2);
	});

	it('10. Trailing-comment preservation on insert: adding a preference does not steal an inline trailing comment from the final property', async () => {
		const jsoncWithTrailingCommentOnLast = `{
  "zoom": 100,
  "theme": "default" // This comment belongs to theme
}
`;
		mockReadConfigFileSync.mockReturnValue(jsoncWithTrailingCommentOnLast);

		const storage = new ElectronConfigStorage();
		const prefs = new Preferences(storage);

		// Add a brand-new preference (wordWrap) not present in the file.
		prefs.wordWrap = false;
		await flush();

		expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
		const writtenText = mockWriteConfigFile.mock.calls[0][0];

		// The inline comment must stay attached to "theme", not the inserted key.
		expect(writtenText).toContain('"theme": "default" // This comment belongs to theme');
		// The new property is present and not carrying the stray comment.
		expect(writtenText).toContain('"wordWrap": false');
		const themeLine = writtenText.split('\n').find((l) => l.includes('"theme"'));
		expect(themeLine).toContain('// This comment belongs to theme');
		const wordWrapLine = writtenText.split('\n').find((l) => l.includes('"wordWrap"'));
		expect(wordWrapLine).not.toContain('// This comment belongs to theme');
	});

	it('11. Concurrent setItem writes: rapid sequential updates serialize correctly without clobbering', async () => {
		const initialJsonc = `{\n  "zoom": 100,\n  "wordWrap": true\n}`;
		mockReadConfigFileSync.mockReturnValue(initialJsonc);

		// Simulate async write delay
		mockWriteConfigFile.mockImplementation(async (_content: string) => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});

		const storage = new ElectronConfigStorage();
		const prefs = new Preferences(storage);

		// Synchronously fire two updates in quick succession before the first async write finishes
		prefs.zoom = 120;
		prefs.wordWrap = false;

		// Wait for both writes in the queue to settle
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(mockWriteConfigFile).toHaveBeenCalledTimes(2);
		const lastWritten = mockWriteConfigFile.mock.calls[1][0];
		expect(lastWritten).toContain('"zoom": 120');
		expect(lastWritten).toContain('"wordWrap": false');
	});

	it('12. Queued write resolution: the newest write wins the final cached state even when the queue frees one write at a time', async () => {
		const initialJsonc = `{\n  "zoom": 100\n}`;
		mockReadConfigFileSync.mockReturnValue(initialJsonc);

		const resolvers: Array<() => void> = [];
		mockWriteConfigFile.mockImplementation(async (_content: string) => {
			await new Promise<void>((resolve) => {
				resolvers.push(resolve);
			});
		});

		const storage = new ElectronConfigStorage();

		// Queue two writes in submission order; the second is newer (zoom=300).
		storage.setItem('np-prefs-v2', JSON.stringify({ zoom: 200 }));
		storage.setItem('np-prefs-v2', JSON.stringify({ zoom: 300 }));

		// Free the serialized chain one in-flight write at a time and let each
		// completion fully settle before the next is dispatched.
		for (let i = 0; i < 2; i++) {
			while (resolvers.length === 0) {
				await new Promise((r) => setTimeout(r, 0));
			}
			resolvers.shift()!();
			await new Promise((r) => setTimeout(r, 0));
			await Promise.resolve();
		}

		// Both writes ran; the final cached text must be the newest (zoom=300).
		expect(mockWriteConfigFile).toHaveBeenCalledTimes(2);
		expect(storage.getItem('np-prefs-v2')).toContain('"zoom":300');
	});
});
