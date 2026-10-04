import { describe, expect, it } from 'bun:test';
import { lspEnabledFor, lspDisabledReason } from './lsp-gate';
import { EDITOR_COMPLETION_DEFAULTS, LSP_SETTING } from '../settings';
import { SETTINGS_READER_SERVICE_KEY } from '../services';
import type { SettingsRead } from '../services';

/**
 * The `editor.lsp` gate as a pure function of a resolved settings read.
 *
 * The lifecycle suite proves what the gate *does* — no start, no sync, no
 * diagnostics — against a real process. This proves the resolution itself, which
 * is the part that has to agree with the editor's own reader: both fold
 * `editor.languages` over the editor-level value, and a divergence between the
 * two would show as a language that stops offering completions without stopping
 * its server, or the reverse.
 */
function reader(store: Record<string, Record<string, unknown>>): SettingsRead {
	return (namespace, key) => store[namespace]?.[key];
}

describe('Reading editor.lsp for one language (#263)', () => {
	it('is on by default, which is the documented default rather than an accident', () => {
		expect(lspEnabledFor(reader({}), 'TypeScript')).toBe(EDITOR_COMPLETION_DEFAULTS.lsp);
		expect(EDITOR_COMPLETION_DEFAULTS.lsp).toBe(true);
	});

	it('honours the editor-level value', () => {
		expect(lspEnabledFor(reader({ editor: { lsp: false } }), 'TypeScript')).toBe(false);
		expect(lspEnabledFor(reader({ editor: { lsp: true } }), 'TypeScript')).toBe(true);
	});

	it('honours a per-language override, and only for that language', () => {
		const read = reader({ editor: { languages: { TSX: { lsp: false } } } });
		expect(lspEnabledFor(read, 'TSX')).toBe(false);
		// The sibling languages share a process with TSX and are independent answers.
		expect(lspEnabledFor(read, 'TypeScript')).toBe(true);
		expect(lspEnabledFor(read, 'JSX')).toBe(true);
	});

	it('lets a per-language override re-enable a language the editor level turned off', () => {
		const read = reader({ editor: { lsp: false, languages: { TypeScript: { lsp: true } } } });
		expect(lspEnabledFor(read, 'TypeScript')).toBe(true);
		expect(lspEnabledFor(read, 'Markdown')).toBe(false);
	});

	it('matches the language name case-insensitively, as the whole override fold does', () => {
		const read = reader({ editor: { languages: { tsx: { lsp: false } } } });
		expect(lspEnabledFor(read, 'TSX')).toBe(false);
		expect(lspEnabledFor(read, 'TSX ')).toBe(false);
	});

	it('keeps the default for a value the schema would have rejected', () => {
		// `editor.languages` is hand-editable, so `"nonsense"` has to cost the user
		// their setting and nothing else. Only `false` turns a language off — the same
		// narrowing the editor's completion source uses, deliberately.
		for (const value of ['nonsense', 0, null, undefined, {}]) {
			expect(lspEnabledFor(reader({ editor: { lsp: value } }), 'TypeScript')).toBe(true);
		}
		expect(lspEnabledFor(reader({ editor: { lsp: 'no' } }), 'TypeScript')).toBe(true);
	});

	it('keeps the default for a language with no name and for a malformed override map', () => {
		expect(lspEnabledFor(reader({ editor: { lsp: false } }), null)).toBe(false);
		const malformed = reader({ editor: { lsp: false, languages: { TypeScript: 'nope' } } });
		expect(lspEnabledFor(malformed, 'TypeScript')).toBe(false);
		expect(lspEnabledFor(malformed, 'Markdown')).toBe(false);
	});

	it('names the language in the reason, and says what is unaffected', () => {
		// A decline is read by the completion chain and by a user reading the logs, so
		// it has to say which language and that words and notes survive — otherwise a
		// silent popover looks like the whole feature died.
		const reason = lspDisabledReason('TSX');
		expect(reason).toContain('TSX');
		expect(reason).toContain('not scoped to a server');
		expect(reason).toContain('words');
	});
});

