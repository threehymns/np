import '../../../../tests/contract/rune-setup';
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { ElectronConfigStorage } from './ElectronConfigStorage';
import { Preferences } from '../../../../packages/core/src/preferences.svelte';
import { DEFAULT_CONFIG_CONTENT } from '../defaultConfig';

describe('ElectronConfigStorage', () => {
	let mockReadConfigFileSync: ReturnType<typeof mock>;
	let mockWriteConfigFile: ReturnType<typeof mock>;

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

	it('1. Comment preservation: preceding, inline, and trailing comments stay intact when modifying a key', () => {
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

	it('2. Unknown key preservation: unrecognized keys in config.json remain untouched when modifying settings', () => {
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

	it('5. Default template creation: DEFAULT_CONFIG_CONTENT is valid JSONC and parseable', () => {
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

	it('8. Trailing comma tolerance: a legal trailing comma is not treated as a syntax error and settings still load', () => {
		const jsoncWithTrailingComma = `{
  "zoom": 100,
  "theme": "default",
}
`;
		mockReadConfigFileSync.mockReturnValue(jsoncWithTrailingComma);

		const storage = new ElectronConfigStorage();
		const prefs = new Preferences(storage);

		expect(prefs.zoom).toBe(100);
		expect(prefs.theme).toBe('default');

		// Writes must still work even though the file has a trailing comma
		prefs.zoom = 120;
		expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
	});
});
