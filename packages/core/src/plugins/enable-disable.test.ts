import '../../../../tests/contract/rune-setup';
import { describe, it, expect, mock } from 'bun:test';
import { PluginHost } from './host.svelte';
import { gitRegistration } from './git/registration';
import { GIT_PANEL_ID, GIT_STATUS_ID } from './git/ui';
import { DIALOGS_SERVICE_KEY } from './services';
import { SettingsManager, type SettingNamespaceSchema, type WorkspaceSettingsStorage } from './settings';
import type { PluginManifest, PluginRegistration } from './types';
import { Workspace } from '../workspace.svelte';
import { DocumentSession } from '../document.svelte';
import { MemorySessionPersistence } from '../persistence';
import { AppState } from '../state.svelte';
import { toURI } from '../storage';
import type { FileOrigin, Storage } from '../storage';
import type { VCSAdapter } from '../project/vcs';

const rootOrigin: FileOrigin = { scheme: 'file', path: '/repo', name: 'repo' };

interface StorageHarness {
	storage: Storage;
	readDirectory: ReturnType<typeof mock>;
	writeFile: ReturnType<typeof mock>;
}

function createHarnessStorage(initialFiles: Record<string, string> = {}): StorageHarness {
	const files = new Map<string, string>(Object.entries(initialFiles));
	const readDirectory = mock(async () => [] as any[]);
	const writeFile = mock(async (origin: FileOrigin, content: string) => {
		files.set(origin.path, content);
	});
	const storage: Storage = {
		readFile: mock(async (origin: FileOrigin) => {
			const content = files.get(origin.path);
			if (content === undefined) throw new Error(`Not found: ${origin.path}`);
			return content;
		}),
		writeFile,
		saveFile: mock(async (content: string, existingOrigin?: FileOrigin) => {
			const origin = existingOrigin ?? { scheme: 'file', path: '/saved.md', name: 'saved.md' };
			files.set(origin.path, content);
			return origin;
		}),
		openFileDialog: mock(async () => null),
		openDirectoryDialog: mock(async () => null),
		saveFileDialog: mock(async () => null),
		readDirectory,
		exists: mock(async (origin: FileOrigin) => files.has(origin.path)),
		deleteFile: mock(async (origin: FileOrigin) => {
			files.delete(origin.path);
		}),
		deleteDirectory: mock(async () => {}),
		verifyPermission: mock(async () => true),
		queryPermission: mock(async () => 'granted' as const),
		pickFile: mock(async () => null),
		pickDirectory: mock(async () => rootOrigin),
		createFile: mock(async (parent: FileOrigin, name: string) => ({ scheme: 'file', path: `/${name}`, name })),
		createDirectory: mock(async (parent: FileOrigin, name: string) => ({ scheme: 'file', path: `/${name}`, name })),
		deleteEntry: mock(async () => {}),
		renameEntry: mock(async (origin: FileOrigin, newName: string) => ({ scheme: 'file', path: `/${newName}`, name: newName }))
	};
	return { storage, readDirectory, writeFile };
}

interface VcsCounters {
	factory: number;
	detect: number;
	init: number;
	getChanges: number;
}

function createCountingVcsFactory(counters: VcsCounters, options: { detected?: boolean; initGate?: () => Promise<void> } = {}) {
	return () => {
		counters.factory++;
		const adapter: VCSAdapter = {
			detect: mock(async () => {
				counters.detect++;
				return options.detected ?? true;
			}),
			getCurrentBranch: async () => 'main',
			getBranches: async () => ['main'],
			getChanges: mock(async () => {
				counters.getChanges++;
				return [];
			}),
			getCommits: async () => [],
			getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
			switchBranch: mock(async () => ({ status: 'switched' as const }))
		};
		if (options.initGate) {
			const gate = options.initGate;
			(adapter as any).init = mock(async () => {
				counters.init++;
				await gate();
			});
		}
		return adapter;
	};
}

function provideDialogs(host: PluginHost, confirmResult = true) {
	host.provideService(DIALOGS_SERVICE_KEY, {
		alert: mock(async () => {}),
		confirm: mock(async () => confirmResult)
	});
}

function createPrefsBacking() {
	const map = new Map<string, string>();
	return {
		getItem: (key: string): string | null => map.get(key) ?? null,
		setItem: (key: string, value: string): void => {
			map.set(key, value);
		},
		snapshot: () => new Map(map)
	};
}

