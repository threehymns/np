import '../../../../tests/contract/rune-setup';
import { describe, it, expect, vi } from 'bun:test';
import {
	SettingsManager,
	SettingsResolver,
	EDITOR_SCHEMA,
	UI_SCHEMA,
	CORE_SETTINGS_OWNER,
	createAddSettingSchemaTransform,
	rebuildSettingSchemas,
	applySettingEditToJsonc,
	DuplicateSettingNamespaceError,
	validateSettingValue,
	applyMergeRule,
	type SettingNamespaceSchema,
	type SettingSchemaTransformEntry
} from './settings';
import { PluginHost } from './host.svelte';
import { Preferences, type PreferenceStorage } from '../preferences.svelte';

class MockStorage implements PreferenceStorage {
	data = new Map<string, string>();
	setItemCalls: [string, string][] = [];

	constructor(initial: Record<string, string> = {}) {
		for (const [k, v] of Object.entries(initial)) {
			this.data.set(k, v);
		}
	}

	getItem(key: string): string | null {
		return this.data.has(key) ? this.data.get(key)! : null;
	}

	setItem(key: string, value: string): void {
		this.data.set(key, value);
		this.setItemCalls.push([key, value]);
	}
}

describe('Settings Namespaces & Schema Registry (#198)', () => {
	it('registers schemas and replays deterministically from transforms', () => {
		const transforms: SettingSchemaTransformEntry[] = [
			{
				pluginId: 'plugin-a',
				transform: createAddSettingSchemaTransform({
					namespace: 'git',
					properties: {
						auto_fetch: { type: 'boolean', default: false }
					}
				})
			},
			{
				pluginId: 'plugin-b',
				transform: createAddSettingSchemaTransform({
					namespace: 'terminal',
					properties: {
						font_size: { type: 'number', default: 14 }
					}
				})
			}
		];

		const schemas = rebuildSettingSchemas(transforms);
		expect(schemas.has('git')).toBe(true);
		expect(schemas.has('terminal')).toBe(true);
		expect(schemas.get('git')?.properties.auto_fetch.default).toBe(false);
	});

	it('rejects cross-plugin duplicate namespace registration with actionable error', () => {
		const transforms: SettingSchemaTransformEntry[] = [
			{
				pluginId: 'plugin-a',
				transform: createAddSettingSchemaTransform({
					namespace: 'git',
					properties: { auto_fetch: { type: 'boolean', default: false } }
				})
			},
			{
				pluginId: 'plugin-b',
				transform: createAddSettingSchemaTransform({
					namespace: 'git',
					properties: { auto_fetch: { type: 'boolean', default: true } }
				})
			}
		];

		expect(() => rebuildSettingSchemas(transforms)).toThrow(DuplicateSettingNamespaceError);
	});

	it('allows same-plugin schema update (last-wins)', () => {
		const transforms: SettingSchemaTransformEntry[] = [
			{
				pluginId: 'plugin-a',
				transform: createAddSettingSchemaTransform({
					namespace: 'git',
					properties: { auto_fetch: { type: 'boolean', default: false } }
				})
			},
			{
				pluginId: 'plugin-a',
				transform: createAddSettingSchemaTransform({
					namespace: 'git',
					properties: { auto_fetch: { type: 'boolean', default: true } }
				})
			}
		];

		const schemas = rebuildSettingSchemas(transforms);
		expect(schemas.get('git')?.properties.auto_fetch.default).toBe(true);
	});
});

