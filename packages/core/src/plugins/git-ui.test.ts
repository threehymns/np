import '../../../../tests/contract/rune-setup';
import { describe, it, expect, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PluginHost } from './host.svelte';
import { gitRegistration } from './git/registration';
import { GIT_PANEL_ID, GIT_STATUS_ID, GIT_UI_COMPONENTS_KEY } from './git/ui';
import { GIT_GUTTER_CONTRIBUTION, GIT_DECORATION_CONTRIBUTION } from './git/gutter';
import { composeEditorContributions } from './editor';
import { Workspace } from '../workspace.svelte';
import { MemorySessionPersistence } from '../persistence';
import { DIALOGS_SERVICE_KEY } from './services';
import { AppState } from '../state.svelte';
import { createMockStorage as createSharedMockStorage } from '../../../../tests/mock-storage';
import type { FileOrigin, Storage } from '../storage';
import type { VCSAdapter } from '../project/vcs';

const rootOrigin: FileOrigin = { scheme: 'file', path: '/repo', name: 'repo' };

function createMockStorage(): Storage {
	const files = new Map<string, string>([['/repo/file.md', '']]);
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

function createMockVcsFactory(): (root: FileOrigin) => VCSAdapter {
	return () => ({
		detect: mock(async () => true),
		getCurrentBranch: async () => 'main',
		getBranches: async () => ['main'],
		getChanges: async () => [],
		getCommits: async () => [],
		getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
		switchBranch: mock(async () => ({ status: 'switched' as const }))
	});
}

async function makeHost() {
	const host = new PluginHost();
	host.register(gitRegistration);
	const workspace = new Workspace(createMockStorage(), createMockVcsFactory(), new MemorySessionPersistence(), host);
	host.provideService(DIALOGS_SERVICE_KEY, {
		alert: mock(async () => {}),
		confirm: mock(async () => true)
	});
	return { host, workspace };
}

function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|\s)\/\/.*$/gm, '$1');
}

