import {
	WORKSPACE_SERVICE_KEY,
	type CompletionAnswer,
	type CompletionCoordinator,
	type CompletionQuery,
	type LspPlatform,
	type WorkspaceLike
} from '../services';
import type { PluginHostInterface } from '../types';
import type { RegisteredLspDescriptor } from '../lsp-descriptors';
import { LspClient } from './client';
import { parseServerCompletions } from './completions';
import { parsePublishDiagnostics, type LspDiagnosticsStore } from './diagnostics';
import type { LspLogStore } from './logs';
import { toFileUri } from './root';
import { describeError } from './describe-error';
import { lspServerKey, LspTargetResolver } from './targets';
import type { LspServerState, LspServerStatus, LspServerStatusApi } from './status';
import { resolveLspPlatform } from './platform';

export { lspServerKey };
export type { LspServerState, LspServerStatus };

/**
 * Server lifecycle (spec #263, ADR 0019).
 *
 * A server is identified by `<descriptor id>@<project root>`: one descriptor
 * runs one process per project root, so a monorepo with three TypeScript
 * projects gets three servers and each one is restarted and stopped on its own.
 *
 * Every entry point here is safe to call from an observer. Document opening
 * arrives as an event (ADR 0013) and therefore cannot throw back at the editor,
 * so a conflict, a missing platform, a server that will not start, and a
 * protocol failure are all recorded and returned, never raised.
 */

/**
 * Key the LSP plugin publishes its runtime under. The Logs tab and the status
 * menu are UI that lands in #266, and both act on this runtime — one reader, one
 * writer — rather than reaching into plugin state from the outside.
 */
export const LSP_RUNTIME_SERVICE_KEY = 'lsp:runtime';

export interface LspDocumentInput {
	/** Absolute path, or null for an untitled document that has no file yet. */
	readonly path: string | null;
	readonly fileName: string;
	readonly content: string;
	/**
	 * Language identity when the app already resolved one (a manual language
	 * switch). Falls back to resolving the filename through the registry. This is
	 * the registry's **display name**, which is what a descriptor joins on; the
	 * protocol's `languageId` is derived from the filename separately.
	 */
	readonly language?: string | null;
}

export interface LspRuntimeOptions {
	readonly host: PluginHostInterface;
	/** Owning plugin, for attribution on a contained failure. */
	readonly pluginId: string;
	readonly logs: LspLogStore;
	/**
	 * Where server findings are filed. Optional because a runtime with nowhere to
	 * put diagnostics is a working runtime: the notification is simply dropped.
	 */
	readonly diagnostics?: LspDiagnosticsStore;
	/**
	 * Overrides the platform service. This is the injection seam tests use;
	 * without it the seam is resolved from `LSP_PLATFORM_SERVICE_KEY` on every
	 * use, so an app that publishes it late still gets it.
	 */
	readonly platform?: LspPlatform;
	/** Bound on one server's `initialize` handshake. See `LspClientOptions`. */
	readonly initializeTimeoutMs?: number;
}

interface OpenDocument {
	readonly uri: string;
	readonly languageId: string;
	content: string;
	version: number;
}

interface RunningServer {
	readonly server: string;
	readonly descriptor: RegisteredLspDescriptor;
	readonly root: string;
	readonly marker: string | null;
	client?: LspClient;
	state: LspServerState;
	/** Set by an explicit stop so opening a document does not resurrect it. */
	stoppedByUser: boolean;
}

/**
 * The running-server table, and the only reader of it.
 *
 * `implements LspServerStatusApi` because that interface is the whole of what a
 * status bar needs: the rows, a change notification, and a revision counter for
 * a consumer that would rather poll than subscribe. Nothing else about starting
 * and stopping a process is exposed by reading status.
 */
export class LspRuntime implements LspServerStatusApi, CompletionCoordinator {
	private readonly servers = new Map<string, RunningServer>();
	private readonly openDocuments = new Map<string, OpenDocument>();
	/** Document URI to the server it is synced to, so a restart re-opens it. */
	private readonly documentServers = new Map<string, string>();
	private readonly targets: LspTargetResolver;
	private readonly statusListeners = new Set<() => void>();
	private statusRevision = 0;
	private disposed = false;

	constructor(private readonly options: LspRuntimeOptions) {
		this.targets = new LspTargetResolver({
			host: options.host,
			logs: options.logs,
			platform: () => this.resolvePlatform()
		});
	}