/**
 * The publication the gate reads through.
 *
 * Pinned because its absence is silent. `PluginHostInterface.settings` is schemas
 * and nothing else, so resolved values reach a plugin only through this service —
 * and a runtime that finds no reader takes the documented default, which is
 * `lsp: true`. A regression here would therefore not fail loudly; it would put
 * every server back the way this slice took it out, which is the exact bug the
 * gate exists to fix.
 */
describe('The app publishes a resolved settings reader for plugins that must decide', () => {
	it('resolves a stored value through the host, and defaults an absent one', async () => {
		const { AppState } = await import('../../state.svelte');
		const { PluginHost } = await import('../host.svelte');
		const { LANGUAGE_OVERRIDES_SETTING, LSP_SETTING } = await import('../settings');
		const no: never = () => {
			throw new Error('unused in this test');
		};
		const app = new AppState({
			storage: {
				pickFile: no,
				pickDirectory: no,
				saveFile: no,
				readFile: async () => '',
				readDirectory: async () => [],
				verifyPermission: async () => true,
				queryPermission: async () => 'granted',
				createFile: no,
				createDirectory: no,
				deleteEntry: no,
				renameEntry: no
			},
			vcsFactory: no,
			prefsStorage: {
				getItem: (key: string) =>
					key === 'np-prefs-v2'
						? JSON.stringify({ editor: { languages: { TSX: { lsp: false } } } })
						: null,
				setItem: () => {}
			},
			pluginHost: new PluginHost()
		});
		// `AppState.init` publishes the generic collaborator services and registers the
		// core `editor` schema, which is what gives an unset key its documented value.
		await app.init();

		const reader = app.plugins.getService<{ read(ns: string, key: string): unknown }>(
			SETTINGS_READER_SERVICE_KEY
		);
		expect(reader).toBeDefined();
		expect(reader!.read('editor', LSP_SETTING)).toBe(EDITOR_COMPLETION_DEFAULTS.lsp);
		// And the per-language axis resolves for the same reader, which is the whole
		// reason the gate can reach a per-language answer at all.
		expect(
			lspEnabledFor((ns, key) => reader!.read(ns, key), 'TSX')
		).toBe(false);
		expect(
			lspEnabledFor((ns, key) => reader!.read(ns, key), 'TypeScript')
		).toBe(true);

		app.prefs.set('editor', LSP_SETTING, false);
		expect(reader!.read('editor', LSP_SETTING)).toBe(false);
	});

	it('notifies a subscriber when a value changes, because reading is not enough', async () => {
		// The other half of the seam. A consumer that reads on use still waits for
		// its next use, and a plugin's next use is a keystroke — so the switch would
		// take effect whenever the user happened to type next. Which is a switch a
		// user has learned to distrust.
		const { AppState } = await import('../../state.svelte');
		const { PluginHost } = await import('../host.svelte');
		const no: never = () => {
			throw new Error('unused in this test');
		};
		const app = new AppState({
			storage: {
				pickFile: no,
				pickDirectory: no,
				saveFile: no,
				readFile: async () => '',
				readDirectory: async () => [],
				verifyPermission: async () => true,
				queryPermission: async () => 'granted',
				createFile: no,
				createDirectory: no,
				deleteEntry: no,
				renameEntry: no
			},
			vcsFactory: no,
			prefsStorage: { getItem: () => null, setItem: () => {} },
			pluginHost: new PluginHost()
		});
		await app.init();

		const reader = app.plugins.getService<{
			read(ns: string, key: string): unknown;
			subscribe(listener: () => void): () => void;
		}>(SETTINGS_READER_SERVICE_KEY);
		expect(reader).toBeDefined();
		const changes: number[] = [];
		const stop = reader!.subscribe(() => changes.push(app.prefs.settingsVersion));

		app.prefs.set('editor', LSP_SETTING, false);
		expect(changes).toHaveLength(1);
		// The value is already resolved when the notification lands, so a subscriber
		// never has to wonder whether it is reading before or after the write.
		expect(lspEnabledFor((ns, key) => reader!.read(ns, key), 'TypeScript')).toBe(false);

		stop();
		app.prefs.set('editor', LSP_SETTING, true);
		expect(changes).toHaveLength(1);
	});
});
