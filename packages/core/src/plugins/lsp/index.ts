import { WORKSPACE_SERVICE_KEY, type WorkspaceLike } from '../services';
import type { PluginCleanup, PluginHostInterface } from '../types';
import { createPilotComponent } from '../ui-contributions';
import { manifest } from './manifest';
import { createLspCommands } from './commands';
import { LSP_DESCRIPTORS } from './descriptors';
import { createDiagnosticEditorContribution } from './diagnostic-decorations';
import { LspDiagnosticsStore } from './diagnostics';
import { LspLogStore, LSP_LOG_STORE_SERVICE_KEY } from './logs';
import { LspRuntime, LSP_RUNTIME_SERVICE_KEY, type LspDocumentInput } from './lifecycle';
import {
	getLspUIComponents,
	LSP_LOGS_TAB_ID,
	LSP_LOGS_TAB_TITLE,
	LSP_STATUS_ITEM_ID,
	LSP_STATUS_ITEM_ORDER
} from './ui';
import { toFileUri } from './root';

/**
 * Setup for the LSP Core Plugin.
 *
 * Owns everything about language servers except their configuration: the
 * descriptors are registered with the host (data), and the client, the process,
 * the protocol, the diagnostics and the log buffers live here (ADR 0019).
 * `@np/core` learns the words "command, arguments, root markers, served
 * languages" and nothing else, so disabling this plugin leaves the host with no
 * LSP surface at all rather than a client with no servers.
 *
 * Documents arrive as host events (ADR 0013), which is what makes "a server
 * starts on the first served file" true without the editor knowing that servers
 * exist: a file no descriptor serves resolves to nothing and costs nothing.
 *
 * Presentation is contributory (ADR 0016, ADR 0015): diagnostics arrive as a
 * decoration contribution, the status item and the Logs tab as UI contributions,
 * and every action either the menu or the palette offers is a registered
 * command. The runtime and the log store are published as services because that
 * is how those contributions read plugin state without importing it.
 */
export function setup(host: PluginHostInterface): PluginCleanup {
	const logs = new LspLogStore();
	const diagnostics = new LspDiagnosticsStore();
	const runtime = new LspRuntime({ host, pluginId: manifest.id, logs, diagnostics });

	host.registerLspDescriptors(manifest.id, LSP_DESCRIPTORS);
	host.provideService(LSP_LOG_STORE_SERVICE_KEY, logs);
	host.provideService(LSP_RUNTIME_SERVICE_KEY, runtime);

	const stopObserving = [
		host.on('document:opened', (payload) => {
			const input = readDocumentInput(payload);
			if (input) void runtime.openDocument(input);
		}, manifest.id),
		host.on('document:changed', (payload) => {
			const input = readDocumentInput(payload);
			if (input) void runtime.openDocument(input);
		}, manifest.id)
	];

	host.registerEditorContributions(manifest.id, [
		createDiagnosticEditorContribution({
			currentUri: () => currentDocumentUri(host),
			store: diagnostics
		})
	]);

	// Diagnostics arrive from a pipe while the editor sits idle, and a plugin may
	// not dispatch into the view (ADR 0016). The editor already re-applies its
	// decoration compartment whenever the editor-contribution registry is
	// rebuilt, which is the one generic way to ask it to re-read what was
	// published. Nothing is re-registered here, so a replay can neither
	// duplicate a contribution nor lose one.
	const unsubscribeDiagnostics = diagnostics.subscribe(() => {
		host.rebuildEditorContributions();
	});

	const getWorkspace = (): WorkspaceLike | undefined =>
		host.getService<WorkspaceLike>(WORKSPACE_SERVICE_KEY);

	host.registerCommands(
		manifest.id,
		createLspCommands({
			runtime: () => host.getService<LspRuntime>(LSP_RUNTIME_SERVICE_KEY),
			getWorkspace
		})
	);

	const uiComponents = getLspUIComponents(host);
	host.registerStatusBarItems(manifest.id, [
		{
			id: LSP_STATUS_ITEM_ID,
			alignment: 'left',
			order: LSP_STATUS_ITEM_ORDER,
			component: uiComponents?.statusItemComponent ?? createPilotComponent('lsp-status')
		}
	]);
	// The tab's contribution id is the manifest id, not a separate one: the shell
	// resolves a tab's content by the plugin that owns the tab.
	host.registerTabContent(manifest.id, {
		id: manifest.id,
		title: LSP_LOGS_TAB_TITLE,
		...(uiComponents?.logsIcon ? { icon: uiComponents.logsIcon } : {}),
		component: uiComponents?.logsComponent ?? createPilotComponent('lsp-logs')
	});

	return async () => {
		for (const stop of stopObserving) stop();
		unsubscribeDiagnostics();
		// The view goes first. The tab offers actions on a plugin that is on its way
		// out, and stopping the processes is the slow part of a disable.
		closeLogsTab(getWorkspace());
		await runtime.dispose();
		// Clearing the buffers afterwards means a disabled plugin leaves nothing for
		// a Logs tab to render as current.
		logs.clear();
		diagnostics.clear();
	};
}

/**
 * The file the mounted editor is showing, read through the workspace rather than
 * from the editor: the view is host-owned and not plugin surface (ADR 0016), and
 * the active tab's document is the document the editor is bound to.
 */
function currentDocumentUri(host: PluginHostInterface): string | null {
	const origin = host.getService<WorkspaceLike>(WORKSPACE_SERVICE_KEY)?.activeDocument?.origin;
	return origin?.path ? toFileUri(origin.path) : null;
}

function closeLogsTab(workspace: WorkspaceLike | undefined): void {
	if (!workspace) return;
	for (const tab of workspace.tabs.filter((tab) => tab.id === LSP_LOGS_TAB_ID)) {
		workspace.closeTab(tab.id);
	}
}

/**
 * Reads a document lifecycle payload structurally. The workspace emits the
 * session and its origin; everything this plugin needs is the file's path, its
 * name, its text, and the language already resolved for it, so the payload is
 * read as a shape rather than imported as a `DocumentSession` — a plugin with a
 * hard type on the session could not be driven by a test, and the document
 * lifecycle is not this plugin's contract.
 */
function readDocumentInput(payload: unknown): LspDocumentInput | null {
	const document = (payload as { document?: DocumentShape } | undefined)?.document;
	if (!document) return null;
	const path = document.origin?.path ?? null;
	if (!path) return null;
	return {
		path,
		fileName: document.fileName ?? path,
		content: document.content ?? '',
		language: document.language?.name ?? null
	};
}

interface DocumentShape {
	readonly origin?: { readonly path?: string } | null;
	readonly fileName?: string;
	readonly content?: string;
	readonly language?: { readonly name?: string } | null;
}

export { manifest };
export default { manifest, setup };