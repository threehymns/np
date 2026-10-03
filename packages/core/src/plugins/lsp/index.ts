import type { PluginCleanup, PluginHostInterface } from '../types';
import { manifest } from './manifest';
import { LSP_DESCRIPTORS } from './descriptors';
import { LspLogStore, LSP_LOG_STORE_SERVICE_KEY } from './logs';
import { LspRuntime, LSP_RUNTIME_SERVICE_KEY, type LspDocumentInput } from './lifecycle';

/**
 * Setup for the LSP Core Plugin.
 *
 * Owns everything about language servers except their configuration: the
 * descriptors are registered with the host (data), and the client, the process,
 * the protocol and the log buffers live here (ADR 0019). `@np/core` learns the
 * words "command, arguments, root markers, served languages" and nothing else,
 * so disabling this plugin leaves the host with no LSP surface at all rather
 * than a client with no servers.
 *
 * Documents arrive as host events (ADR 0013), which is what makes "a server
 * starts on the first served file" true without the editor knowing that servers
 * exist: a file no descriptor serves resolves to nothing and costs nothing.
 *
 * The runtime and its log store are published as services because the Logs tab
 * and the status menu are UI that is not in this slice (#266): the buffers are
 * built and capped here, and that UI reads them through the key rather than
 * reaching into plugin state.
 */
export function setup(host: PluginHostInterface): PluginCleanup {
	const logs = new LspLogStore();
	const runtime = new LspRuntime({ host, pluginId: manifest.id, logs });

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

	return async () => {
		for (const stop of stopObserving) stop();
		// Every server is stopped and killed here, so disabling the plugin leaves
		// no process behind (ADR 0009). Clearing the buffers afterwards means a
		// disabled plugin leaves nothing for a Logs tab to render as current.
		await runtime.dispose();
		logs.clear();
	};
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