	/**
	 * One row per server the runtime knows about, in the order it learned about
	 * them. Reads the same table the lifecycle tests assert, so the menu cannot
	 * report a state the runtime does not hold.
	 */
	getStatusRows(): LspServerStatus[] {
		return [...this.servers.values()].map((entry) => ({
			server: entry.server,
			descriptorId: entry.descriptor.id,
			root: entry.root,
			marker: entry.marker,
			state: entry.state,
			pid: entry.client?.pid,
			// The details slot is shaped now and filled by the version and memory
			// follow-ups, so arriving there is not a redesign of the row.
			details: []
		}));
	}

	/** The same rows, named for what the commands and tests are asking for. */
	getServers(): LspServerStatus[] {
		return this.getStatusRows();
	}

	subscribe(listener: () => void): () => void {
		this.statusListeners.add(listener);
		return () => {
			this.statusListeners.delete(listener);
		};
	}

	/** Bumped on every status change, so a consumer can notice without subscribing. */
	get revision(): number {
		return this.statusRevision;
	}

	/**
	 * Reacts to one opened or changed document: resolve its descriptor, resolve
	 * its project root, start that server if it is not running, and sync the
	 * document to it. Returns the server key it was attributed to, or null when
	 * no descriptor claims the file — which is the answer for prose and for any
	 * language no server serves.
	 */
	async openDocument(input: LspDocumentInput): Promise<string | null> {
		const path = input.path;
		// An untitled document has no file for a server to be scoped to, and a
		// runtime being torn down must not start new work.
		if (this.disposed || !path) return null;
		try {
			const target = await this.targets.resolve(input);
			if (!target) return null;
			const server = lspServerKey(target.descriptor.id, target.root);
			const entry = await this.ensureRunning(server, target.descriptor, target.root, target.marker);
			if (entry.state !== 'running' || !entry.client) return server;

			this.syncDocument(entry, { ...input, path });
			return server;
		} catch (error) {
			this.reportContained('document sync', error);
			return null;
		}
	}

	/**
	 * One `textDocument/completion` round trip for a position, carrying the
	 * outcome the buffer-word source's `fallback` mode is decided on.
	 *
	 * The three states are the whole point of this method. `'inactive'` means
	 * nothing is meant to answer here — no descriptor claims the language, no
	 * platform exists, or the runtime is shutting down — and words answer
	 * exactly as they did before any server existed. `'serving'` means a server
	 * answered, and `'unavailable'` means one was there and could not deliver.
	 * Collapsing the last two would make a wedged server indistinguishable from
	 * a file nothing serves, which is exactly the silence spec #263 asks words
	 * to replace.
	 *
	 * Contained like every entry point here: document work arrives as an event
	 * (ADR 0013) and cannot throw back at the editor, so a failed request is
	 * recorded and returned rather than raised.
	 *
	 * The coordinates in `query` are the protocol's own — a zero-based line and a
	 * UTF-16 offset within it — and `timeoutMs` is the `lsp_fetch_timeout_ms`
	 * bound, where absent means *no bound*: the setting's own default of `0`
	 * expressed rather than a separate sentinel. Both come from the generic query
	 * the editor asks, which is what lets the shell issue one without naming a
	 * language server.
	 */
	async fetch(query: CompletionQuery): Promise<CompletionAnswer> {
		if (this.disposed) {
			return { state: 'inactive', reason: 'The language-server runtime is shutting down.' };
		}
		const { document, line, character, timeoutMs } = query;
		const path = document.path;
		if (!path) {
			return { state: 'inactive', reason: 'An untitled document has no file for a server to serve.' };
		}
		let server = 'lsp';
		try {
			const target = await this.targets.resolve(document);
			if (!target) {
				return { state: 'inactive', reason: 'No language server claims this document.' };
			}
			server = lspServerKey(target.descriptor.id, target.root);
			const entry = await this.ensureRunning(server, target.descriptor, target.root, target.marker);
			if (entry.state !== 'running' || !entry.client) {
				return {
					state: 'unavailable',
					provider: server,
					reason: `Server "${server}" is ${entry.state}, so it cannot answer.`
				};
			}
			this.syncDocument(entry, { ...document, path });
			const result = await entry.client.request(
				'textDocument/completion',
				{
					textDocument: { uri: toFileUri(path) },
					position: { line, character }
				},
				timeoutMs
			);
			const list = parseServerCompletions(result);
			return { state: 'serving', items: list.items, incomplete: list.incomplete };
		} catch (error) {
			// Logged as well as returned. Words appearing behind a failed request is
			// indistinguishable from words working, from the outside, so the reason
			// has to be somewhere the Logs tab (#266) can show it.
			const reason = describeError(error);
			this.options.logs.append({
				server,
				kind: 'server',
				level: 'warn',
				message: `Completion request failed, so words answer instead: ${reason}`
			});
			return { state: 'unavailable', provider: server, reason };
		}
	}