describe('Layered Settings Resolver & Provenance (#198)', () => {
	const testSchema: SettingNamespaceSchema = {
		namespace: 'test',
		properties: {
			num: { type: 'number', default: 42, minimum: 10, maximum: 100 },
			str: { type: 'string', default: 'hello', enum: ['hello', 'world'] },
			bool: { type: 'boolean', default: true },
			shallowObj: {
				type: 'object',
				default: { a: 1, b: 2 },
				mergeRule: 'shallow'
			},
			deepObj: {
				type: 'object',
				default: { nested: { x: 10, y: 20 }, name: 'default' },
				mergeRule: 'deep'
			},
			customMerge: {
				type: 'array',
				default: ['item1'],
				mergeRule: (def: string[], incoming: string[]) => Array.from(new Set([...def, ...incoming]))
			}
		}
	};

	it('returns default value with provenance: "default" when no user override exists', () => {
		const resolver = new SettingsResolver(
			(ns) => (ns === 'test' ? testSchema : undefined),
			() => ({})
		);

		const resolved = resolver.resolve('test', 'num');
		expect(resolved.value).toBe(42);
		expect(resolved.provenance).toBe('default');
		expect(resolved.source).toBe('default');
		expect(resolved.defaultValue).toBe(42);
	});

	it('returns user value with provenance: "user" when valid override is provided', () => {
		const resolver = new SettingsResolver(
			(ns) => (ns === 'test' ? testSchema : undefined),
			() => ({ test: { num: 99 } })
		);

		const resolved = resolver.resolve('test', 'num');
		expect(resolved.value).toBe(99);
		expect(resolved.provenance).toBe('user');
		expect(resolved.source).toBe('user');
		expect(resolved.defaultValue).toBe(42);
		expect(resolved.userValue).toBe(99);
	});

	it('supports shallow merge rule', () => {
		const resolver = new SettingsResolver(
			(ns) => (ns === 'test' ? testSchema : undefined),
			() => ({ test: { shallowObj: { b: 99, c: 3 } } })
		);

		const resolved = resolver.resolve('test', 'shallowObj');
		expect(resolved.value).toEqual({ a: 1, b: 99, c: 3 });
		expect(resolved.provenance).toBe('user');
	});

	it('supports deep merge rule', () => {
		const resolver = new SettingsResolver(
			(ns) => (ns === 'test' ? testSchema : undefined),
			() => ({ test: { deepObj: { nested: { y: 999 } } } })
		);

		const resolved = resolver.resolve('test', 'deepObj');
		expect(resolved.value).toEqual({ nested: { x: 10, y: 999 }, name: 'default' });
		expect(resolved.provenance).toBe('user');
	});

	it('supports custom merge rule function', () => {
		const resolver = new SettingsResolver(
			(ns) => (ns === 'test' ? testSchema : undefined),
			() => ({ test: { customMerge: ['item2'] } })
		);

		const resolved = resolver.resolve('test', 'customMerge');
		expect(resolved.value).toEqual(['item1', 'item2']);
		expect(resolved.provenance).toBe('user');
	});
});

describe('Invalid Stored Values & Diagnostics (#198)', () => {
	const validationSchema: SettingNamespaceSchema = {
		namespace: 'demo',
		properties: {
			count: { type: 'number', default: 5, minimum: 1, maximum: 10 },
			mode: { type: 'string', default: 'read', enum: ['read', 'write'] }
		}
	};

	it('produces diagnostic on type mismatch and falls back to default without silent reset', () => {
		const stored = { demo: { count: 'not-a-number' } };
		const resolver = new SettingsResolver(
			(ns) => (ns === 'demo' ? validationSchema : undefined),
			() => stored
		);

		const res = resolver.resolve('demo', 'count');
		expect(res.value).toBe(5); // fallback to default
		expect(res.provenance).toBe('default');
		expect(res.diagnostics?.length).toBe(1);
		expect(res.diagnostics![0].severity).toBe('error');
		expect(res.diagnostics![0].receivedValue).toBe('not-a-number');
		// Stored data was not modified
		expect(stored.demo.count).toBe('not-a-number');
	});

	it('produces diagnostic on constraint violation (minimum / maximum / enum)', () => {
		const stored = { demo: { count: 999, mode: 'invalid_mode' } };
		const resolver = new SettingsResolver(
			(ns) => (ns === 'demo' ? validationSchema : undefined),
			() => stored
		);

		const resCount = resolver.resolve('demo', 'count');
		expect(resCount.value).toBe(5);
		expect(resCount.provenance).toBe('default');
		expect(resCount.diagnostics?.[0].message).toContain('exceeds maximum 10');

		const resMode = resolver.resolve('demo', 'mode');
		expect(resMode.value).toBe('read');
		expect(resMode.provenance).toBe('default');
		expect(resMode.diagnostics?.[0].message).toContain('is not one of allowed values');
	});
});

