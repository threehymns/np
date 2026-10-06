import {
	COMPLETION_COORDINATOR_SERVICE_KEY,
	COMPLETION_RESOLVE_SERVICE_KEY,
	HOVER_COORDINATOR_SERVICE_KEY,
	WORKSPACE_SERVICE_KEY,
	type WorkspaceLike
} from '../services';
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
 * the protocol, the diagnostics and the log buffers live here (ADR 0020).
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
	// The same runtime under the generic name, because that is the name the editor
	// shell knows: it composes a completion query without knowing that a language
	// server is what will answer it. Publishing both is the seam ADR 0008 describes —
	// one provider, two consumers, each reaching for the key it knows.
	host.provideService(COMPLETION_COORDINATOR_SERVICE_KEY, runtime);
	// The same runtime under the hover and resolve names (spec #280): the shell
	// asks about a position and hands back a suggestion without naming a server,
	// and resolve rides with hover as the doc-fill path because it has no display
	// surface of its own (#295).
	host.provideService(HOVER_COORDINATOR_SERVICE_KEY, runtime);
	host.provideService(COMPLETION_RESOLVE_SERVICE_KEY, runtime);

	// One closure for both events: opening a document and changing one are the
	// same work — resolve the server, start it if the file is served, sync the
	// current text — and the runtime already treats identical text as nothing to
	// resend. Two copies of this would be two places for the next event to miss.
	const syncDocumentEvent = (payload: unknown): void => {
		const input = readDocumentInput(payload);
		if (input) void runtime.openDocument(input);
	};
	const stopObserving = [
		host.on('document:opened', syncDocumentEvent, manifest.id),
		host.on('document:changed', syncDocumentEvent, manifest.id)
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
	//
	// A rebuild reconfigures *all three* compartments, not just the decoration one
	// (see `reconfigureEditorContributions`), and a server publishes a burst: one
	// report per file it has an opinion about, plus a fresh set after every
	// keystroke it answers. Coalesced per tick so a burst costs one rebuild rather
	// than one per report, which is the difference between re-instantiating every
	// other decoration contribution dozens of times a second and once.
	const unsubscribeDiagnostics = diagnostics.subscribe(
		createRepaintScheduler(() => host.rebuildEditorContributions())
	);

	const getWorkspace = (): WorkspaceLike | undefined =>
		host.getService<WorkspaceLike>(WORKSPACE_SERVICE_KEY);

	host.registerCommands(
		manifest.id,
		createLspCommands({
			runtime: () => host.getService<LspRuntime>(LSP_RUNTIME_SERVICE_KEY),
			getWorkspace,
			// Closed over rather than resolved through the host: the store is the one
			// this setup made, and the tab reads this same instance, so resolving it
			// by key here would only be a second way to name it.
			requestFocus: (server?: string) => logs.requestFocus(server)
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
 * Coalesces many repaint requests into one per tick.
 *
 * A publish arrives per file per edit, and each request costs a full
 * reconfiguration of the editor's compartments, so a burst is worth one rather
 * than one-per-report. A microtask is enough: the point is to collapse a burst
 * that has already landed, not to wait for the frame — a single publish is still
 * repainted before the browser paints, because the microtask runs first.
 *
 * Exported for the assertion, since "one rebuild per burst" is otherwise only
 * observable by timing a real server.
 */
export function createRepaintScheduler(request: () => void): () => void {
	let queued = false;
	return () => {
		if (queued) return;
		queued = true;
		queueMicrotask(() => {
			queued = false;
			request();
		});
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
