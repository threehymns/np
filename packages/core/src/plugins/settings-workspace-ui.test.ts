import '../../../../tests/contract/rune-setup';
import { describe, it, expect, beforeEach, mock, spyOn } from 'bun:test';
import {
	SettingsManager,
	SettingsResolver,
	FileWorkspaceSettingsStorage,
	WORKSPACE_SETTINGS_RELATIVE_PATH,
	type SettingNamespaceSchema,
	type WorkspaceSettingsStorage,
	type PreferenceStorageLike
} from './settings';
import { Preferences } from '../preferences.svelte';

class MemoryPreferenceStorage implements PreferenceStorageLike {
	private map = new Map<string, string>();
	getItem(key: string): string | null {
		return this.map.get(key) ?? null;
	}
	setItem(key: string, value: string): void {
		this.map.set(key, value);
	}
}

class MemoryWorkspaceStorage implements WorkspaceSettingsStorage {
	content: string | null = null;
	load(): string | null {
		return this.content;
	}
	save(newContent: string): void {
		this.content = newContent;
	}
}

class MockStorageBackend {
	files = new Map<string, string>();
	dirs = new Set<string>();

	async readFile(origin: { path: string }): Promise<string> {
		if (this.files.has(origin.path)) {
			return this.files.get(origin.path)!;
		}
		throw new Error('Not found');
	}

	async saveFile(content: string, origin: { path: string }): Promise<void> {
		this.files.set(origin.path, content);
	}

	async createDirectory(rootOrigin: { path: string }, dirName: string): Promise<void> {
		this.dirs.add(`${rootOrigin.path}/${dirName}`);
	}
}