async function tick(times = 5) {
	for (let i = 0; i < times; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

describe('Enable/disable plus cascade UX and off-state verification (#204)', () => {
	describe('off-state proof: zero Git runtime activity with the plugin disabled', () => {
		it('never initializes, scans, refreshes, or contributes while ordinary editing works', async () => {
			const host = new PluginHost();
			host.register(gitRegistration);
			provideDialogs(host);
			// NOTE: git is registered but NEVER activated.
			const counters: VcsCounters = { factory: 0, detect: 0, init: 0, getChanges: 0 };
			const { storage, readDirectory } = createHarnessStorage({ '/repo/notes.md': 'saved content' });
			const workspace = new Workspace(
				storage,
				createCountingVcsFactory(counters),
				new MemorySessionPersistence(),
				host
			);

			// Browse a folder: workspace-owned tree scan runs, Git stays out.
			await workspace.openDirectory();
			expect(workspace.repository).toBeNull();
			expect(readDirectory).toHaveBeenCalled();
			expect(counters.factory).toBe(0);
			expect(counters.detect).toBe(0);

			// Open, type, save: ordinary editing works unaffected.
			const fileOrigin: FileOrigin = { scheme: 'file', path: '/repo/notes.md', name: 'notes.md' };
			const doc = new DocumentSession(storage, 'saved content', fileOrigin);
			doc.content = 'edited content';
			const saved = await workspace.saveDocument(doc);
			expect(saved).toBe(true);

			// Zero Git runtime activity: no init, scans, or refreshes.
			expect(counters.factory).toBe(0);
			expect(counters.detect).toBe(0);
			expect(counters.init).toBe(0);
			expect(counters.getChanges).toBe(0);
			expect(workspace.repository).toBeNull();

			// Zero contributions: no commands, panels, status, or decorations.
			expect(host.getCommand('git.init')).toBeUndefined();
			expect(host.getCommand('git.stage')).toBeUndefined();
			expect(host.getCommandsByCategory('Source Control')).toHaveLength(0);
			expect(host.executeCommand('git.stage', 'x')).toBeUndefined();
			expect(host.getSidebarPanel(GIT_PANEL_ID)).toBeUndefined();
			expect(host.getSidebarPanels().some((p) => p.pluginId === 'git')).toBe(false);
			expect(host.getStatusBarItem(GIT_STATUS_ID)).toBeUndefined();
			expect(host.getStatusBarItems().some((s) => s.pluginId === 'git')).toBe(false);
			expect(host.getEditorContributions().some((e) => e.pluginId === 'git')).toBe(false);
			expect(host.getSettingSchema('git')).toBeUndefined();
		});

		it('stays off across AppState init until explicitly enabled (persisted enablement)', async () => {
			const prefsBacking = createPrefsBacking();
			const host = new PluginHost();
			host.register(gitRegistration);
			const { storage } = createHarnessStorage();
			const counters: VcsCounters = { factory: 0, detect: 0, init: 0, getChanges: 0 };
			const app = new AppState({
				storage,
				vcsFactory: createCountingVcsFactory(counters),
				prefsStorage: prefsBacking,
				pluginHost: host
			});

			await app.setPluginEnabled('git', false);
			expect(host.isPluginActive('git')).toBe(false);

			// A fresh AppState over the same storage keeps Git off.
			const host2 = new PluginHost();
			host2.register(gitRegistration);
			const app2 = new AppState({
				storage,
				vcsFactory: createCountingVcsFactory(counters),
				prefsStorage: prefsBacking,
				pluginHost: host2
			});
			await app2.init();
			expect(host2.isPluginActive('git')).toBe(false);
			expect(app2.isPluginEnabled('git')).toBe(false);
			expect(host2.getCommand('git.init')).toBeUndefined();
		});

		it('does not restore a persisted Git diff view while disabled', async () => {
			const prefsBacking = createPrefsBacking();
			const host = new PluginHost();
			host.register(gitRegistration);
			const { storage } = createHarnessStorage();
			const persistence = new MemorySessionPersistence();
			const app = new AppState({
				storage,
				vcsFactory: createCountingVcsFactory({ factory: 0, detect: 0, init: 0, getChanges: 0 }),
				persistence,
				prefsStorage: prefsBacking,
				pluginHost: host
			});
			await app.setPluginEnabled('git', false);

			const folderUri = toURI(rootOrigin);
			await persistence.saveRootFolder(rootOrigin);
			await persistence.saveOpenFiles(
				[{ id: '__project_diff__', origin: null, isModified: false, virtualTabType: 'diff', pluginId: 'git' }],
				folderUri
			);
			await persistence.saveActiveDocumentId('__project_diff__', folderUri);

			await app.init();

			expect(host.isPluginActive('git')).toBe(false);
			expect(app.workspace.tabs.some((tab) => tab.type === 'diff')).toBe(false);
			expect(app.activeTabId).not.toBe('__project_diff__');
		});
	});

describe('toggle off/on round trip restores full function without restart', () => {
		async function makeApp() {
			const prefsBacking = createPrefsBacking();
			const host = new PluginHost();
			host.register(gitRegistration);
			const { storage } = createHarnessStorage({ '/repo/notes.md': 'saved content' });
			const counters: VcsCounters = { factory: 0, detect: 0, init: 0, getChanges: 0 };
			const app = new AppState({
				storage,
				vcsFactory: createCountingVcsFactory(counters),
				prefsStorage: prefsBacking,
				pluginHost: host
			});
			await app.init();
			return { app, host, storage, counters, prefsBacking };
		}

		it('toggles Git off and on live with full function restored', async () => {
			const { app, host } = await makeApp();
			expect(host.isPluginActive('git')).toBe(true);

			await app.workspace.openDirectory();
			expect(app.workspace.repository).not.toBeNull();
			expect(host.getCommand('git.stage')).toBeDefined();
			expect(host.getSidebarPanel(GIT_PANEL_ID)).toBeDefined();
			app.activeSidebarTab = GIT_PANEL_ID;
			expect(app.activeSidebarTab).toBe(GIT_PANEL_ID);

			// Toggle off: everything Git vanishes without restart.
			await app.setPluginEnabled('git', false);
			expect(host.isPluginActive('git')).toBe(false);
			expect(host.getPluginState('git')).toBe('inactive');
			expect(app.workspace.repository).toBeNull();
			expect(host.getCommand('git.stage')).toBeUndefined();
			expect(host.getCommandsByCategory('Source Control')).toHaveLength(0);
			expect(host.getSidebarPanel(GIT_PANEL_ID)).toBeUndefined();
			expect(host.getStatusBarItem(GIT_STATUS_ID)).toBeUndefined();
			expect(host.getEditorContributions().some((e) => e.pluginId === 'git')).toBe(false);
			expect(app.activeSidebarTab).toBe('explorer');

			// Ordinary editing still works while off.
			const fileOrigin: FileOrigin = { scheme: 'file', path: '/repo/notes.md', name: 'notes.md' };
			const doc = new DocumentSession(app.workspace.storage, 'saved content', fileOrigin);
			doc.content = 'edited while off';
			expect(await app.workspace.saveDocument(doc)).toBe(true);

			// Generic hunk navigation is core-owned, so it survives with Git
			// off: commands exist, gate on the mounted navigator, and dispatch.
			expect(host.getCommand('diff.nextHunk')).toBeDefined();
			expect(host.getCommand('diff.prevHunk')).toBeDefined();
			expect(host.getCommand('git.nextHunk')).toBeUndefined();
			expect(host.getCommand('diff.nextHunk')?.isEnabled?.()).toBe(false);
			let navigated = 0;
			app.activeDiffNavigator = {
				nextHunk: () => {
					navigated++;
				},
				prevHunk: () => {
					navigated++;
				}
			};
			expect(host.getCommand('diff.nextHunk')?.isEnabled?.()).toBe(true);
			host.executeCommand('diff.nextHunk');
			expect(navigated).toBe(1);
			app.activeDiffNavigator = undefined;

			// Toggle on: full function restored without restart.
			await app.setPluginEnabled('git', true);
			expect(host.isPluginActive('git')).toBe(true);
			expect(host.getCommand('git.stage')).toBeDefined();
			expect(host.getSidebarPanel(GIT_PANEL_ID)).toBeDefined();
			expect(host.getStatusBarItem(GIT_STATUS_ID)).toBeDefined();
			expect(host.getEditorContributions().some((e) => e.pluginId === 'git')).toBe(true);
			expect(app.workspace.repository).not.toBeNull();
			expect(app.workspace.repository?.currentBranch).toBe('main');

			await app.workspace.openDirectory();
			expect(app.workspace.repository).not.toBeNull();
			expect(app.workspace.repository?.currentBranch).toBe('main');
		});

		it('closes Git-owned diff views on disable and keeps them closed on re-enable', async () => {
			const { app } = await makeApp();
			await app.workspace.openDirectory();
			await app.commands.execute('git.openDiff');
			expect(app.workspace.tabs.some((tab) => tab.type === 'diff')).toBe(true);
			expect(app.workspace.tabs.find((tab) => tab.id === '__project_diff__')?.pluginId).toBe('git');

			await app.setPluginEnabled('git', false);
			expect(app.workspace.tabs.some((tab) => tab.type === 'diff')).toBe(false);
			expect(app.activeTabId).not.toBe('__project_diff__');
			const saved = await app.workspace.persistence.loadOpenFiles(toURI(app.workspace.rootOrigin!));
			expect(saved.some((entry) => entry.pluginId === 'git')).toBe(false);

			await app.setPluginEnabled('git', true);
			expect(app.workspace.tabs.some((tab) => tab.type === 'diff')).toBe(false);
		});

		it('preserves unsaved drafts across the round trip', async () => {
			const { app, host } = await makeApp();
			await app.workspace.openDirectory();
			const folderUri = toURI(app.workspace.rootOrigin!);

			// Open through the workspace so the tab is tracked, then type so
			// the draft is persisted (not just live in memory).
			const fileOrigin: FileOrigin = { scheme: 'file', path: '/repo/notes.md', name: 'notes.md' };
			const doc = await app.workspace.openFile(fileOrigin);
			expect(doc).toBeDefined();
			app.workspace.updateDocumentContent(doc!, 'unsaved draft edits');
			await app.workspace.flushSaveOpenFiles();

			// The draft is on disk in session persistence before the toggle.
			const persisted = await app.workspace.persistence.loadOpenFiles(folderUri);
			const entry = persisted.find((s) => s.origin?.path === '/repo/notes.md');
			expect(entry?.draftContent).toBe('unsaved draft edits');

			await app.setPluginEnabled('git', false);
			expect(host.isPluginActive('git')).toBe(false);

			await app.setPluginEnabled('git', true);
			expect(host.isPluginActive('git')).toBe(true);

			// Destroy the live session and reload through the real restore
			// path: content must come back from persistence, not the old object.
			app.workspace.documents = [];
			app.workspace.tabs = [];
			await app.workspace.loadFolderState(folderUri);
			await tick();

			const restored = app.workspace.documents.find((d) => d.origin?.path === '/repo/notes.md');
			expect(restored).toBeDefined();
			expect(restored).not.toBe(doc);
			expect(restored!.content).toBe('unsaved draft edits');
			expect(restored!.isModified).toBe(true);

			expect(await app.workspace.saveDocument(restored!)).toBe(true);
			expect(restored!.isModified).toBe(false);
		});
	});

	describe('disabled-plugin settings survive untouched (ADR 0014)', () => {
		const FIXTURE_SCHEMA: SettingNamespaceSchema = {
			namespace: 'fixture',
			title: 'Fixture',
			description: 'Test fixture settings',
			properties: {
				autosave: { type: 'boolean', default: false, title: 'Autosave', control: 'toggle' },
				nickname: { type: 'string', default: 'np', title: 'Nickname', control: 'input' }
			}
		};

		function fixtureRegistration(): PluginRegistration {
			return {
				manifest: { id: 'fixture', name: 'Fixture', version: 0 },
				setup: (host) => {
					host.registerSettingSchema('fixture', FIXTURE_SCHEMA);
				}
			};
		}

		class MemoryPreferenceStorage {
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

		it('preserves stored values while the schema is gone, then resolves identically on re-enable', async () => {
			const host = new PluginHost();
			host.register(fixtureRegistration());
			await host.activate('fixture');

			const userStorage = new MemoryPreferenceStorage();
			const wsStorage = new MemoryWorkspaceStorage();
			const manager = new SettingsManager({
				storage: userStorage,
				storageKey: 'np-test-204',
				schemaRegistry: host.settings
			});
			// Attach workspace storage deterministically: the constructor
			// kicks off an async load, so attach-then-set avoids racing it.
			await manager.attachWorkspaceStorage(wsStorage);

			manager.set('fixture', 'autosave', true, 'user');
			manager.set('fixture', 'nickname', 'workspace-nick', 'workspace');
			expect(manager.get('fixture', 'autosave')).toBe(true);
			expect(manager.get('fixture', 'nickname')).toBe('workspace-nick');

			const userBefore = JSON.stringify(manager.getStoredDocument());
			const workspaceBefore = JSON.stringify(manager.getWorkspaceDocument());

			await host.deactivate('fixture');

			// Schema gone from the registry...
			expect(host.getSettingSchema('fixture')).toBeUndefined();
			// ...but stored data untouched (never garbage-collected).
			expect(JSON.stringify(manager.getStoredDocument())).toBe(userBefore);
			expect(JSON.stringify(manager.getWorkspaceDocument())).toBe(workspaceBefore);
			expect(manager.getStoredDocument().fixture.autosave).toBe(true);
			expect(manager.getWorkspaceDocument().fixture.nickname).toBe('workspace-nick');

			await host.activate('fixture');

			// Schema restored and values resolve identically, no silent reset.
			expect(host.getSettingSchema('fixture')).toBeDefined();
			expect(manager.get('fixture', 'autosave')).toBe(true);
			expect(manager.get('fixture', 'nickname')).toBe('workspace-nick');
			expect(manager.getDiagnostics()).toHaveLength(0);
		});

		it('exposes plugin schemas to the generated settings UI through AppState', async () => {
			const prefsBacking = createPrefsBacking();
			const host = new PluginHost();
			host.register(gitRegistration);
			host.register(fixtureRegistration());
			const { storage } = createHarnessStorage();
			const counters: VcsCounters = { factory: 0, detect: 0, init: 0, getChanges: 0 };
			const app = new AppState({
				storage,
				vcsFactory: createCountingVcsFactory(counters),
				prefsStorage: prefsBacking,
				pluginHost: host
			});

			await host.activate('fixture');
			expect(app.prefs.settings.getSchema('fixture')).toBeDefined();

			// The generated UI lists non-core namespaces; fixture flows through.
			const pluginNamespaces = app.prefs.settings
				.getAllSchemas()
				.map((s) => s.namespace)
				.filter((ns) => ns !== 'editor' && ns !== 'ui');
			expect(pluginNamespaces).toContain('fixture');

			await host.deactivate('fixture');
			expect(app.prefs.settings.getSchema('fixture')).toBeUndefined();
		});
	});

	describe('disable during an active write shows a blocked state (ADR 0009)', () => {
		it('reports deactivating while the write finishes, then drops the stale result', async () => {
			let releaseInit!: () => void;
			const initGate = new Promise<void>((resolve) => (releaseInit = resolve));
			let initCalled = false;
			const host = new PluginHost();
			host.register(gitRegistration);
			const counters: VcsCounters = { factory: 0, detect: 0, init: 0, getChanges: 0 };
			const { storage } = createHarnessStorage();
			const workspace = new Workspace(
				storage,
				createCountingVcsFactory(counters, {
					initGate: async () => {
						initCalled = true;
						await initGate;
					}
				}),
				new MemorySessionPersistence(),
				host
			);
			provideDialogs(host);
			await host.activate('git');
			workspace.rootOrigin = rootOrigin;
			workspace.hasRootPermission = true;

			const initTask = host.executeCommand('git.init');
			for (let i = 0; i < 50 && !initCalled; i++) await tick(1);
			expect(initCalled).toBe(true);

			// Request disablement mid-write: visible blocked state, not success.
			let deactivateResolved = false;
			const deactivateTask = host.deactivate('git').then(() => {
				deactivateResolved = true;
			});
			expect(host.getPluginState('git')).toBe('deactivating');
			await tick();
			expect(deactivateResolved).toBe(false);
			expect(host.getPluginState('git')).toBe('deactivating');

			// The active write runs to completion (never terminated)...
			releaseInit();
			const [initResult] = await Promise.all([initTask, deactivateTask]);

			expect(deactivateResolved).toBe(true);
			// ...but its stale result is dropped: disable wins.
			expect(initResult).toBe(false);
			expect(host.getPluginState('git')).toBe('inactive');
			expect(workspace.repository).toBeNull();
		});

		it('refuses new Git writes and waits for an active write before completing disablement', async () => {
			let releaseStage!: () => void;
			const stageGate = new Promise<void>((resolve) => (releaseStage = resolve));
			const stagedFiles: string[] = [];
			const adapter: VCSAdapter = {
				detect: async () => true,
				stageFile: mock(async (filepath: string) => {
					stagedFiles.push(filepath);
					if (filepath === 'first.md') await stageGate;
				}),
				getCurrentBranch: async () => 'main',
				getBranches: async () => ['main'],
				getChanges: async () => [],
				getCommits: async () => [],
				getStatus: async () => ({ isDirty: false, uncommittedFiles: [] })
			};
			const host = new PluginHost();
			host.register(gitRegistration);
			const { storage } = createHarnessStorage();
			const workspace = new Workspace(
				storage,
				() => adapter,
				new MemorySessionPersistence(),
				host
			);
			provideDialogs(host);
			await host.activate('git');
			await workspace.openDirectory();
			expect(workspace.repository).not.toBeNull();

			const firstWrite = host.executeCommand('git.stage', 'first.md') as Promise<boolean>;
			for (let i = 0; i < 50 && stagedFiles.length === 0; i++) await tick(1);
			expect(stagedFiles).toEqual(['first.md']);

			let deactivateResolved = false;
			const deactivateTask = host.deactivate('git').then(() => {
				deactivateResolved = true;
			});
			expect(host.getPluginState('git')).toBe('deactivating');
			await tick();
			expect(deactivateResolved).toBe(false);

			expect(host.executeCommand('git.stage', 'second.md')).toBeUndefined();
			releaseStage();
			await Promise.all([firstWrite, deactivateTask]);

			expect(stagedFiles).toEqual(['first.md']);
			expect(host.getPluginState('git')).toBe('inactive');
			expect(workspace.repository).toBeNull();
		});
	});

	describe('dependency cascade UX (ADR 0017)', () => {
		function cascadeRegistrations(): PluginRegistration[] {
			const base: PluginManifest = {
				id: 'base',
				name: 'Base',
				version: 0,
				provides: { caps: 0 }
			};
			const mid: PluginManifest = {
				id: 'mid',
				name: 'Mid',
				version: 0,
				dependsOn: { caps: 0 }
			};
			const leaf: PluginManifest = {
				id: 'leaf',
				name: 'Leaf',
				version: 0,
				dependsOn: { mid: 0 }
			};
			const deactivated: string[] = [];
			const track = (id: string): PluginRegistration => ({
				manifest: id === 'base' ? base : id === 'mid' ? mid : leaf,
				setup: () => () => {
					deactivated.push(id);
				}
			});
			const registrations = [track('base'), track('mid'), track('leaf')];
			return { registrations, deactivated };
		}

		it('explains the cascade, unloads dependents first, and never auto re-enables', async () => {
			const host = new PluginHost();
			const { registrations, deactivated } = cascadeRegistrations();
			host.registerAll(registrations);
			await host.activateAll();
			expect(host.isPluginActive('base')).toBe(true);
			expect(host.isPluginActive('mid')).toBe(true);
			expect(host.isPluginActive('leaf')).toBe(true);

			// The cascade is explainable before it happens (transitive).
			expect(host.getActiveDependents('base').sort()).toEqual(['leaf', 'mid']);
			expect(host.getActiveDependents('mid')).toEqual(['leaf']);
			expect(host.getActiveDependents('leaf')).toEqual([]);

			await host.deactivate('base');

			// Dependents unload first (leaf before mid before base).
			expect(deactivated).toEqual(['leaf', 'mid', 'base']);
			expect(host.isPluginActive('base')).toBe(false);
			expect(host.isPluginActive('mid')).toBe(false);
			expect(host.isPluginActive('leaf')).toBe(false);
			// Reasons name the cause (ADR 0017 explanation surface).
			expect(host.getDeactivationReason('mid')).toContain('Mid is off because Base is off');
			expect(host.getDeactivationReason('leaf')).toContain('Leaf is off because Mid is off');

			// Re-enabling the dependency never auto-enables dependents.
			await host.activate('base');
			expect(host.isPluginActive('base')).toBe(true);
			expect(host.isPluginActive('mid')).toBe(false);
			expect(host.isPluginActive('leaf')).toBe(false);
			expect(host.getDeactivationReason('mid')).toContain('Mid is off because Base is off');
		});

		it('persists cascade victims as off so a restart never auto re-enables them', async () => {
			const prefsBacking = createPrefsBacking();
			const host = new PluginHost();
			host.registerAll(cascadeRegistrations().registrations);
			const { storage } = createHarnessStorage();
			const counters: VcsCounters = { factory: 0, detect: 0, init: 0, getChanges: 0 };
			const app = new AppState({
				storage,
				vcsFactory: createCountingVcsFactory(counters),
				prefsStorage: prefsBacking,
				pluginHost: host
			});
			await app.init();
			// Manifests without defaultEnabled stay off; enable the chain explicitly.
			await app.setPluginEnabled('base', true);
			await app.setPluginEnabled('mid', true);
			await app.setPluginEnabled('leaf', true);
			expect(host.isPluginActive('leaf')).toBe(true);

			await app.setPluginEnabled('base', false);
			expect(host.isPluginActive('mid')).toBe(false);
			expect(host.isPluginActive('leaf')).toBe(false);

			// Fresh startup over the same storage: victims stay off.
			const host2 = new PluginHost();
			host2.registerAll(cascadeRegistrations().registrations);
			const app2 = new AppState({
				storage,
				vcsFactory: createCountingVcsFactory(counters),
				prefsStorage: prefsBacking,
				pluginHost: host2
			});
			await app2.init();
			expect(host2.isPluginActive('base')).toBe(false);
			expect(host2.isPluginActive('mid')).toBe(false);
			expect(host2.isPluginActive('leaf')).toBe(false);
		});
	});

	describe('registry order does not depend on toggle history (ADR 0012)', () => {
		function contributingPlugin(id: string): PluginRegistration {
			return {
				manifest: { id, name: id, version: 0 },
				setup: (host) => {
					host.registerCommands(id, [
						{ id: `${id}.command`, label: id, category: 'Fixtures', action: () => undefined }
					]);
					host.registerSettingSchema(id, {
						namespace: id,
						title: id,
						description: `${id} settings`,
						properties: {
							flag: { type: 'boolean', default: false, title: 'Flag', control: 'toggle' }
						}
					});
					host.registerEditorContribution(id, {
						id: `${id}.decoration`,
						type: 'decoration',
						extension: []
					});
				}
			};
		}

		async function registryOrder(afterToggle: boolean) {
			const host = new PluginHost();
			host.register(contributingPlugin('alpha'));
			host.register(contributingPlugin('beta'));
			await host.activateAll();
			if (afterToggle) {
				await host.deactivate('alpha');
				await host.activate('alpha');
			}
			return {
				commands: host.getCommands().map((command) => command.id),
				settings: host.getSettingSchemas().map((schema) => schema.namespace),
				editor: host.getEditorContributions().map((entry) => entry.id)
			};
		}

		it('matches a clean build after a deactivate/reactivate cycle', async () => {
			expect(await registryOrder(true)).toEqual(await registryOrder(false));
		});
	});

	describe('startup cycle check surfaces instead of failing silently (ADR 0017)', () => {
		it('records an actionable pluginStartupError and activates nothing', async () => {
			const host = new PluginHost();
			host.register({
				manifest: { id: 'cycle-a', name: 'Cycle A', version: 0, dependsOn: { 'cycle-b': 0 } },
				setup: () => {}
			});
			host.register({
				manifest: { id: 'cycle-b', name: 'Cycle B', version: 0, dependsOn: { 'cycle-a': 0 } },
				setup: () => {}
			});
			const { storage } = createHarnessStorage();
			const counters: VcsCounters = { factory: 0, detect: 0, init: 0, getChanges: 0 };
			const app = new AppState({
				storage,
				vcsFactory: createCountingVcsFactory(counters),
				prefsStorage: createPrefsBacking(),
				pluginHost: host
			});

			await app.init();

			expect(app.pluginStartupError).not.toBeNull();
			expect(app.pluginStartupError!).toContain('dependency cycle');
			expect(app.pluginStartupError!).toContain('Action:');
			expect(host.isPluginActive('cycle-a')).toBe(false);
			expect(host.isPluginActive('cycle-b')).toBe(false);
		});
	});
});
