import type { PluginCommand } from '../commands';
import type { WorkspaceLike } from '../services';
import { manifest } from './manifest';
import { LSP_LOGS_TAB_ID } from './ui';

/**
 * Server lifecycle commands (spec #263, ticket #266, ADR 0015).
 *
 * One registry serves two views: the status menu and the command palette read
 * the same entries, so a menu item and its palette entry can never disagree
 * about what restarting a server does. Resolved collaborators are read at
 * action time, so activation order relative to app construction does not
 * matter and a plugin that is off simply has no commands to run.
 *
 * The collaborators are plugin-local, not host surface: the host knows nothing
 * about servers (ADR 0019).
 */
export interface LspCommandContext {
	/** The runtime, or undefined while the plugin is not the active owner. */
	runtime(): LspRuntimeLike | undefined;
	getWorkspace(): WorkspaceLike | undefined;
	/**
	 * Asks the Logs tab to show one server. Resolved at action time and separate
	 * from the workspace because the tab reads the request from the store it
	 * already renders, and the tab's own service is the only channel between a
	 * command and a view the host mounts (ADR 0016).
	 */
	requestFocus(server?: string): void;
}

/**
 * The slice of the runtime the commands drive, declared here so the command
 * module does not import the lifecycle's process handling to describe it.
 */
export interface LspRuntimeLike {
	restartServer(server: string): Promise<boolean>;
	stopServer(server: string): Promise<boolean>;
	restartAll(): Promise<void>;
	stopAll(): Promise<void>;
}

export const LSP_RESTART_SERVER_COMMAND = 'lsp.restartServer';
export const LSP_STOP_SERVER_COMMAND = 'lsp.stopServer';
export const LSP_RESTART_ALL_SERVERS_COMMAND = 'lsp.restartAllServers';
export const LSP_STOP_ALL_SERVERS_COMMAND = 'lsp.stopAllServers';
export const LSP_VIEW_LOGS_COMMAND = 'lsp.viewLogs';

const CATEGORY = 'Language Servers';

export function createLspCommands(ctx: LspCommandContext): PluginCommand[] {
	return [
		{
			id: LSP_RESTART_SERVER_COMMAND,
			label: 'Language Servers: Restart Server',
			category: CATEGORY,
			// Takes the server key the status menu holds, so the palette has no
			// target to offer: one entry per running server would be a registry
			// rebuilt on every server change, and a single entry that picks a
			// server by itself would be a guess.
			isVisible: () => false,
			action: async (server?: string) => {
				if (!isServerKey(server)) return false;
				return (await ctx.runtime()?.restartServer(server)) ?? false;
			}
		},
		{
			id: LSP_STOP_SERVER_COMMAND,
			label: 'Language Servers: Stop Server',
			category: CATEGORY,
			isVisible: () => false,
			action: async (server?: string) => {
				if (!isServerKey(server)) return false;
				return (await ctx.runtime()?.stopServer(server)) ?? false;
			}
		},
		{
			id: LSP_RESTART_ALL_SERVERS_COMMAND,
			label: 'Language Servers: Restart All Servers',
			category: CATEGORY,
			action: async () => {
				await ctx.runtime()?.restartAll();
				return true;
			}
		},
		{
			id: LSP_STOP_ALL_SERVERS_COMMAND,
			label: 'Language Servers: Stop All Servers',
			category: CATEGORY,
			// Nothing to stop is an ordinary outcome, not a failure: a session
			// where no server ever started should not report an error for asking.
			action: async () => {
				await ctx.runtime()?.stopAll();
				return true;
			}
		},
		{
			id: LSP_VIEW_LOGS_COMMAND,
			label: 'Language Servers: View Logs',
			category: CATEGORY,
			// Takes the server key the status menu holds, and opens the tab already
			// narrowed to it, which is what makes the entry worth having per server.
			// Without one — the palette has no target to offer — it means every
			// server, so the two routes into the tab are the same command reading
			// the same registry rather than two ways to open it.
			action: (server?: string) => {
				// Nothing is focused when the tab cannot open: a narrowing request
				// that no tab ever reads would silently outlive the command.
				if (!ctx.getWorkspace()) return false;
				ctx.requestFocus(isServerKey(server) ? server : undefined);
				return openLogsTab(ctx.getWorkspace());
			}
		}
	];
}

/**
 * Opens the Logs tab, or focuses it when it is already open. Idempotent
 * because the command is reachable from the palette as well as the menu, and
 * asking twice for the same tab must not stack duplicates.
 */
export function openLogsTab(workspace: WorkspaceLike | undefined): boolean {
	if (!workspace) return false;
	if (!workspace.tabs.some((tab) => tab.id === LSP_LOGS_TAB_ID)) {
		// `diff` is the workspace's only non-document tab kind, so it is what a
		// contributed view is; the shell keys the rendered content on `pluginId`,
		// which is this plugin's manifest id either way.
		workspace.tabs.push({ id: LSP_LOGS_TAB_ID, type: 'diff', pluginId: manifest.id });
	}
	workspace.activeTabId = LSP_LOGS_TAB_ID;
	return true;
}

function isServerKey(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}