describe('Workspace Settings Layering and Scope (#199, ADR 0014)', () => {
	const TEST_SCHEMA: SettingNamespaceSchema = {
		namespace: 'linter',
		title: 'Linter Settings',
		properties: {
			enabled: {
				type: 'boolean',
				default: false,
				title: 'Enable Linter'
			},
			max_warnings: {
				type: 'number',
				default: 10,
				minimum: 0,
				maximum: 100,
				title: 'Max Warnings'
			},
			severity: {
				type: 'string',
				default: 'warning',
				enum: ['info', 'warning', 'error'],
				title: 'Severity'
			},
			rules: {
				type: 'object',
				default: { noUnused: true, semi: true },
				mergeRule: 'shallow',
				title: 'Linter Rules'
			},
			user_only_token: {
				type: 'string',
				default: 'default-secret',
				scope: ['user'],
				title: 'User API Token'
			},
			workspace_only_token: {
				type: 'string',
				default: 'default-workspace',
				scope: ['workspace'],
				title: 'Workspace Token'
			}
		}
	};

	let userStorage: MemoryPreferenceStorage;
	let wsStorage: MemoryWorkspaceStorage;
	let manager: SettingsManager;

	beforeEach(async () => {
		userStorage = new MemoryPreferenceStorage();
		wsStorage = new MemoryWorkspaceStorage();
		manager = new SettingsManager({
			storage: userStorage,
			initialSchemas: [TEST_SCHEMA]
		});
		await manager.attachWorkspaceStorage(wsStorage);
	});

	describe('1. Layering Precedence: Default < User < Workspace', () => {
		it('returns default value and provenance: "default" when no override exists', () => {
			const resolved = manager.resolve('linter', 'enabled');
			expect(resolved.value).toBe(false);
			expect(resolved.provenance).toBe('default');
			expect(resolved.source).toBe('default');
			expect(resolved.defaultValue).toBe(false);
		});

		it('returns user value and provenance: "user" when only user override exists', () => {
			manager.set('linter', 'enabled', true, 'user');

			const resolved = manager.resolve('linter', 'enabled');
			expect(resolved.value).toBe(true);
			expect(resolved.provenance).toBe('user');
			expect(resolved.defaultValue).toBe(false);
			expect(resolved.userValue).toBe(true);
			expect(resolved.workspaceValue).toBeUndefined();
		});

		it('workspace setting overrides user value according to documented precedence', () => {
			// User sets enabled = true, max_warnings = 20
			manager.set('linter', 'enabled', true, 'user');
			manager.set('linter', 'max_warnings', 20, 'user');

			// Workspace overrides enabled = false, leaves max_warnings untouched
			manager.set('linter', 'enabled', false, 'workspace');

			// Check enabled: workspace overrides user
			const enabledResolved = manager.resolve('linter', 'enabled');
			expect(enabledResolved.value).toBe(false);
			expect(enabledResolved.provenance).toBe('workspace');
			expect(enabledResolved.userValue).toBe(true);
			expect(enabledResolved.workspaceValue).toBe(false);

			// Check max_warnings: user value remains effective with provenance 'user'
			const warningsResolved = manager.resolve('linter', 'max_warnings');
			expect(warningsResolved.value).toBe(20);
			expect(warningsResolved.provenance).toBe('user');
			expect(warningsResolved.workspaceValue).toBeUndefined();
		});

		it('targetScope restricts resolution up to user level', () => {
			manager.set('linter', 'enabled', true, 'user');
			manager.set('linter', 'enabled', false, 'workspace');

			// TargetScope 'user' resolves only default < user
			const userView = manager.resolve('linter', 'enabled', 'user');
			expect(userView.value).toBe(true);
			expect(userView.provenance).toBe('user');

			// TargetScope undefined / workspace resolves default < user < workspace
			const effectiveView = manager.resolve('linter', 'enabled');
			expect(effectiveView.value).toBe(false);
			expect(effectiveView.provenance).toBe('workspace');
		});

		it('supports shallow merge rule across user and workspace layers', () => {
			// Default rules: { noUnused: true, semi: true }
			// User rules: { semi: false, explicitType: true }
			// Workspace rules: { semi: true, quotes: 'single' }
			manager.set('linter', 'rules', { semi: false, explicitType: true }, 'user');
			manager.set('linter', 'rules', { semi: true, quotes: 'single' }, 'workspace');

			const resolved = manager.resolve('linter', 'rules');
			expect(resolved.value).toEqual({
				noUnused: true,
				semi: true,
				explicitType: true,
				quotes: 'single'
			});
			expect(resolved.provenance).toBe('workspace');
		});
	});

	describe('2. Invariant: Inherited Values Are Never Materialized (#199)', () => {
		it('setting a workspace value only persists that specific key, never user or default values', () => {
			// User has configured max_warnings = 50
			manager.set('linter', 'max_warnings', 50, 'user');

			// User edits workspace setting: enabled = true
			manager.set('linter', 'enabled', true, 'workspace');

			const wsDoc = manager.getWorkspaceDocument();
			// Workspace document must ONLY contain the explicitly set workspace key
			expect(wsDoc).toEqual({
				linter: {
					enabled: true
				}
			});
			expect(wsDoc.linter.max_warnings).toBeUndefined();
			expect(wsDoc.linter.rules).toBeUndefined();
			expect(wsDoc.linter.severity).toBeUndefined();

			// Raw stored workspace text must not contain inherited keys
			const wsText = manager.getWorkspaceText();
			expect(wsText).toContain('"enabled": true');
			expect(wsText).not.toContain('max_warnings');
		});

		it('unsetting a workspace override removes it cleanly and falls back without materializing', () => {
			manager.set('linter', 'severity', 'error', 'user');
			manager.set('linter', 'severity', 'info', 'workspace');

			expect(manager.resolve('linter', 'severity').value).toBe('info');
			expect(manager.resolve('linter', 'severity').provenance).toBe('workspace');
			expect(manager.hasOverride('linter', 'severity', 'workspace')).toBe(true);

			// Unset workspace override
			manager.unset('linter', 'severity', 'workspace');

			expect(manager.hasOverride('linter', 'severity', 'workspace')).toBe(false);
			const afterUnset = manager.resolve('linter', 'severity');
			expect(afterUnset.value).toBe('error');
			expect(afterUnset.provenance).toBe('user');

			// Workspace document is now empty or has no severity key
			const wsDoc = manager.getWorkspaceDocument();
			expect(wsDoc.linter?.severity).toBeUndefined();
		});
	});

	describe('3. Scope Restrictions (propSchema.scope)', () => {
		it('rejects setting a user-only setting in workspace scope with an actionable error', () => {
			expect(() => {
				manager.set('linter', 'user_only_token', 'my-token', 'workspace');
			}).toThrow('Setting "linter.user_only_token" cannot be configured in workspace scope');
		});

		it('emits diagnostic and falls back when workspace storage contains user-only setting', () => {
			// Workspace file loaded from disk containing user_only_token
			manager.loadWorkspaceFromText(JSON.stringify({
				linter: {
					user_only_token: 'workspace-illegal-token'
				}
			}));

			const diagnostics = manager.getDiagnostics('workspace');
			const restrictedDiag = diagnostics.find(
				(d) => d.namespace === 'linter' && d.key === 'user_only_token'
			);
			expect(restrictedDiag).toBeDefined();
			expect(restrictedDiag?.message).toContain('cannot be configured in workspace scope');

			// Effective value does not adopt the forbidden workspace value
			const resolved = manager.resolve('linter', 'user_only_token');
			expect(resolved.value).toBe('default-secret');
			expect(resolved.provenance).toBe('default');
		});

		it('rejects setting a workspace-only setting in user scope with an actionable error', () => {
			expect(() => {
				manager.set('linter', 'workspace_only_token', 'user-illegal-token', 'user');
			}).toThrow('Setting "linter.workspace_only_token" cannot be configured in user scope');
		});

		it('emits diagnostic and falls back when user storage contains workspace-only setting', () => {
			manager.loadFromText(
				JSON.stringify({ linter: { workspace_only_token: 'user-illegal-token' } })
			);

			const diagnostics = manager.getDiagnostics('user');
			const restrictedDiag = diagnostics.find(
				(d) => d.namespace === 'linter' && d.key === 'workspace_only_token'
			);
			expect(restrictedDiag).toBeDefined();
			expect(restrictedDiag?.message).toContain('cannot be configured in user scope');

			const resolved = manager.resolve('linter', 'workspace_only_token');
			expect(resolved.value).toBe('default-workspace');
			expect(resolved.provenance).toBe('default');
		});
	});

	describe('4. Diagnostics for Invalid Workspace Values', () => {
		it('produces diagnostic on type mismatch and falls back without silent reset', () => {
			manager.set('linter', 'max_warnings', 25, 'user');

			// Invalid string in workspace configuration
			manager.loadWorkspaceFromText(JSON.stringify({
				linter: {
					max_warnings: 'not-a-number'
				}
			}));

			const diags = manager.getDiagnostics('workspace');
			const warningDiag = diags.find((d) => d.namespace === 'linter' && d.key === 'max_warnings');
			expect(warningDiag).toBeDefined();
			expect(warningDiag?.scope).toBe('workspace');

			// Effective value safely falls back to user layer
			const resolved = manager.resolve('linter', 'max_warnings');
			expect(resolved.value).toBe(25);
			expect(resolved.provenance).toBe('user');
			expect(resolved.workspaceValue).toBe('not-a-number');

			// Invalid value remains in workspace document without silent deletion
			expect(manager.getWorkspaceDocument().linter.max_warnings).toBe('not-a-number');
		});

		it('produces diagnostic on constraint violation (enum)', () => {
			manager.loadWorkspaceFromText(JSON.stringify({
				linter: {
					severity: 'critical' // Not in enum: ['info', 'warning', 'error']
				}
			}));

			const diags = manager.getDiagnostics('workspace');
			const enumDiag = diags.find((d) => d.namespace === 'linter' && d.key === 'severity');
			expect(enumDiag).toBeDefined();
			expect(enumDiag?.message).toContain('is not one of allowed values');

			const resolved = manager.resolve('linter', 'severity');
			expect(resolved.value).toBe('warning'); // default
			expect(resolved.provenance).toBe('default');
		});
	});

	describe('5. JSONC Comment & Unknown Namespace Preservation', () => {
		it('preserves JSONC comments and unknown namespaces in workspace settings when editing', async () => {
			const initialJsonc = `// Workspace-specific configuration
{
	/* Custom plugin settings */
	"custom_plugin": {
		"cache_dir": "/tmp/cache"
	},
	"linter": {
		// Enabled flag
		"enabled": false
	}
}`;
			manager.loadWorkspaceFromText(initialJsonc);

			// Edit setting through manager
			manager.set('linter', 'enabled', true, 'workspace');

			const updatedText = manager.getWorkspaceText();
			expect(updatedText).toContain('// Workspace-specific configuration');
			expect(updatedText).toContain('/* Custom plugin settings */');
			expect(updatedText).toContain('"custom_plugin"');
			expect(updatedText).toContain('/tmp/cache');
			expect(updatedText).toContain('"enabled": true');
		});
	});

	describe('6. FileWorkspaceSettingsStorage Adapter', () => {
		it('reads and writes to .np/settings.json at workspace root origin', async () => {
			const mockStorage = new MockStorageBackend();
			const rootOrigin = { scheme: 'file', path: '/home/user/project', name: 'project' };
			const adapter = new FileWorkspaceSettingsStorage(mockStorage, rootOrigin);

			expect(await adapter.load()).toBeNull();

			await adapter.save(JSON.stringify({ linter: { enabled: true } }, null, 2));

			expect(mockStorage.dirs.has('/home/user/project/.np')).toBe(true);
			const expectedPath = `/home/user/project/${WORKSPACE_SETTINGS_RELATIVE_PATH}`;
			expect(mockStorage.files.has(expectedPath)).toBe(true);

			const loaded = await adapter.load();
			expect(loaded).toContain('"enabled": true');
		});

		it('returns null on missing file but propagates other read errors', async () => {
			const rootOrigin = { scheme: 'file', path: '/home/user/project', name: 'project' };
			const missingStorage = {
				readFile: mock(async () => {
					const err = new Error('ENOENT: no such file or directory');
					(err as any).code = 'ENOENT';
					throw err;
				})
			};
			const missingAdapter = new FileWorkspaceSettingsStorage(missingStorage, rootOrigin);
			expect(await missingAdapter.load()).toBeNull();

			const permissionError = new Error('EACCES: permission denied');
			(permissionError as any).code = 'EACCES';
			const failingStorage = {
				readFile: mock(async () => {
					throw permissionError;
				})
			};
			const failingAdapter = new FileWorkspaceSettingsStorage(failingStorage, rootOrigin);
			await expect(failingAdapter.load()).rejects.toThrow('EACCES');
		});

		it('registers settings.json with storage via createFile and saves with that origin', async () => {
			const rootOrigin = { scheme: 'file', path: '/home/user/project', name: 'project' };
			const registeredOrigin = { scheme: 'file', path: '/home/user/project/.np/settings.json', name: 'settings.json', handle: {} };
			let savedOrigin: any = null;

			const mockStorageWithRegistration = {
				createDirectory: mock(async (parent: any, name: string) => ({
					scheme: 'file',
					path: `${parent.path}/${name}`,
					name
				})),
				createFile: mock(async (parent: any, name: string) => registeredOrigin),
				saveFile: mock(async (content: string, origin: any) => {
					savedOrigin = origin;
				}),
				readFile: mock(async () => '{}')
			};

			const adapter = new FileWorkspaceSettingsStorage(mockStorageWithRegistration, rootOrigin);
			await adapter.save('{"test": true}');

			expect(mockStorageWithRegistration.createDirectory).toHaveBeenCalledWith(rootOrigin, '.np');
			expect(mockStorageWithRegistration.createFile).toHaveBeenCalled();
			expect(savedOrigin).toBe(registeredOrigin);
		});
	});

	describe('7. Preferences Integration', () => {
		it('reflects workspace overrides on reactive preferences', async () => {
			const storage = new MemoryPreferenceStorage();
			const prefs = new Preferences(storage);

			// User preference
			prefs.tabSize = 4;
			expect(prefs.tabSize).toBe(4);

			// Workspace override via loadWorkspaceFromText
			prefs.loadWorkspaceFromText(JSON.stringify({
				editor: {
					tab_size: 8
				}
			}));

			expect(prefs.tabSize).toBe(8);
			expect(prefs.hasWorkspaceOverride('editor', 'tab_size')).toBe(true);

			// Clearing workspace restores user preference
			prefs.clearWorkspace();
			expect(prefs.tabSize).toBe(4);
			expect(prefs.hasWorkspaceOverride('editor', 'tab_size')).toBe(false);
		});
	});

	describe('SettingsManager Workspace Concurrency & Error Safety', () => {
		it('clears previous workspace values before loading replacement storage', async () => {
			manager.set('linter', 'enabled', true, 'workspace');

			let finishLoad!: (val: string) => void;
			const delayedLoad = new Promise<string>((resolve) => {
				finishLoad = resolve;
			});
			const replacementStorage: WorkspaceSettingsStorage = {
				load: mock(async () => delayedLoad),
				save: mock(async () => {})
			};

			const loadPromise = manager.attachWorkspaceStorage(replacementStorage);

			expect(manager.getWorkspaceDocument()).toEqual({});
			expect(manager.getWorkspaceText()).toBe('');
			expect(manager.get('linter', 'enabled')).toBe(false);

			finishLoad(JSON.stringify({ linter: { severity: 'error' } }));
			await loadPromise;

			manager.set('linter', 'severity', 'info', 'workspace');
			await manager.saveWorkspace();

			const savedText = replacementStorage.save.mock.calls.at(-1)?.[0];
			expect(JSON.parse(savedText)).toEqual({ linter: { severity: 'info' } });
		});

		it('rejects workspace writes before replacement storage finishes loading', async () => {
			const pendingManager = new SettingsManager({ initialSchemas: [TEST_SCHEMA] });
			let finishLoad!: (val: string | null) => void;
			const delayedLoad = new Promise<string | null>((resolve) => {
				finishLoad = resolve;
			});
			const pendingStorage: WorkspaceSettingsStorage = {
				load: mock(async () => delayedLoad),
				save: mock(async () => {})
			};

			const loadPromise = pendingManager.attachWorkspaceStorage(pendingStorage);

			expect(() => pendingManager.set('linter', 'enabled', true, 'workspace')).toThrow(
				'Workspace settings storage is not loaded'
			);
			expect(pendingManager.getWorkspaceDocument()).toEqual({});

			finishLoad(null);
			await loadPromise;
		});

		it('discards in-flight load results if clearWorkspace is called before load completes', async () => {
			let finishLoad!: (val: string) => void;
			const delayedLoad = new Promise<string>((resolve) => {
				finishLoad = resolve;
			});

			const mockStorage: WorkspaceSettingsStorage = {
				load: mock(async () => delayedLoad),
				save: mock(async () => {})
			};

			const manager = new SettingsManager();
			manager.registerSchema('core', TEST_SCHEMA);

			const loadPromise = manager.attachWorkspaceStorage(mockStorage);

			// Clear workspace while load is still in-flight
			manager.clearWorkspace();

			// Now complete the delayed load with workspace data
			finishLoad(JSON.stringify({ linter: { enabled: true } }));
			await loadPromise;

			// The stale loaded data must NOT have been applied to manager
			expect(manager.get('linter', 'enabled')).toBe(false);
			expect(manager.isWorkspaceLoaded()).toBe(false);
		});

		it('leaves workspace unloaded after read failure and prevents saveWorkspace from overwriting', async () => {
			const mockStorage: WorkspaceSettingsStorage = {
				load: mock(async () => {
					throw new Error('EACCES: permission denied');
				}),
				save: mock(async () => {})
			};

			const manager = new SettingsManager();
			manager.registerSchema('core', TEST_SCHEMA);

			const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

			await manager.attachWorkspaceStorage(mockStorage);
			expect(manager.isWorkspaceLoaded()).toBe(false);

			// Attempting saveWorkspace should not call storage.save because it was never loaded
			await manager.saveWorkspace();
			expect(mockStorage.save).not.toHaveBeenCalled();

			errorSpy.mockRestore();
		});
	});
});
