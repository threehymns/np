import '../../../../../tests/contract/rune-setup';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PluginHost } from '../host.svelte';
import { WORKSPACE_SERVICE_KEY, LSP_PLATFORM_SERVICE_KEY, type WorkspaceLike } from '../services';
import { createPilotComponent, type UIContributionComponent } from '../ui-contributions';
import {
	LSP_RESTART_ALL_SERVERS_COMMAND,
	LSP_RESTART_SERVER_COMMAND,
	LSP_STOP_ALL_SERVERS_COMMAND,
	LSP_STOP_SERVER_COMMAND,
	LSP_VIEW_LOGS_COMMAND
} from './commands';
import { LSP_DIAGNOSTIC_DECORATION_ID } from './diagnostic-decorations';
import { LspRuntime, LSP_RUNTIME_SERVICE_KEY, lspServerKey } from './lifecycle';
import { LspLogStore, LSP_LOG_STORE_SERVICE_KEY } from './logs';
import { lspRegistration } from './registration';
import { LSP_LOGS_TAB_ID, LSP_STATUS_ITEM_ID, LSP_UI_COMPONENTS_KEY } from './ui';
import {
	createRealProcessPlatform,
	isProcessAlive,
	waitFor,
	type RealProcessPlatform
} from '../../../../../tests/fixtures/lsp-platform';

/**
 * The status menu, the Logs tab and the commands behind both (spec #263,
 * ticket #266, ADR 0015, ADR 0009).
 *
 * The servers are real: the scripted stub over real pipes, so "restart", "stop"
 * and "no orphan process" are observed as processes rather than as flags. Every
 * action goes through `host.executeCommand`, because the status menu and the
 * command palette are two views of one registry and a menu item that bypassed it
 * would be a second, silently different implementation.
 */

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()!();
});

/** What the host still held for the plugin at one moment. */
interface OffState {
	readonly statusItems: number;
	readonly tabContents: number;
	readonly commands: number;
	readonly decorations: number;
	readonly servers: number;
}

interface Harness {
	readonly host: PluginHost;
	readonly platform: RealProcessPlatform;
	readonly runtime: LspRuntime;
	readonly tabs: Array<{ id: string; type: 'document' | 'diff'; pluginId?: string }>;
	/** Snapshots taken while the plugin's own teardown was running. */
	readonly duringCleanup: OffState[];
	readonly activeTabId: () => string;
	open(path: string, content: string): void;
}

function makeProject(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'lsp-ui-'));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	for (const [relative, content] of Object.entries(files)) {
		const path = join(root, relative);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	return root;
}

async function startPlugin(
	options: { script?: readonly string[]; uiComponents?: boolean } = {}
): Promise<Harness> {
	const host = new PluginHost({ platform: 'desktop' });
	const platform = createRealProcessPlatform(
		options.script ? { script: options.script } : {}
	);
	host.provideService(LSP_PLATFORM_SERVICE_KEY, platform);

	if (options.uiComponents) {
		host.provideService(LSP_UI_COMPONENTS_KEY, {
			statusItemComponent: createPilotComponent('provided-status') as UIContributionComponent,
			logsComponent: createPilotComponent('provided-logs') as UIContributionComponent
		});
	}

	const tabs: Harness['tabs'] = [];
	const duringCleanup: OffState[] = [];
	let runtime: LspRuntime | undefined;

	const snapshot = (): OffState => ({
		statusItems: host.getStatusBarItems().length,
		tabContents: host.getTabContents().length,
		commands: host.getCommands().filter((command) => command.id.startsWith('lsp.')).length,
		decorations: host
			.getEditorContributions('decoration')
			.filter((entry) => entry.pluginId === 'lsp').length,
		servers: runtime?.getStatusRows().length ?? 0
	});

	const workspace = {
		project: { rootOrigin: null },
		activeDocument: null,
		tabs,
		activeTabId: '',
		closeTab(id: string) {
			// The off-state proof: the host removes a plugin's contributions before
			// running its cleanup, so anything the plugin's own teardown still sees
			// is already gone.
			duringCleanup.push(snapshot());
			const index = tabs.findIndex((tab) => tab.id === id);
			if (index >= 0) tabs.splice(index, 1);
			if (workspace.activeTabId === id) workspace.activeTabId = '';
		},
		saveFolderState: async () => {}
	} as unknown as WorkspaceLike;
	host.provideService(WORKSPACE_SERVICE_KEY, workspace);

	host.register(lspRegistration);
	await host.activate('lsp');
	runtime = host.getService<LspRuntime>(LSP_RUNTIME_SERVICE_KEY)!;
	cleanups.push(async () => {
		if (host.isPluginActive('lsp')) await host.deactivate('lsp');
	});

	return {
		host,
		platform,
		runtime,
		tabs,
		duringCleanup,
		activeTabId: () => workspace.activeTabId,
		open(path, content) {
			host.emit('document:opened', {
				document: {
					origin: { scheme: 'file', path, name: path.slice(path.lastIndexOf('/') + 1) },
					fileName: path.slice(path.lastIndexOf('/') + 1),
					content
				}
			});
		}
	};
}

