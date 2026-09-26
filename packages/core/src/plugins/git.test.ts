import '../../../../tests/contract/rune-setup';
import { describe, it, expect, mock, spyOn } from 'bun:test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { PluginHost } from './host.svelte';
import type { PluginHostInterface } from './types';
import { gitRegistration } from './git/registration';
import { checkManifestFile } from './boundary-check';
import { DIALOGS_SERVICE_KEY } from './services';
import { Workspace } from '../workspace.svelte';
import { DocumentSession } from '../document.svelte';
import { MemorySessionPersistence } from '../persistence';
import type { FileOrigin, Storage } from '../storage';
import type { VCSAdapter } from '../project/vcs';
import { Repository } from '../project/repository.svelte';
import { openFolderRepository, createWorkspaceGitState } from './git/lifecycle';

const rootOrigin: FileOrigin = { scheme: 'file', path: '/repo', name: 'repo' };

function createLocalMockStorage(initialFiles: Record<string, string> = {}): Storage {
	const files = new Map<string, string>(Object.entries(initialFiles));
	return {
		readFile: mock(async (origin: FileOrigin) => {
			const content = files.get(origin.path);
			if (content === undefined) throw new Error(`Not found: ${origin.path}`);
			return content;
		}),
		writeFile: mock(async (origin: FileOrigin, content: string) => {
			files.set(origin.path, content);
		}),
		saveFile: mock(async (content: string, existingOrigin?: FileOrigin) => {
			const origin = existingOrigin ?? { scheme: 'file', path: '/saved.md', name: 'saved.md' };
			files.set(origin.path, content);
			return origin;
		}),
		openFileDialog: mock(async () => null),
		openDirectoryDialog: mock(async () => null),
		saveFileDialog: mock(async () => null),
		readDirectory: mock(async () => []),
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
}

interface MockVcsOptions {
	detected?: boolean;
	init?: (path?: string) => Promise<void>;
	changes?: () => Promise<any[]>;
}

function createMockVcsFactory(options: MockVcsOptions = {}): (root: FileOrigin) => VCSAdapter {
	return () => ({
		detect: mock(async () => options.detected ?? true),
		init: options.init ? mock(options.init) : undefined,
		getCurrentBranch: async () => 'main',
		getBranches: async () => ['main'],
		getChanges: options.changes ?? (async () => []),
		getCommits: async () => [],
		getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
		switchBranch: mock(async () => ({ status: 'switched' as const }))
	});
}

async function makeHarness(vcsOptions: MockVcsOptions = {}, confirmResult = true) {
	const host = new PluginHost();
	host.register(gitRegistration);
	const storage = createLocalMockStorage({ '/repo/file.md': '' });
	const persistence = new MemorySessionPersistence();
	const workspace = new Workspace(storage, createMockVcsFactory(vcsOptions), persistence, host);
	const alerts: string[] = [];
	host.provideService(DIALOGS_SERVICE_KEY, {
		alert: mock(async (message: string) => {
			alerts.push(message);
		}),
		confirm: mock(async () => confirmResult)
	});
	await host.activate('git');
	return { host, workspace, storage, persistence, alerts };
}

async function tick(times = 5) {
	for (let i = 0; i < times; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

const EXPECTED_GIT_COMMAND_IDS = [
	'git.init',
	'git.stage',
	'git.unstage',
	'git.discard',
	'git.commit',
	'git.createBranch',
	'git.stageAll',
	'git.unstageAll',
	'git.discardAll',
	'git.openDiff',
	'git.stageHunk',
	'git.unstageHunk',
	'git.discardHunk'
];

describe('Git Core Plugin: lifecycle and commands (#202)', () => {
	describe('manifest and registration', () => {
		it('keeps the manifest module import-clean per the boundary check', () => {
			const manifestPath = join(import.meta.dir, 'git', 'manifest.ts');
			const result = checkManifestFile(manifestPath);
			expect(result.valid).toBe(true);
			expect(result.violations).toHaveLength(0);
		});

		it('reads git manifest metadata without loading plugin implementation', () => {
			const host = new PluginHost();
			host.register(gitRegistration);

			const manifest = host.getManifest('git');
			expect(manifest).toBeDefined();
			expect(manifest?.id).toBe('git');
			expect(manifest?.name).toBe('Git');
			expect(manifest?.version).toBe(0);
			expect(manifest?.platforms).toEqual(['web', 'desktop']);

			expect(host.isPluginActive('git')).toBe(false);
			expect(host.getPluginState('git')).toBe('inactive');
		});
	});

	describe('enabled behavior unchanged', () => {
		it('detects and refreshes the repository on folder open', async () => {
			const { workspace } = await makeHarness({ detected: true });

			await workspace.openDirectory();

			expect(workspace.repository).not.toBeNull();
			expect(workspace.repository?.currentBranch).toBe('main');
			expect(workspace.repository?.branches).toEqual(['main']);
		});

		it('leaves the repository null when the opened folder is not detected', async () => {
			const { workspace } = await makeHarness({ detected: false });

			await workspace.openDirectory();

			expect(workspace.repository).toBeNull();
		});

		it('works when activated before the workspace is constructed (lazy service resolution)', async () => {
			const host = new PluginHost();
			host.register(gitRegistration);
			await host.activate('git');

			const workspace = new Workspace(
				createLocalMockStorage(),
				createMockVcsFactory({ detected: true }),
				new MemorySessionPersistence(),
				host
			);
			await workspace.openDirectory();

			expect(workspace.repository).not.toBeNull();
			expect(host.getCommand('git.stage')).toBeDefined();
		});

		it('registers all Git commands through the shared registry', async () => {
			const { host } = await makeHarness();

			for (const id of EXPECTED_GIT_COMMAND_IDS) {
				const command = host.getCommand(id);
				expect(command).toBeDefined();
				expect(command?.category).toBe('Source Control');
			}
			expect(host.getCommandsByCategory('Source Control').map((c) => c.id).sort()).toEqual(
				[...EXPECTED_GIT_COMMAND_IDS].sort()
			);
		});

		it('executes commands against the owned repository', async () => {
			const stageAll = mock(async () => {});
			const host = new PluginHost();
			host.register(gitRegistration);
			const workspace = new Workspace(
				createLocalMockStorage(),
				(): VCSAdapter => ({
					detect: mock(async () => true),
					getCurrentBranch: async () => 'main',
					getBranches: async () => ['main'],
					getChanges: async () => [],
					getCommits: async () => [],
					getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
					switchBranch: mock(async () => ({ status: 'switched' as const })),
					stageAll
				}),
				new MemorySessionPersistence(),
				host
			);
			host.provideService(DIALOGS_SERVICE_KEY, {
				alert: mock(async () => {}),
				confirm: mock(async () => true)
			});
			await host.activate('git');
			await workspace.openDirectory();

			const result = await host.executeCommand('git.stageAll');

			expect(result).toBe(true);
			expect(stageAll).toHaveBeenCalled();
		});

		it('refreshes the repository through the afterSave hook on successful save', async () => {
			const { host, workspace } = await makeHarness();

			const repo = new Repository(rootOrigin, createMockVcsFactory());
			const refreshSpy = spyOn(repo, 'refresh');
			workspace.repository = repo;

			const fileOrigin: FileOrigin = { scheme: 'file', path: '/repo/file.md', name: 'file.md' };
			const doc = new DocumentSession(workspace.storage, '', fileOrigin);
			doc.content = 'Updated file content';

			const saved = await workspace.saveDocument(doc);
			expect(saved).toBe(true);
			expect(refreshSpy).toHaveBeenCalled();

			refreshSpy.mockRestore();
		});

		it('skips refresh when the save did not succeed', async () => {
			const { host, workspace } = await makeHarness();

			const repo = new Repository(rootOrigin, createMockVcsFactory());
			const refreshSpy = spyOn(repo, 'refresh');
			workspace.repository = repo;

			const doc = new DocumentSession(workspace.storage, '', null);
			await host.runAfterSave({ document: doc, options: {}, success: false });

			expect(refreshSpy).not.toHaveBeenCalled();
			refreshSpy.mockRestore();
		});
	});

	describe('no Git-named host members', () => {
		it('exposes no Git-named members on the host runtime', () => {
			const protoMembers = Object.getOwnPropertyNames(PluginHost.prototype).filter(
				(m) => m !== 'constructor'
			);
			expect(protoMembers.filter((m) => /git/i.test(m))).toEqual([]);

			const instanceMembers = Object.keys(new PluginHost());
			expect(instanceMembers.filter((m) => /git/i.test(m))).toEqual([]);
		});

		it('declares no Git-named members in plugin host interface sources', () => {
			const memberPattern =
				/^\s*(?:(?:async|private|public|protected|readonly|static|get|set)\s+)*[A-Za-z_$][\w$]*\s*[(<:?=]/;
			for (const file of ['types.ts', 'host.svelte.ts', 'services.ts', 'hooks.ts', 'events.ts']) {
				const source = readFileSync(join(import.meta.dir, file), 'utf-8');
				const code = source
					.replace(/\/\*[\s\S]*?\*\//g, '')
					.replace(/(^|\s)\/\/.*$/gm, '$1');
				const offenders = code
					.split('\n')
					.filter((line) => memberPattern.test(line))
					.filter((line) => /git/i.test(line));
				expect(offenders).toEqual([]);
			}
		});
	});

	describe('public plugin contracts', () => {
		it('exposes save coordination through the plugin host interface', async () => {
			const host = new PluginHost();
			let setupHost: PluginHostInterface | undefined;
			host.register({
				manifest: { id: 'save-contract-probe', name: 'Save Contract Probe', version: 0 },
				setup: (pluginHost) => {
					setupHost = pluginHost;
				}
			});
			await host.activate('save-contract-probe');

			expect(typeof Reflect.get(setupHost, 'runSaveExclusive')).toBe('function');
		});

		it('keeps Git modules independent from the concrete Workspace class', () => {
			for (const file of ['git/index.ts', 'git/lifecycle.ts', 'git/commands.ts']) {
				const source = readFileSync(join(import.meta.dir, file), 'utf-8');
				expect(source).not.toMatch(/from ['"]\.\.\/\.\.\/workspace\.svelte['"]/);
			}
		});
	});

	describe('per-workspace cleanup on disable', () => {
		it('drops the repository and removes commands and hooks', async () => {
			const { host, workspace } = await makeHarness({ detected: true });
			await workspace.openDirectory();
			expect(workspace.repository).not.toBeNull();
			expect(host.getCommand('git.stage')).toBeDefined();

			await host.deactivate('git');

			// Repository dropped so the UI falls back to its empty state.
			expect(workspace.repository).toBeNull();
			// Commands removed via the shared registry.
			for (const id of EXPECTED_GIT_COMMAND_IDS) {
				expect(host.getCommand(id)).toBeUndefined();
			}
			expect(host.getCommandsByCategory('Source Control')).toHaveLength(0);
		});

		it('stops save-triggered refresh and folder-open detection after disable', async () => {
			const { host, workspace } = await makeHarness({ detected: true });
			await workspace.openDirectory();
			const repo = workspace.repository!;
			const refreshSpy = spyOn(repo, 'refresh');

			await host.deactivate('git');

			const fileOrigin: FileOrigin = { scheme: 'file', path: '/repo/file.md', name: 'file.md' };
			const doc = new DocumentSession(workspace.storage, '', fileOrigin);
			doc.content = 'Edit after disable';
			await workspace.saveDocument(doc);
			expect(refreshSpy).not.toHaveBeenCalled();

			const otherOrigin: FileOrigin = { scheme: 'file', path: '/other', name: 'other' };
			await workspace.openDirectory(otherOrigin);
			expect(workspace.repository).toBeNull();

			refreshSpy.mockRestore();
		});

		it('restores full behavior on re-enable', async () => {
			const { host, workspace } = await makeHarness({ detected: true });
			await workspace.openDirectory();
			await host.deactivate('git');
			expect(workspace.repository).toBeNull();

			await host.activate('git');
			await workspace.openDirectory();

			expect(workspace.repository).not.toBeNull();
			expect(workspace.repository?.currentBranch).toBe('main');
			expect(host.getCommand('git.stage')).toBeDefined();
		});

		it('leaves the folder-less session state alone when no folder is open', async () => {
			const { host, persistence } = await makeHarness({ detected: true });
			// The app's unscoped session bucket, which the Git plugin does not own
			// when it has no folder.
			const folderLess = [
				{ id: 'doc-1', origin: { scheme: 'file', path: '/elsewhere/a.md', name: 'a.md' }, isModified: false }
			];
			await persistence.saveOpenFiles(folderLess, '');
			await persistence.saveActiveDocumentId('doc-1', '');

			await host.deactivate('git');

			// Disablement owns no folder here, so it must not rewrite the unscoped
			// bucket with the workspace's own (here: empty) tab list.
			expect(await persistence.loadOpenFiles('')).toEqual(folderLess);
			expect(await persistence.loadActiveDocumentId('')).toBe('doc-1');
		});

		it('still persists the closed diff tabs for the folder it owns', async () => {
			const { host, workspace, persistence } = await makeHarness({ detected: true });
			await workspace.openDirectory();
			workspace.tabs.push({ id: '__project_diff__', type: 'diff', pluginId: 'git' });
			await workspace.saveFolderState('file:///repo');
			expect((await persistence.loadOpenFiles('file:///repo')).map((d) => d.id)).toContain('__project_diff__');

			await host.deactivate('git');

			// The diff tab is gone from the session, and the folder's saved state
			// no longer resurrects it on the next open.
			expect(workspace.tabs.some((tab) => tab.id === '__project_diff__')).toBe(false);
			const saved = await persistence.loadOpenFiles('file:///repo');
			expect(saved.some((doc) => doc.virtualTabType === 'diff')).toBe(false);
		});

		it('drops in-flight detect results on disable', async () => {
			let releaseDetect!: () => void;
			const detectGate = new Promise<void>((resolve) => (releaseDetect = resolve));
			let detectCalled = false;
			const host = new PluginHost();
			host.register(gitRegistration);
			const workspace = new Workspace(
				createLocalMockStorage(),
				(): VCSAdapter => ({
					detect: mock(async () => {
						detectCalled = true;
						await detectGate;
						return true;
					}),
					getCurrentBranch: async () => 'main',
					getBranches: async () => ['main'],
					getChanges: async () => [],
					getCommits: async () => [],
					getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
					switchBranch: mock(async () => ({ status: 'switched' as const }))
				}),
				new MemorySessionPersistence(),
				host
			);
			host.provideService(DIALOGS_SERVICE_KEY, {
				alert: mock(async () => {}),
				confirm: mock(async () => true)
			});
			await host.activate('git');

			const openTask = workspace.openDirectory();
			for (let i = 0; i < 50 && !detectCalled; i++) await tick(1);

			const deactivateTask = host.deactivate('git');
			releaseDetect();
			await Promise.all([openTask, deactivateTask]);

			// The late detect result is discarded: nothing is published after disable.
			expect(workspace.repository).toBeNull();
		});

		it('finishes active writes before disable completes', async () => {
			let releaseInit!: () => void;
			const initGate = new Promise<void>((resolve) => (releaseInit = resolve));
			let initCalled = false;
			const { host, workspace } = await makeHarness({
				detected: true,
				init: async () => {
					initCalled = true;
					await initGate;
				}
			});
			workspace.rootOrigin = rootOrigin;
			workspace.hasRootPermission = true;

			const initTask = host.executeCommand('git.init');
			for (let i = 0; i < 50 && !initCalled; i++) await tick(1);
			expect(initCalled).toBe(true);

			const deactivateTask = host.deactivate('git');
			releaseInit();
			const [initResult] = await Promise.all([initTask, deactivateTask]);

			// The active write ran to completion (not cancelled)...
			expect(initCalled).toBe(true);
			// ...but its result is dropped: disable wins over stale publication.
			expect(initResult).toBe(false);
			expect(workspace.repository).toBeNull();
		});
	});

	describe('git.init lifecycle (moved from Workspace.initializeRepository)', () => {
		it('initializes, refreshes, and rescans on success', async () => {
			let initPath: string | undefined;
			const { host, workspace, alerts } = await makeHarness({
				init: async (path?: string) => {
					initPath = path;
				}
			});
			workspace.rootOrigin = rootOrigin;
			workspace.hasRootPermission = true;
			let scannedOrigin: FileOrigin | null = null;
			workspace.projectTree.scan = mock(async (origin: FileOrigin) => {
				scannedOrigin = origin;
			});

			const result = await host.executeCommand('git.init');

			expect(result).toBe(true);
			expect(initPath).toBe(rootOrigin.path);
			expect(workspace.repository).not.toBeNull();
			expect(workspace.repository?.currentBranch).toBe('main');
			expect(scannedOrigin).toEqual(rootOrigin);
			expect(alerts).toHaveLength(0);
		});

		it('returns false without touching the factory when no folder is open', async () => {
			let factoryCalled = false;
			const host = new PluginHost();
			host.register(gitRegistration);
			const workspace = new Workspace(
				createLocalMockStorage(),
				() => {
					factoryCalled = true;
					return createMockVcsFactory()({ scheme: 'file', path: '/', name: '/' });
				},
				new MemorySessionPersistence(),
				host
			);
			host.provideService(DIALOGS_SERVICE_KEY, {
				alert: mock(async () => {}),
				confirm: mock(async () => true)
			});
			await host.activate('git');
			workspace.rootOrigin = null;
			workspace.hasRootPermission = true;

			expect(await host.executeCommand('git.init')).toBe(false);
			expect(workspace.repository).toBeNull();
			expect(factoryCalled).toBe(false);
		});

		it('returns false when the folder lacks permission', async () => {
			const { host, workspace } = await makeHarness({ detected: true });
			workspace.rootOrigin = rootOrigin;
			workspace.hasRootPermission = false;

			expect(await host.executeCommand('git.init')).toBe(false);
			expect(workspace.repository).toBeNull();
		});

		it('alerts and returns false when the adapter lacks init capability', async () => {
			const { host, workspace, alerts } = await makeHarness({ detected: true });
			// Establish an OWNED publication through folder open: init may
			// clear what it owns, never what it does not (ADR 0009).
			await workspace.openDirectory();
			expect(workspace.repository).not.toBeNull();

			expect(await host.executeCommand('git.init')).toBe(false);
			expect(alerts).toEqual(['Failed to initialize repository: VCS adapter does not support repository initialization']);
			expect(workspace.repository).toBeNull();
		});

		it('never drops a foreign repository it does not own (ADR 0009)', async () => {
			const { host, workspace, alerts } = await makeHarness({ init: async () => {} });
			workspace.rootOrigin = rootOrigin;
			workspace.hasRootPermission = true;
			const foreign = new Repository(rootOrigin, createMockVcsFactory());
			workspace.repository = foreign;

			expect(await host.executeCommand('git.init')).toBe(false);
			expect(workspace.repository).toBe(foreign);
			expect(alerts).toHaveLength(1);
			expect(alerts[0]).toContain('another contributor');
			expect(alerts[0]).toContain('Action:');
		});

		it('alerts and returns false when adapter init rejects', async () => {
			const { host, workspace, alerts } = await makeHarness({
				init: async () => {
					throw new Error('Filesystem write permission denied');
				}
			});
			workspace.rootOrigin = rootOrigin;
			workspace.hasRootPermission = true;

			expect(await host.executeCommand('git.init')).toBe(false);
			expect(alerts).toEqual(['Failed to initialize repository: Filesystem write permission denied']);
			expect(workspace.repository).toBeNull();
		});

		it('clears stale repository before asynchronous initialization starts', async () => {
			let repoClearedBeforeInit = false;
			let resolveInit!: () => void;
			const initPromise = new Promise<void>((r) => (resolveInit = r));
			const { host, workspace } = await makeHarness({
				init: async () => {
					repoClearedBeforeInit = workspace.repository === null;
					await initPromise;
				}
			});
			// Owned stale state (folder-open publication): init may clear it.
			await workspace.openDirectory();
			expect(workspace.repository).not.toBeNull();

			const initTask = host.executeCommand('git.init');
			await tick();
			expect(workspace.repository).toBeNull();

			resolveInit();
			expect(await initTask).toBe(true);
			expect(repoClearedBeforeInit).toBe(true);
			expect(workspace.repository).not.toBeNull();
		});

		it('does not publish when the folder switches during deferred init', async () => {
			let resolveInit!: () => void;
			const initGate = new Promise<void>((r) => (resolveInit = r));
			const { host, workspace } = await makeHarness({
				init: async () => {
					await initGate;
				}
			});
			workspace.rootOrigin = rootOrigin;
			workspace.hasRootPermission = true;
			const scanned: FileOrigin[] = [];
			workspace.projectTree.scan = mock(async (origin: FileOrigin) => {
				scanned.push(origin);
			});

			const initTask = host.executeCommand('git.init');
			await tick();
			expect(workspace.repository).toBeNull();

			const otherOrigin: FileOrigin = { scheme: 'file', path: '/projects/other', name: 'other' };
			workspace.rootOrigin = otherOrigin;
			const newerRepository = { currentBranch: 'newer' } as any;
			workspace.repository = newerRepository;

			resolveInit();
			expect(await initTask).toBe(false);
			expect(workspace.repository).toBe(newerRepository);
			expect(scanned).toEqual([]);
		});

		it('returns false and skips scan when repository refresh fails', async () => {
			const host = new PluginHost();
			host.register(gitRegistration);
			const workspace = new Workspace(
				createLocalMockStorage(),
				(): VCSAdapter => ({
					detect: mock(async () => true),
					init: mock(async () => {}),
					getCurrentBranch: async () => {
						throw new Error('Corrupted repository state');
					},
					getBranches: async () => {
						throw new Error('Cannot read branches');
					},
					getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
					switchBranch: mock(async () => ({ status: 'switched' as const }))
				}),
				new MemorySessionPersistence(),
				host
			);
			host.provideService(DIALOGS_SERVICE_KEY, {
				alert: mock(async () => {}),
				confirm: mock(async () => true)
			});
			await host.activate('git');
			workspace.rootOrigin = rootOrigin;
			workspace.hasRootPermission = true;
			const scanMock = mock(async () => {});
			workspace.projectTree.scan = scanMock;

			expect(await host.executeCommand('git.init')).toBe(false);
			expect(workspace.repository).toBeNull();
			expect(scanMock).not.toHaveBeenCalled();
		});

		it('discards initialization results if root changes during projectTree.scan', async () => {
			let resolveScan!: () => void;
			const scanPromise = new Promise<void>((resolve) => {
				resolveScan = resolve;
			});
			const { host, workspace } = await makeHarness({ init: async () => {} });
			workspace.rootOrigin = rootOrigin;
			workspace.hasRootPermission = true;
			workspace.projectTree.scan = mock(async () => {
				await scanPromise;
			});

			const initOp = host.executeCommand('git.init');
			await tick(2);

			workspace.rootOrigin = { scheme: 'file', path: '/projects/other', name: 'other' };
			resolveScan();

			expect(await initOp).toBe(false);
			expect(workspace.repository).toBeNull();
		});

		it('alerts and returns false when project tree scan rejects', async () => {
			const { host, workspace, alerts } = await makeHarness({ init: async () => {} });
			workspace.rootOrigin = rootOrigin;
			workspace.hasRootPermission = true;
			workspace.projectTree.scan = mock(async () => {
				throw new Error('Project tree scan failure');
			});

			expect(await host.executeCommand('git.init')).toBe(false);
			expect(alerts).toEqual(['Failed to initialize repository: Project tree scan failure']);
			expect(workspace.repository).toBeNull();
		});
	});

	describe("stale folder-open handling in git lifecycle", () => {
		it("rejects stale folder open when a newer open starts while detect is pending", async () => {
			let releaseDetectA!: () => void;
			const detectGateA = new Promise<void>((resolve) => (releaseDetectA = resolve));
			let detectACalled = false;

			const host = new PluginHost();
			const storage = createLocalMockStorage();
			const persistence = new MemorySessionPersistence();
			const originA: FileOrigin = { scheme: "file", path: "/repo-a", name: "repo-a" };
			const originB: FileOrigin = { scheme: "file", path: "/repo-b", name: "repo-b" };

			const workspace = new Workspace(
				storage,
				(root: FileOrigin) => ({
					detect: mock(async (path?: string) => {
						if (path === "/repo-a") {
							detectACalled = true;
							await detectGateA;
							return true;
						}
						return true;
					}),
					getCurrentBranch: async () => "main",
					getBranches: async () => ["main"],
					getChanges: async () => [],
					getCommits: async () => [],
					getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
					refresh: async () => {}
				}),
				persistence,
				host
			);

			const state = createWorkspaceGitState(workspace);
			workspace.rootOrigin = originA;

			// Start opening folder A (will pause on detectGateA)
			const openTaskA = openFolderRepository(state, originA);
			for (let i = 0; i < 20 && !detectACalled; i++) await tick(1);
			expect(detectACalled).toBe(true);

			// Now switch workspace to folder B and start opening folder B
			workspace.rootOrigin = originB;
			const openTaskB = openFolderRepository(state, originB);
			await openTaskB;

			// Folder B is now published
			expect(workspace.repository).not.toBeNull();
			
			const repoB = workspace.repository;

			// Now release folder A detect
			releaseDetectA();
			await openTaskA;

			// Workspace repository must NOT have been overwritten or disposed by the stale open A!
			expect(workspace.repository).toBe(repoB);
			expect(state.repository).toBe(repoB);
		});

		it("rejects folder open when workspace root changes during refresh", async () => {
			let releaseRefresh!: () => void;
			const refreshGate = new Promise<void>((resolve) => (releaseRefresh = resolve));

			const host = new PluginHost();
			const storage = createLocalMockStorage();
			const persistence = new MemorySessionPersistence();
			const originA: FileOrigin = { scheme: "file", path: "/repo-a", name: "repo-a" };
			const originB: FileOrigin = { scheme: "file", path: "/repo-b", name: "repo-b" };

			const workspace = new Workspace(
				storage,
				(root: FileOrigin) => ({
					detect: mock(async () => true),
					getCurrentBranch: async () => {
						await refreshGate;
						return "main";
					},
					getBranches: async () => ["main"],
					getChanges: async () => [],
					getCommits: async () => [],
					getStatus: async () => ({ isDirty: false, uncommittedFiles: [] })
				}),
				persistence,
				host
			);

			const state = createWorkspaceGitState(workspace);
			workspace.rootOrigin = originA;

			const openTaskA = openFolderRepository(state, originA);
			await tick(5);

			// Root changed while refresh was in flight
			workspace.rootOrigin = originB;
			releaseRefresh();
			await openTaskA;

			// Stale repo for folder A was cleared and not left active for folder B
			expect(workspace.repository).toBeNull();
			expect(state.repository).toBeNull();
		});
	});

	describe('rebuild equivalence (spec acceptance)', () => {
		async function makeCommandHost() {
			const host = new PluginHost();
			host.register(gitRegistration);
			host.registerCommands('core', [
				{ id: 'file.new', label: 'New', category: 'File', action: () => {} },
				{ id: 'file.open', label: 'Open', category: 'File', action: () => {} }
			]);
			host.provideService(DIALOGS_SERVICE_KEY, {
				alert: mock(async () => {}),
				confirm: mock(async () => true)
			});
			return host;
		}

		const sortedIds = (host: PluginHost) => host.getCommands().map((c) => c.id).sort();

		it('remove-plugin yields the same registry as a clean build without it', async () => {
			const host = await makeCommandHost();
			await host.activate('git');
			expect(sortedIds(host)).toContain('git.stage');

			host.removePluginCommands('git');

			const clean = await makeCommandHost();
			expect(sortedIds(host)).toEqual(sortedIds(clean));
		});

		it('deactivation yields the same registry as before activation', async () => {
			const host = await makeCommandHost();
			const before = sortedIds(host);

			await host.activate('git');
			expect(sortedIds(host)).not.toEqual(before);

			await host.deactivate('git');
			expect(sortedIds(host)).toEqual(before);
		});

		it('refresh-mid-session rebuilds with no duplicates or losses', async () => {
			const host = await makeCommandHost();
			await host.activate('git');
			const before = sortedIds(host);

			host.refreshCommands();
			host.refreshCommands();

			expect(sortedIds(host)).toEqual(before);
			expect(new Set(sortedIds(host)).size).toBe(sortedIds(host).length);
		});
	});
});
