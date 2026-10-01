import '../../../../tests/contract/rune-setup';
import { describe, it, expect, mock } from 'bun:test';
import { PluginHost } from './host.svelte';
import { gitRegistration } from './git/registration';
import { WORKSPACE_SERVICE_KEY, DIALOGS_SERVICE_KEY } from './services';
import type { PluginHostInterface, PluginRegistration } from './types';
import { Workspace } from '../workspace.svelte';
import { MemorySessionPersistence } from '../persistence';
import type { FileOrigin, Storage } from '../storage';
import type { VCSAdapter } from '../project/vcs';

/**
 * TEST-ONLY second contributor (finding 6): no product exporter is needed
 * to prove the spec's "second contributor uses the same host path with no
 * Git-specific host methods added". This fixture exercises
 * `registerWorkspaceOpenedHook` + `provideService`/`getService` +
 * `registerCommands` together through the generic host path, alongside the
 * Git plugin, and keeps working with Git disabled.
 */

const SECOND_ID = 'second-contributor';
const SECOND_COMMAND_ID = 'second.ping';
const SECOND_STATE_KEY = 'second-contributor:state';

interface SecondContributorEvents {
	workspaceOpenedOrigins: FileOrigin[];
	sawWorkspaceService: boolean;
	commandsRun: number;
}

function secondContributorRegistration(events: SecondContributorEvents): PluginRegistration {
	return {
		manifest: { id: SECOND_ID, name: 'Second Contributor', version: 0 },
		setup: (host: PluginHostInterface) => {
			// Generic service sharing: publish opaque state under our own key.
			host.provideService(SECOND_STATE_KEY, {
				ping: () => {
					events.commandsRun++;
					return 'pong';
				}
			});
			// Generic folder-open participation: observe the origin and
			// resolve the workspace lazily through the shared key (Git's path).
			const removeHook = host.registerWorkspaceOpenedHook(SECOND_ID, async (context) => {
				events.workspaceOpenedOrigins.push(context.origin);
				events.sawWorkspaceService =
					host.getService<{ repository: unknown }>(WORKSPACE_SERVICE_KEY) !== undefined;
			});
			// Generic command contribution consuming the published service.
			host.registerCommands(SECOND_ID, [
				{
					id: SECOND_COMMAND_ID,
					label: 'Second: Ping',
					category: 'Test',
					action: () => {
						const state = host.getService<{ ping(): string }>(SECOND_STATE_KEY);
						if (!state) {
							throw new Error(
								`Service "${SECOND_STATE_KEY}" is unavailable.\n` +
									`Action: Ensure the "${SECOND_ID}" plugin is activated before running "${SECOND_COMMAND_ID}".`
							);
						}
						return state.ping();
					}
				}
			]);
			return () => {
				removeHook();
			};
		}
	};
}

const rootOrigin: FileOrigin = { scheme: 'file', path: '/repo', name: 'repo' };

function createHarnessStorage(): Storage {
	return {
		readFile: mock(async () => ''),
		writeFile: mock(async () => {}),
		saveFile: mock(async (content: string, existingOrigin?: FileOrigin) => existingOrigin ?? rootOrigin),
		openFileDialog: mock(async () => null),
		openDirectoryDialog: mock(async () => null),
		saveFileDialog: mock(async () => null),
		readDirectory: mock(async () => []),
		exists: mock(async () => true),
		deleteFile: mock(async () => {}),
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

function createVcsFactory(): (root: FileOrigin) => VCSAdapter {
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

async function makeHarness() {
	const events: SecondContributorEvents = { workspaceOpenedOrigins: [], sawWorkspaceService: false, commandsRun: 0 };
	const host = new PluginHost();
	host.register(gitRegistration);
	host.register(secondContributorRegistration(events));
	host.provideService(DIALOGS_SERVICE_KEY, {
		alert: mock(async () => {}),
		confirm: mock(async () => true)
	});
	const workspace = new Workspace(createHarnessStorage(), createVcsFactory(), new MemorySessionPersistence(), host);
	await host.activateAll();
	return { events, host, workspace };
}

describe('Second contributor on the generic host path (spec genericity proof)', () => {
	it('shares the generic host path with Git and adds no Git-specific host methods', async () => {
		const { events, host, workspace } = await makeHarness();

		// No feature-specific surface accumulated on the host: nothing
		// Git-shaped (or repository-shaped) on the runtime prototype.
		const runtimeMembers = Object.getOwnPropertyNames(Object.getPrototypeOf(host));
		expect(runtimeMembers.filter((name) => /git|repository/i.test(name))).toEqual([]);
		expect((host as any).getRepository).toBeUndefined();
		expect((host as any).getGitAdapter).toBeUndefined();

		await workspace.openDirectory();

		// Both contributors ran through the same runWorkspaceOpened: Git
		// owns its repository lifecycle, the second contributor observed it.
		expect(workspace.repository).not.toBeNull();
		expect(events.workspaceOpenedOrigins).toHaveLength(1);
		expect(events.workspaceOpenedOrigins[0]).toEqual(rootOrigin);
		expect(events.sawWorkspaceService).toBe(true);

		// Commands and services compose without Git-specific host plumbing.
		expect(host.getCommand('git.stage')).toBeDefined();
		expect(host.executeCommand(SECOND_COMMAND_ID)).toBe('pong');
		expect(events.commandsRun).toBe(1);
	});

	it('keeps working with Git disabled', async () => {
		const { events, host, workspace } = await makeHarness();
		await workspace.openDirectory();
		expect(workspace.repository).not.toBeNull();

		await host.deactivate('git');
		expect(host.getCommand('git.stage')).toBeUndefined();
		expect(workspace.repository).toBeNull();

		// The generic path is unaffected: hook still observes folder open,
		// commands and services still resolve.
		expect(host.executeCommand(SECOND_COMMAND_ID)).toBe('pong');
		await workspace.openDirectory();
		expect(events.workspaceOpenedOrigins).toHaveLength(2);
		expect(workspace.repository).toBeNull();
	});
});