describe('Git UI migration (#203)', () => {
	describe('panel, status, and decorations register on enable and vanish on disable', () => {
		it('registers sidebar panel, status item, and editor contributions on activate (headless pilots)', async () => {
			const { host } = await makeHost();
			expect(host.getSidebarPanel(GIT_PANEL_ID)).toBeUndefined();
			expect(host.getStatusBarItem(GIT_STATUS_ID)).toBeUndefined();
			expect(host.getEditorContributions('gutter')).toHaveLength(0);
			expect(host.getEditorContributions('decoration')).toHaveLength(0);

			await host.activate('git');

			const panel = host.getSidebarPanel(GIT_PANEL_ID);
			expect(panel).toBeDefined();
			expect(panel?.title).toBe('Source Control');
			expect(panel?.pluginId).toBe('git');
			expect(panel?.component).toBeDefined();

			const status = host.getStatusBarItem(GIT_STATUS_ID);
			expect(status).toBeDefined();
			expect(status?.alignment).toBe('left');
			expect(status?.pluginId).toBe('git');
			expect(status?.component).toBeDefined();

			const gutters = host.getEditorContributions('gutter');
			expect(gutters.some((e) => e.contribution.id === GIT_GUTTER_CONTRIBUTION.id && e.pluginId === 'git')).toBe(true);
			const decorations = host.getEditorContributions('decoration');
			expect(decorations.some((e) => e.contribution.id === GIT_DECORATION_CONTRIBUTION.id && e.pluginId === 'git')).toBe(true);
		});

		it('removes panel, status, and decorations on deactivate via host removal (no reimplementation)', async () => {
			const { host } = await makeHost();
			await host.activate('git');
			expect(host.getSidebarPanel(GIT_PANEL_ID)).toBeDefined();
			expect(host.getStatusBarItem(GIT_STATUS_ID)).toBeDefined();
			expect(host.getEditorContributions('gutter')).not.toHaveLength(0);

			await host.deactivate('git');

			expect(host.getSidebarPanel(GIT_PANEL_ID)).toBeUndefined();
			expect(host.getStatusBarItem(GIT_STATUS_ID)).toBeUndefined();
			expect(host.getSidebarPanels().some((p) => p.pluginId === 'git')).toBe(false);
			expect(host.getStatusBarItems().some((s) => s.pluginId === 'git')).toBe(false);
			expect(host.getEditorContributions('gutter').some((e) => e.pluginId === 'git')).toBe(false);
			expect(host.getEditorContributions('decoration').some((e) => e.pluginId === 'git')).toBe(false);
		});

		it('restores panel, status, and decorations on re-enable', async () => {
			const { host } = await makeHost();
			await host.activate('git');
			await host.deactivate('git');
			expect(host.getSidebarPanel(GIT_PANEL_ID)).toBeUndefined();

			await host.activate('git');

			expect(host.getSidebarPanel(GIT_PANEL_ID)).toBeDefined();
			expect(host.getStatusBarItem(GIT_STATUS_ID)).toBeDefined();
			expect(host.getEditorContributions('gutter').some((e) => e.pluginId === 'git')).toBe(true);
		});

		it('uses service-provided UI components when the UI bridge provides them (browser path)', async () => {
			const host = new PluginHost();
			host.register(gitRegistration);
			const mockPanel = (_target: any, _props: any) => ({ mock: 'panel' });
			const mockIcon = { mock: 'icon' };
			const mockStatus = (_target: any, _props: any) => ({ mock: 'status' });
			host.provideService(GIT_UI_COMPONENTS_KEY, {
				panelComponent: mockPanel,
				panelIcon: mockIcon,
				statusComponent: mockStatus
			});
			host.provideService(DIALOGS_SERVICE_KEY, {
				alert: mock(async () => {}),
				confirm: mock(async () => true)
			});

			await host.activate('git');

			expect(host.getSidebarPanel(GIT_PANEL_ID)?.component).toBe(mockPanel);
			expect(host.getSidebarPanel(GIT_PANEL_ID)?.icon).toBe(mockIcon);
			expect(host.getStatusBarItem(GIT_STATUS_ID)?.component).toBe(mockStatus);
		});

		it('activates default-enabled plugins generically via AppState.init (no feature names)', async () => {
			const host = new PluginHost();
			host.register(gitRegistration);
			const appState = new AppState({
				storage: createSharedMockStorage(),
				prefsStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
				pluginHost: host
			});
			expect(host.isPluginActive('git')).toBe(false);

			await appState.init();

			expect(host.isPluginActive('git')).toBe(true);
			expect(host.getSidebarPanel(GIT_PANEL_ID)).toBeDefined();
		});

		it('falls back to explorer when the active tab belongs to an inactive plugin', async () => {
			const host = new PluginHost();
			host.register(gitRegistration);
			const appState = new AppState({
				storage: createSharedMockStorage(),
				prefsStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
				pluginHost: host
			});
			await host.activate('git');
			appState.activeSidebarTab = GIT_PANEL_ID;
			expect(appState.activeSidebarTab).toBe(GIT_PANEL_ID);

			await host.deactivate('git');
			expect(appState.activeSidebarTab).toBe('explorer');
		});
	});

	describe('no feature identifiers in shell-owned UI code', () => {
		const shellFiles = [
			'packages/ui/src/AppShell.svelte',
			'packages/ui/src/components/FileExplorer.svelte',
			'packages/ui/src/components/Editor.svelte',
			'packages/ui/src/index.ts',
			'packages/core/src/state.svelte.ts'
		];

		it('contains zero `git` identifiers in shell containers, entry, and app-state wiring', () => {
			const offenders: string[] = [];
			for (const rel of shellFiles) {
				const source = readFileSync(join(import.meta.dir, '../../../..', rel), 'utf-8');
				const code = stripComments(source);
				if (/git/i.test(code)) {
					const lines = code.split('\n');
					lines.forEach((line, idx) => {
						if (/git/i.test(line)) {
							offenders.push(`${rel}:${idx + 1}: ${line.trim().slice(0, 120)}`);
						}
					});
				}
			}
			expect(offenders).toEqual([]);
		});

		it('keeps MainLayout free of panel/status feature references (diff-tab icon allowlisted pending tab interface)', () => {
			const source = readFileSync(
				join(import.meta.dir, '../../../../packages/ui/src/components/MainLayout.svelte'),
				'utf-8'
			);
			const code = stripComments(source);
			const lines = code.split('\n');
			const offenders = lines.filter((line, idx) => {
				if (!/git/i.test(line)) return false;
				// Allowlist: diff-tab icon + its explanatory comment (stripped already,
				// so only the import and usage lines remain). Diff tabs
				// (`tab.type === 'diff'`) predate panel/status/editor contributions
				// and need a generic tab-content interface (proposed follow-up).
				if (/GitDiffIcon/.test(line)) return false;
				return true;
			});
			expect(offenders).toEqual([]);
			// Panel flows purely through the registry: no hardcoded tab branch.
			expect(code).not.toMatch(/activeSidebarTab\s*===\s*['"]git['"]/);
			expect(code).not.toMatch(/GitPanel/);
			expect(code).not.toMatch(/showGit/);
		});

		it('registers no feature-specific host members (generic interfaces only)', () => {
			const memberPattern =
				/^\s*(?:(?:async|private|public|protected|readonly|static|get|set)\s+)*[A-Za-z_$][\w$]*\s*[(<:?=]/;
			for (const file of ['types.ts', 'host.svelte.ts', 'services.ts', 'hooks.ts', 'events.ts']) {
				const source = readFileSync(join(import.meta.dir, file), 'utf-8');
				const code = stripComments(source);
				const offenders = code
					.split('\n')
					.filter((line) => memberPattern.test(line))
					.filter((line) => /git/i.test(line));
				expect(offenders).toEqual([]);
			}
		});
	});

	describe('editor precedence and rebuild equivalence', () => {
		it('composes feature gutter into its compartment without disturbing other compartments', async () => {
			const { host } = await makeHost();
			await host.activate('git');

			const entries = host.getEditorContributions();
			const composed = composeEditorContributions(entries, host.editorCompartments, 'markdown');

			// Single composed config: gutter + decorations + keybindings compartments.
			expect(composed.length).toBe(3);
		});

		it('remove-plugin yields the same editor registry as a clean build without it', async () => {
			const { host } = await makeHost();
			await host.activate('git');
			expect(host.getEditorContributions().some((e) => e.pluginId === 'git')).toBe(true);

			host.removePluginEditorContributions('git');

			const clean = new PluginHost();
			expect(host.getEditorContributions()).toEqual(clean.getEditorContributions());
		});

		it('deactivation yields the same editor registry as before activation', async () => {
			const { host } = await makeHost();
			const before = host.getEditorContributions();

			await host.activate('git');
			expect(host.getEditorContributions()).not.toEqual(before);

			await host.deactivate('git');
			expect(host.getEditorContributions()).toEqual(before);
		});
	});
});