describe('Disabled Plugins & Storage Preservation (#198)', () => {
	it('preserves disabled plugin settings in storage and resolves on re-enablement', async () => {
		const storage = new MockStorage({
			'np-prefs-v2': JSON.stringify({
				editor: { word_wrap: false },
				linter: { enabled: true, max_warnings: 5 }
			})
		});

		const host = new PluginHost();
		const manager = new SettingsManager({ storage });

		// Before linter plugin registers its schema, raw value can still be read
		const rawLinter = manager.resolve('linter', 'enabled');
		expect(rawLinter.value).toBe(true);
		expect(rawLinter.provenance).toBe('user');

		// Modify an active setting and save
		manager.set('editor', 'tab_size', 4);

		// Verify storage still contains linter settings untouched
		const storedAfterEdit = JSON.parse(storage.getItem('np-prefs-v2')!);
		expect(storedAfterEdit.linter).toBeDefined();
		expect(storedAfterEdit.linter.enabled).toBe(true);
		expect(storedAfterEdit.linter.max_warnings).toBe(5);

		// Now plugin is activated and registers its schema
		const linterSchema: SettingNamespaceSchema = {
			namespace: 'linter',
			properties: {
				enabled: { type: 'boolean', default: false },
				max_warnings: { type: 'number', default: 10 }
			}
		};
		manager.registerSchema('linter-plugin', linterSchema);

		// Resolved value now validates against schema
		const resolvedLinter = manager.resolve('linter', 'enabled');
		expect(resolvedLinter.value).toBe(true);
		expect(resolvedLinter.provenance).toBe('user');
		expect(resolvedLinter.schema).toBeDefined();

		// Plugin is deactivated: remove schema
		manager.removePlugin('linter-plugin');
		expect(manager.getSchema('linter')).toBeUndefined();

		// Storage STILL retains the linter setting
		const storedAfterDeactivate = JSON.parse(storage.getItem('np-prefs-v2')!);
		expect(storedAfterDeactivate.linter.enabled).toBe(true);
	});
});

describe('JSONC Comment & Unknown Namespace Preservation (#198)', () => {
	it('preserves comments and unknown namespaces when editing settings', () => {
		const initialJsonc = `{
  // User comments for editor
  "editor": {
    // Keep word wrap true
    "word_wrap": true
  },
  /* Unknown plugin setting */
  "future_plugin": {
    "key": 123
  }
}
`;
		const updated = applySettingEditToJsonc(initialJsonc, ['editor', 'word_wrap'], false);
		expect(updated).toContain('// User comments for editor');
		expect(updated).toContain('// Keep word wrap true');
		expect(updated).toContain('"word_wrap": false');
		expect(updated).toContain('/* Unknown plugin setting */');
		expect(updated).toContain('"future_plugin"');
		expect(updated).toContain('"key": 123');
	});
});