	/**
	 * Sends the document's current text to one running server: `didOpen` the
	 * first time, full-content `didChange` after that (ADR 0019).
	 *
	 * Identical text is not resent. Two paths reach this — the document lifecycle
	 * event and a completion query — and a keystroke produces both, so without this
	 * every keystroke would send the whole document twice and bump the version
	 * twice for one change.
	 */
	private syncDocument(entry: RunningServer, input: LspDocumentInput & { path: string }): void {
		const client = entry.client;
		if (!client) return;
		const uri = toFileUri(input.path);
		const existing = this.openDocuments.get(uri);
		if (existing) {
			if (existing.content === input.content) return;
			existing.content = input.content;
			existing.version++;
			this.documentServers.set(uri, entry.server);
			client.notify('textDocument/didChange', {
				textDocument: { uri, version: existing.version },
				contentChanges: [{ text: input.content }]
			});
			return;
		}
		const document: OpenDocument = {
			uri,
			languageId: this.targets.languageIdFor(entry.descriptor, input),
			content: input.content,
			version: 1
		};
		this.openDocuments.set(uri, document);
		this.documentServers.set(uri, entry.server);
		client.notify('textDocument/didOpen', {
			textDocument: {
				uri,
				languageId: document.languageId,
				version: document.version,
				text: document.content
			}
		});
	}

	/**
	 * Restarts one server in place. Its documents are re-opened against the new
	 * process, so a restart is not a silent loss of context.
	 */
	async restartServer(server: string): Promise<boolean> {
		const existing = this.servers.get(server);
		if (!existing) return false;
		await this.stopEntry(existing);
		// An explicit restart lifts the stop it is reversing; without this the
		// start below would take the "stopped by the user" early return and hand
		// back a server that never came up.
		existing.stoppedByUser = false;
		const entry = await this.ensureRunning(
			server,
			existing.descriptor,
			existing.root,
			existing.marker
		);
		return entry.state === 'running';
	}

	/** Stops one server and leaves it stopped: a later edit does not restart it. */
	async stopServer(server: string): Promise<boolean> {
		const existing = this.servers.get(server);
		if (!existing) return false;
		await this.stopEntry(existing);
		existing.stoppedByUser = true;
		return true;
	}

	async restartAll(): Promise<void> {
		for (const entry of [...this.servers.values()]) {
			await this.restartServer(entry.server);
		}
	}

	async stopAll(): Promise<void> {
		for (const entry of [...this.servers.values()]) {
			await this.stopEntry(entry);
			entry.stoppedByUser = true;
		}
	}

	/** Plugin disablement: stop everything and forget it. No process may survive. */
	async dispose(): Promise<void> {
		// Set first: a document event that lands mid-teardown must not start a
		// server the disable is in the middle of stopping.
		this.disposed = true;
		await this.stopAll();
		this.servers.clear();
		this.openDocuments.clear();
		this.documentServers.clear();
		this.targets.clear();
		this.statusChanged();
	}

	private resolvePlatform(): LspPlatform | undefined {
		return this.options.platform ?? resolveLspPlatform(this.options.host);
	}