async function waitForRunning(runtime: LspRuntime, count: number): Promise<void> {
	await waitFor(() => runtime.getStatusRows().filter((server) => server.state === 'running').length === count, {
		label: `${count} running server(s)`
	});
}

function lspCommands(host: PluginHost): string[] {
	return host
		.getCommands()
		.map((command) => command.id)
		.filter((id) => id.startsWith('lsp.'))
		.sort();
}

/** Lets queued microtasks and timers run without asserting on elapsed time. */
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 60));
}

function captureErrors(): { read(): string; restore(): void } {
	const original = console.error;
	const sink: string[] = [];
	console.error = (...args: unknown[]) => {
		sink.push(args.map((arg) => String(arg)).join(' '));
	};
	return { read: () => sink.join('\n'), restore: () => (console.error = original) };
}

/** Two nested projects, so "one server" means one and restart can be per-server. */
function nestedProject(): { root: string; outer: string; inner: string } {
	const root = makeProject({
		'tsconfig.json': '{}',
		'packages/app/tsconfig.json': '{}',
		'src/a.ts': '',
		'packages/app/src/b.ts': ''
	});
	return { root, outer: join(root, 'src/a.ts'), inner: join(root, 'packages/app/src/b.ts') };
}

describe('Status menu, Logs tab and their commands (#266)', () => {
	it('contributes a status item, a Logs tab and one command per action', async () => {
		const harness = await startPlugin();
		const { host } = harness;

		// Headless hosts publish no components, so the contribution still registers
		// with a pilot component rather than failing to activate.
		expect(host.getStatusBarItem(LSP_STATUS_ITEM_ID)).toMatchObject({
			id: LSP_STATUS_ITEM_ID,
			alignment: 'left',
			pluginId: 'lsp'
		});
		expect(host.getStatusBarItems()).toHaveLength(1);
		// The shell resolves a tab's content by plugin id, so that is its id.
		expect(host.getTabContent('lsp')).toMatchObject({ id: 'lsp', title: 'Logs', pluginId: 'lsp' });
		expect(lspCommands(host)).toEqual([
			LSP_RESTART_ALL_SERVERS_COMMAND,
			LSP_RESTART_SERVER_COMMAND,
			LSP_STOP_ALL_SERVERS_COMMAND,
			LSP_STOP_SERVER_COMMAND,
			LSP_VIEW_LOGS_COMMAND
		]);
		// Diagnostics ride the same decoration compartment as everything else.
		expect(
			host
				.getEditorContributions('decoration')
				.some((entry) => entry.contribution.id === LSP_DIAGNOSTIC_DECORATION_ID)
		).toBe(true);
	});

	it('uses the components the UI layer provides when it provides some', async () => {
		const withComponents = await startPlugin({ uiComponents: true });
		const statusItem = withComponents.host.getStatusBarItem(LSP_STATUS_ITEM_ID)!;
		const tab = withComponents.host.getTabContent('lsp')!;
		expect(statusItem.component).toBeDefined();
		expect(tab.component).toBeDefined();

		// Published components win over the pilot fallback: the status item is the
		// whole menu, so a headless fallback there is an empty button, not a menu.
		const pilots = await startPlugin();
		expect(pilots.host.getStatusBarItem(LSP_STATUS_ITEM_ID)?.component).not.toBe(
			statusItem.component
		);
	});

	it('keeps the per-server commands out of the palette, where they have no target', async () => {
		const { host } = await startPlugin();
		const perServer = [LSP_RESTART_SERVER_COMMAND, LSP_STOP_SERVER_COMMAND];
		for (const id of perServer) {
			expect(host.getCommand(id)?.isVisible?.()).toBe(false);
		}
		// Everything the palette can actually run is offered there.
		for (const id of [LSP_RESTART_ALL_SERVERS_COMMAND, LSP_STOP_ALL_SERVERS_COMMAND, LSP_VIEW_LOGS_COMMAND]) {
			expect(host.getCommand(id)?.isVisible?.()).toBeUndefined();
		}
	});

	it('restarts one server at a time and re-opens one the user stopped', async () => {
		const { root, outer, inner } = nestedProject();
		const harness = await startPlugin();
		harness.open(outer, '');
		harness.open(inner, '');
		await waitForRunning(harness.runtime, 2);
		const outerKey = lspServerKey('typescript', root);
		const innerKey = lspServerKey('typescript', join(root, 'packages/app'));
		const [outerPid, innerPid] = harness.platform.pids;

		expect(await harness.host.executeCommand(LSP_STOP_SERVER_COMMAND, outerKey)).toBe(true);
		await waitFor(() => !isProcessAlive(outerPid), { label: 'the stopped server to exit' });
		expect(isProcessAlive(innerPid)).toBe(true);
		// A stop is final: editing the document does not bring it back.
		harness.open(outer, 'const a = 1;');
		await settle();
		expect(harness.platform.spawned).toHaveLength(2);

		// An explicit restart is what re-opens it, with its document re-synced.
		expect(await harness.host.executeCommand(LSP_RESTART_SERVER_COMMAND, outerKey)).toBe(true);
		await waitFor(() => harness.platform.spawned.length === 3, { label: 'the restart' });
		expect(harness.runtime.getStatusRows().find((server) => server.server === outerKey)?.state).toBe(
			'running'
		);
		// The untouched server was neither restarted nor stopped along with it.
		expect(harness.platform.pids[1]).toBe(innerPid);
		expect(isProcessAlive(innerPid)).toBe(true);
	});

	it('restarts and stops every server through one command', async () => {
		const { root, outer, inner } = nestedProject();
		const harness = await startPlugin();
		harness.open(outer, '');
		harness.open(inner, '');
		await waitForRunning(harness.runtime, 2);
		const firstPids = [...harness.platform.pids];

		await harness.host.executeCommand(LSP_RESTART_ALL_SERVERS_COMMAND);

		await waitForRunning(harness.runtime, 2);
		await waitFor(() => harness.platform.spawned.length === 4, { label: 'both restarts' });
		for (const pid of firstPids) {
			await waitFor(() => !isProcessAlive(pid), { label: `old pid ${pid} to exit` });
		}
		expect(harness.platform.spawned.slice(2).map((entry) => entry.cwd).sort()).toEqual(
			[root, join(root, 'packages/app')].sort()
		);

		await harness.host.executeCommand(LSP_STOP_ALL_SERVERS_COMMAND);

		for (const pid of harness.platform.pids) {
			await waitFor(() => !isProcessAlive(pid), { label: `pid ${pid} to exit` });
		}
		expect(harness.runtime.getStatusRows().every((server) => server.state === 'stopped')).toBe(true);
	});

	it('treats stopping nothing as an ordinary outcome', async () => {
		const harness = await startPlugin();
		const errors = captureErrors();
		try {
			expect(await harness.host.executeCommand(LSP_STOP_ALL_SERVERS_COMMAND)).toBe(true);
			expect(await harness.host.executeCommand(LSP_RESTART_ALL_SERVERS_COMMAND)).toBe(true);
		} finally {
			errors.restore();
		}
		expect(harness.platform.spawned).toHaveLength(0);
		expect(harness.runtime.getStatusRows()).toEqual([]);
		expect(errors.read()).toBe('');
	});

	it('reports nothing when asked to restart or stop a server that is not there', async () => {
		const harness = await startPlugin();
		expect(await harness.host.executeCommand(LSP_RESTART_SERVER_COMMAND, 'nothing@/nowhere')).toBe(
			false
		);
		expect(await harness.host.executeCommand(LSP_STOP_SERVER_COMMAND)).toBe(false);
	});

	it('opens and focuses the Logs tab, and does not stack duplicates', async () => {
		const harness = await startPlugin();
		expect(harness.tabs).toEqual([]);
		expect(harness.activeTabId()).toBe('');

		expect(await harness.host.executeCommand(LSP_VIEW_LOGS_COMMAND)).toBe(true);
		expect(harness.tabs).toEqual([{ id: LSP_LOGS_TAB_ID, type: 'diff', pluginId: 'lsp' }]);
		expect(harness.activeTabId()).toBe(LSP_LOGS_TAB_ID);

		// The palette can ask for the same tab as the menu, so asking twice focuses
		// rather than opening a second one.
		expect(await harness.host.executeCommand(LSP_VIEW_LOGS_COMMAND)).toBe(true);
		expect(harness.tabs).toHaveLength(1);
	});

	it('reports a missing workspace rather than opening a tab nowhere', async () => {
		const host = new PluginHost({ platform: 'desktop' });
		host.register(lspRegistration);
		await host.activate('lsp');
		cleanups.push(async () => {
			if (host.isPluginActive('lsp')) await host.deactivate('lsp');
		});

		expect(await host.executeCommand(LSP_VIEW_LOGS_COMMAND)).toBe(false);
	});

	it('opens the Logs tab on one server when the menu names it', async () => {
		const { root, outer } = nestedProject();
		const harness = await startPlugin();
		harness.open(outer, '');
		await waitForRunning(harness.runtime, 1);
		const logs = harness.host.getService<LspLogStore>(LSP_LOG_STORE_SERVICE_KEY)!;
		const key = lspServerKey('typescript', root);
		expect(logs.focused).toEqual({ server: null, request: 0 });

		// What the status menu's per-server entry dispatches: the tab opens already
		// narrowed to that server, rather than on whichever server was read last.
		expect(await harness.host.executeCommand(LSP_VIEW_LOGS_COMMAND, key)).toBe(true);
		expect(logs.focused).toEqual({ server: key, request: 1 });
		expect(harness.activeTabId()).toBe(LSP_LOGS_TAB_ID);

		// The palette entry has no server to offer, so it means every server.
		expect(await harness.host.executeCommand(LSP_VIEW_LOGS_COMMAND)).toBe(true);
		expect(logs.focused).toEqual({ server: null, request: 2 });
	});

	it('asks for nothing when the tab could not open, since no tab would read it', async () => {
		const host = new PluginHost({ platform: 'desktop' });
		host.register(lspRegistration);
		await host.activate('lsp');
		cleanups.push(async () => {
			if (host.isPluginActive('lsp')) await host.deactivate('lsp');
		});
		const logs = host.getService<LspLogStore>(LSP_LOG_STORE_SERVICE_KEY)!;

		expect(await host.executeCommand(LSP_VIEW_LOGS_COMMAND, 'typescript@/repo')).toBe(false);
		expect(logs.focused).toEqual({ server: null, request: 0 });
	});

	it('removes the status item, the tab and the commands on disable, with no orphan process', async () => {
		const { root, outer, inner } = nestedProject();
		const harness = await startPlugin();
		harness.open(outer, '');
		harness.open(inner, '');
		await waitForRunning(harness.runtime, 2);
		await harness.host.executeCommand(LSP_VIEW_LOGS_COMMAND);
		const pids = [...harness.platform.pids];
		expect(pids.every((pid) => isProcessAlive(pid))).toBe(true);

		await harness.host.deactivate('lsp');

		for (const pid of pids) {
			await waitFor(() => !isProcessAlive(pid), { label: `pid ${pid} to exit` });
		}
		expect(harness.host.isPluginActive('lsp')).toBe(false);
		expect(harness.host.getStatusBarItems()).toEqual([]);
		expect(harness.host.getTabContents()).toEqual([]);
		expect(lspCommands(harness.host)).toEqual([]);
		expect(
			harness.host
				.getEditorContributions('decoration')
				.filter((entry) => entry.pluginId === 'lsp')
		).toEqual([]);
		expect(harness.host.getLspDescriptors()).toEqual([]);
		// A plugin-owned view closes with the plugin (ADR 0009).
		expect(harness.tabs).toEqual([]);
		expect(harness.activeTabId()).toBe('');
	});

	it('removes its contributions before its own cleanup runs', async () => {
		const { outer } = nestedProject();
		const harness = await startPlugin();
		harness.open(outer, '');
		await waitForRunning(harness.runtime, 1);
		await harness.host.executeCommand(LSP_VIEW_LOGS_COMMAND);

		await harness.host.deactivate('lsp');

		// Observed from inside the plugin's own teardown: everything the host
		// contributed is already gone, while the process it still had to stop is
		// running. Cleanup is what is left, not the off-state.
		expect(harness.duringCleanup).toEqual([
			{
				statusItems: 0,
				tabContents: 0,
				commands: 0,
				decorations: 0,
				servers: 1
			}
		]);
		for (const pid of harness.platform.pids) {
			await waitFor(() => !isProcessAlive(pid), { label: `pid ${pid} to exit` });
		}
	});
});