describe('Preferences Migration onto Namespaced Schemas (#198)', () => {
	it('migrates legacy flat preferences into namespaced schemas with zero regression', () => {
		const storage = new MockStorage({
			'np-prefs-v2': JSON.stringify({
				wordWrap: false,
				zoom: 130,
				theme: 'catppuccin-mocha'
			})
		});

		const prefs = new Preferences(storage);

		// Legacy getters work
		expect(prefs.wordWrap).toBe(false);
		expect(prefs.zoom).toBe(130);
		expect(prefs.theme).toBe('catppuccin-mocha');

		// Namespaced resolver works
		const resolvedWrap = prefs.resolve('editor', 'word_wrap');
		expect(resolvedWrap.value).toBe(false);
		expect(resolvedWrap.provenance).toBe('user');

		const resolvedZoom = prefs.resolve('ui', 'zoom');
		expect(resolvedZoom.value).toBe(130);
		expect(resolvedZoom.provenance).toBe('user');

		// Unset preference returns default
		const resolvedVim = prefs.resolve('editor', 'vim_mode');
		expect(resolvedVim.value).toBe(false);
		expect(resolvedVim.provenance).toBe('default');
	});

	it('supports Zed-aligned settings: tab_size and line_numbers', () => {
		const storage = new MockStorage({
			'np-prefs-v2': JSON.stringify({
				editor: {
					tab_size: 4,
					line_numbers: false
				}
			})
		});

		const prefs = new Preferences(storage);
		expect(prefs.tabSize).toBe(4);
		expect(prefs.lineNumbers).toBe(false);

		prefs.tabSize = 8;
		expect(prefs.tabSize).toBe(8);
		expect(prefs.resolve('editor', 'tab_size').value).toBe(8);
		expect(prefs.resolve('editor', 'tab_size').provenance).toBe('user');
	});

	it('exposes diagnostics for invalid stored preference values', () => {
		const storage = new MockStorage({
			'np-prefs-v2': JSON.stringify({
				zoom: 'huge', // invalid type for number
				appearanceMode: 'unsupported' // invalid enum
			})
		});

		const prefs = new Preferences(storage);

		// Defaults are preserved for invalid values
		expect(prefs.zoom).toBe(100);
		expect(prefs.appearanceMode).toBe('system');

		// Diagnostics report the issues
		expect(prefs.diagnostics.length).toBeGreaterThanOrEqual(1);
		const zoomDiag = prefs.diagnostics.find((d) => d.key === 'zoom');
		expect(zoomDiag).toBeDefined();
		expect(zoomDiag?.receivedValue).toBe('huge');

		// Storage is NOT rewritten to erase the user's invalid setting
		expect(storage.setItemCalls.length).toBe(0);
	});
});

describe('Settings schema registry lifecycle (host-owned)', () => {
	function schemaFor(namespace: string): SettingNamespaceSchema {
		return {
			namespace,
			title: namespace,
			properties: {
				enabled: { type: 'boolean', default: false, title: 'Enabled', control: 'toggle' }
			}
		};
	}

	function pluginWithSchema(id: string) {
		return {
			manifest: { id, name: id, version: 0 },
			setup: (host: any) => {
				host.registerSettingSchema(id, schemaFor(id));
			}
		};
	}

	const namespacesOf = (host: PluginHost): string[] =>
		host
			.getSettingSchemas()
			.map((s) => s.namespace)
			.sort();

	it('deactivating one plugin yields the same registry as a clean build without it', async () => {
		const host = new PluginHost();
		host.register(pluginWithSchema('alpha'));
		host.register(pluginWithSchema('beta'));
		await host.activateAll();
		expect(namespacesOf(host)).toEqual(['alpha', 'beta', 'editor', 'ui']);

		await host.deactivate('beta');
		expect(host.getSettingSchema('beta')).toBeUndefined();

		const clean = new PluginHost();
		clean.register(pluginWithSchema('alpha'));
		await clean.activateAll();
		expect(namespacesOf(host)).toEqual(namespacesOf(clean));
	});

	it('refresh-mid-session rebuilds with no duplicates or losses', async () => {
		const host = new PluginHost();
		host.register(pluginWithSchema('alpha'));
		host.register(pluginWithSchema('beta'));
		await host.activateAll();

		const before = namespacesOf(host);
		host.refreshSettings();
		host.rebuildSettings();
		host.refreshSettings();
		expect(namespacesOf(host)).toEqual(before);
		expect(new Set(namespacesOf(host)).size).toBe(namespacesOf(host).length);
		expect(host.getSettingSchema('alpha')?.properties.enabled.default).toBe(false);
	});
});