	private async ensureRunning(
		server: string,
		descriptor: RegisteredLspDescriptor,
		root: string,
		marker: string | null
	): Promise<RunningServer> {
		const existing = this.servers.get(server);
		if (existing) {
			if (existing.state === 'running' || existing.state === 'starting') return existing;
			// An explicit stop is final until an explicit restart: a keystroke must
			// not resurrect a server the user stopped.
			if (existing.stoppedByUser) return existing;
			await this.stopEntry(existing);
		}

		const entry: RunningServer = {
			server,
			descriptor,
			root,
			marker,
			state: 'starting',
			stoppedByUser: false
		};
		this.servers.set(server, entry);
		// The menu shows a starting server as such, so the status changes as soon
		// as the entry exists rather than when the handshake comes back.
		this.statusChanged();

		// Re-resolved here rather than handed in: `resolveTarget` and the start
		// are separated by the root walk, and a platform published in between
		// must still count.
		const platform = this.resolvePlatform();
		if (!platform) {
			entry.state = 'failed';
			this.log(entry, 'info', `No LSP platform is published, so "${server}" cannot start.`);
			this.statusChanged();
			return entry;
		}
		// Named `serverProcess`, not `process`: a local named after the global
		// shadows it for the whole block, and a platform implementation reading
		// `process.execPath` from the caller's scope would read a dead binding.
		let spawnedProcess: { kill(): void } | undefined;
		try {
			const serverProcess = platform.spawn({
				command: descriptor.command,
				args: descriptor.args,
				cwd: root,
				...(descriptor.bundled ? { bundled: descriptor.bundled } : {})
			});
			spawnedProcess = serverProcess;
			const client = new LspClient({
				process: serverProcess,
				server,
				logs: this.options.logs,
				initializeTimeoutMs: this.options.initializeTimeoutMs,
				onNotification: (method, params) => this.onNotification(server, method, params)
			});
			entry.client = client;
			await client.initialize({
				rootUri: toFileUri(root),
				workspaceFolders: [{ uri: toFileUri(root), name: descriptor.id }],
				capabilities: {}
			});
			// A stop or a restart that landed while the handshake was in flight
			// wins. Otherwise the awaiting start would come back afterwards and
			// report a server the user had already stopped as running again.
			if (entry.client !== client) {
				await client.stop();
				return entry;
			}
			entry.state = 'running';
			this.statusChanged();
			this.log(
				entry,
				'info',
				`Started ${descriptor.command} ${descriptor.args.join(' ')}`.trim() +
					`${serverProcess.pid !== undefined ? ` (pid ${serverProcess.pid})` : ''}` +
					` at ${root}${marker ? ` via ${marker}` : ' with no root marker, scoped to the document directory'}.`
			);
			this.reopenDocumentsFor(server);
		} catch (error) {
			entry.state = 'failed';
			entry.client?.dispose();
			entry.client = undefined;
			spawnedProcess?.kill();
			this.statusChanged();
			this.log(entry, 'error', `Failed to start ${descriptor.command}: ${describeError(error)}`);
		}
		return entry;
	}

	/** Re-sends `didOpen` for every document bound to a server that just started. */
	private reopenDocumentsFor(server: string): void {
		const entry = this.servers.get(server);
		if (!entry?.client) return;
		for (const [uri, document] of this.openDocuments) {
			if (this.documentServers.get(uri) !== server) continue;
			document.version++;
			entry.client.notify('textDocument/didOpen', {
				textDocument: {
					uri,
					languageId: document.languageId,
					version: document.version,
					text: document.content
				}
			});
		}
	}

	private async stopEntry(entry: RunningServer): Promise<void> {
		const client = entry.client;
		entry.client = undefined;
		entry.state = 'stopped';
		// Whatever this server reported describes a process that is no longer
		// watching, and a restart that kept them would look like it did nothing.
		this.options.diagnostics?.dropServer(entry.server);
		this.statusChanged();
		if (!client) return;
		// The handshake is best-effort; a server that ignores `shutdown` is still
		// killed inside `stop()`, which is what keeps a disable orphan-free.
		await client.stop();
		this.log(entry, 'info', `Stopped at ${entry.root}.`);
	}

	/**
	 * Server-to-client notification. Only diagnostics are consumed here; every
	 * other notification stays in the protocol trace, which is the whole of what
	 * an unhandled one is good for. The parser is total over JSON — anything it
	 * cannot use comes back as null — so nothing here can fail the document or
	 * the server.
	 */
	private onNotification(server: string, method: string, params: unknown): void {
		if (method !== 'textDocument/publishDiagnostics') return;
		const report = parsePublishDiagnostics(server, params);
		if (!report) return;
		this.options.diagnostics?.publish(report);
	}

	private log(entry: RunningServer, level: 'info' | 'warn' | 'error', message: string): void {
		this.options.logs.append({
			server: entry.server,
			kind: 'server',
			level,
			message
		});
	}

	private statusChanged(): void {
		this.statusRevision++;
		for (const listener of [...this.statusListeners]) listener();
	}

	private reportContained(what: string, error: unknown): void {
		console.error(
			`[${this.options.pluginId}] ${what} failed: ${describeError(error)}`
		);
	}
}

/** Enough recent files to cover a working session without growing forever. */
const MAX_RESOLVED_TARGETS = 128;

