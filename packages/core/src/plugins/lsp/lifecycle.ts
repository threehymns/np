import { ConflictingLspDescriptorError } from '../errors';
import { WORKSPACE_SERVICE_KEY, type LspTransport, type WorkspaceLike } from '../services';
import type { PluginHostInterface } from '../types';
import type { RegisteredLspDescriptor } from '../lsp-descriptors';
import { LspClient } from './client';
import type { LspLogStore } from './logs';
import { dirnameOf, findProjectRoot, toFileUri } from './root';
import { resolveLspTransport } from './transport';

/**
 * Server lifecycle (spec #263, ADR 0019).
 *
 * A server is identified by `<descriptor id>@<project root>`: one descriptor
 * runs one process per project root, so a monorepo with three TypeScript
 * projects gets three servers and each one is restarted and stopped on its own.
 *
 * Every entry point here is safe to call from an observer. Document opening
 * arrives as an event (ADR 0013) and therefore cannot throw back at the editor,
 * so a conflict, a missing transport, a server that will not start, and a
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
	 * switch). Falls back to resolving the filename through the registry.
	 */
	readonly language?: string | null;
}

export type LspServerState = 'starting' | 'running' | 'stopped' | 'failed';

export interface LspServerStatus {
	readonly server: string;
	readonly descriptorId: string;
	readonly root: string;
	readonly marker: string | null;
	readonly state: LspServerState;
	readonly pid: number | undefined;
}

export interface LspRuntimeOptions {
	readonly host: PluginHostInterface;
	/** Owning plugin, for attribution on a contained failure. */
	readonly pluginId: string;
	readonly logs: LspLogStore;
	/**
	 * Overrides the transport service. This is the injection seam tests use;
	 * without it the seam is resolved from `LSP_TRANSPORT_SERVICE_KEY` on every
	 * use, so an app that publishes it late still gets it.
	 */
	readonly transport?: LspTransport;
	/** Bound on one server's `initialize` handshake. See `LspClientOptions`. */
	readonly initializeTimeoutMs?: number;
}

interface OpenDocument {
	readonly uri: string;
	readonly languageId: string;
	content: string;
	version: number;
}

interface LspTarget {
	readonly descriptor: RegisteredLspDescriptor;
	readonly root: string;
	readonly marker: string | null;
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

export function lspServerKey(descriptorId: string, root: string): string {
	return `${descriptorId}@${root}`;
}

export class LspRuntime {
	private readonly servers = new Map<string, RunningServer>();
	private readonly openDocuments = new Map<string, OpenDocument>();
	/** Document URI to the server it is synced to, so a restart re-opens it. */
	private readonly documentServers = new Map<string, string>();
	/**
	 * Resolved target per file path, keyed by the registry revision it was
	 * resolved against. Every keystroke arrives as a full-content change, and
	 * re-resolving one means a language match plus a marker walk that stats a
	 * file per level; the answer cannot change while the registry and the files
	 * on disk do not, and the registry's own revision counter says so.
	 */
	private readonly resolvedTargets = new Map<string, { revision: number; target: LspTarget | null }>();
	private disposed = false;

	constructor(private readonly options: LspRuntimeOptions) {}

	getServers(): LspServerStatus[] {
		return [...this.servers.values()].map((entry) => ({
			server: entry.server,
			descriptorId: entry.descriptor.id,
			root: entry.root,
			marker: entry.marker,
			state: entry.state,
			pid: entry.client?.pid
		}));
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
			const target = await this.targetFor(input);
			if (!target) return null;
			const server = lspServerKey(target.descriptor.id, target.root);
			const entry = await this.ensureRunning(server, target.descriptor, target.root, target.marker);
			if (entry.state !== 'running' || !entry.client) return server;

			const uri = toFileUri(path);
			const languageId = this.languageIdFor(input);
			const existing = this.openDocuments.get(uri);
			if (existing) {
				existing.content = input.content;
				existing.version++;
				this.documentServers.set(uri, server);
				entry.client.notify('textDocument/didChange', {
					textDocument: { uri, version: existing.version },
					contentChanges: [{ text: input.content }]
				});
				return server;
			}
			const document: OpenDocument = {
				uri,
				languageId,
				content: input.content,
				version: 1
			};
			this.openDocuments.set(uri, document);
			this.documentServers.set(uri, server);
			entry.client.notify('textDocument/didOpen', {
				textDocument: {
					uri,
					languageId,
					version: document.version,
					text: input.content
				}
			});
			return server;
		} catch (error) {
			this.reportContained('document sync', error);
			return null;
		}
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
		this.resolvedTargets.clear();
	}

	/** The memoized target for a file, re-resolved whenever the registry moves. */
	private async targetFor(input: LspDocumentInput): Promise<LspTarget | null> {
		if (!input.path) return null;
		const revision = this.options.host.lspRevision;
		const memo = this.resolvedTargets.get(input.path);
		if (memo && memo.revision === revision) return memo.target;
		const target = await this.resolveTarget(input);
		// Bounded rather than unbounded: a session that opens more files than
		// this has cleared every entry, and re-resolving a handful of them costs
		// one marker walk each.
		if (this.resolvedTargets.size >= MAX_RESOLVED_TARGETS) this.resolvedTargets.clear();
		this.resolvedTargets.set(input.path, { revision, target });
		return target;
	}

	private async resolveTarget(input: LspDocumentInput): Promise<LspTarget | null> {
		if (!input.path) return null;
		const language = input.language ?? this.options.host.getLanguageForFile(input.fileName)?.name ?? null;
		if (!language) return null;
		const descriptors = this.options.host.getLspDescriptorsForLanguage(language);
		if (descriptors.length === 0) return null;
		if (descriptors.length > 1) {
			// Two servers would index the same file. Resolving it by registration
			// order would make the answer depend on which plugin enabled first, so
			// the conflict is reported instead and no server starts for this file.
			throw new ConflictingLspDescriptorError(
				input.path,
				descriptors.map((d) => d.id)
			);
		}
		const descriptor = descriptors[0];
		// Resolved after the descriptor check on purpose: a note that no server
		// serves must not report a missing transport, or every Markdown file in
		// the session would log one.
		const transport = this.resolveTransport();
		if (!transport) {
			// Recorded against the server this file would have used. Only a served
			// file reaches here, so a web session never logs it — a note must not
			// report a missing transport just because it has no server.
			this.options.logs.append({
				server: lspServerKey(descriptor.id, dirnameOf(input.path)),
				kind: 'server',
				level: 'info',
				message:
					'No LSP transport is published, so this server cannot start. On web no transport exists by design (spec #263); elsewhere the desktop app failed to publish one.'
			});
			return null;
		}
		const resolution = await findProjectRoot({
			startDir: dirnameOf(input.path),
			markers: descriptor.rootMarkers,
			probe: transport,
			boundary: this.workspaceRoot()
		});
		return { descriptor, root: resolution.root, marker: resolution.marker };
	}

	/**
	 * The protocol's `languageId` is lowercased. The registry publishes display
	 * names (`TypeScript`), while every server in the ecosystem keys off the
	 * lowercased extension id (`typescript`), so passing the display name
	 * through would silently select the wrong grammar on the server side.
	 */
	private languageIdFor(input: LspDocumentInput): string {
		const language =
			input.language ?? this.options.host.getLanguageForFile(input.fileName)?.name ?? null;
		return (language ?? 'plaintext').toLowerCase();
	}

	private workspaceRoot(): string | null {
		return (
			this.options.host.getService<WorkspaceLike>(WORKSPACE_SERVICE_KEY)?.project.rootOrigin
				?.path ?? null
		);
	}

	private resolveTransport(): LspTransport | undefined {
		return this.options.transport ?? resolveLspTransport(this.options.host);
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

		// Re-resolved here rather than handed in: `resolveTarget` and the start
		// are separated by the root walk, and a transport published in between
		// must still count.
		const transport = this.resolveTransport();
		if (!transport) {
			entry.state = 'failed';
			this.log(entry, 'info', `No LSP transport is published, so "${server}" cannot start.`);
			return entry;
		}
		// Named `serverProcess`, not `process`: a local named after the global
		// shadows it for the whole block, and a transport implementation reading
		// `process.execPath` from the caller's scope would read a dead binding.
		let spawnedProcess: { kill(): void } | undefined;
		try {
			const serverProcess = transport.spawn({
				command: descriptor.command,
				args: descriptor.args,
				cwd: root
			});
			spawnedProcess = serverProcess;
			const client = new LspClient({
				process: serverProcess,
				server,
				logs: this.options.logs,
				initializeTimeoutMs: this.options.initializeTimeoutMs
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
			this.log(entry, 'error', `Failed to start ${descriptor.command}: ${describe(error)}`);
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
		if (!client) return;
		// The handshake is best-effort; a server that ignores `shutdown` is still
		// killed inside `stop()`, which is what keeps a disable orphan-free.
		await client.stop();
		this.log(entry, 'info', `Stopped at ${entry.root}.`);
	}

	private log(entry: RunningServer, level: 'info' | 'warn' | 'error', message: string): void {
		this.options.logs.append({
			server: entry.server,
			kind: 'server',
			level,
			message
		});
	}

	private reportContained(what: string, error: unknown): void {
		console.error(
			`[${this.options.pluginId}] ${what} failed: ${describe(error)}`
		);
	}
}

/** Enough recent files to cover a working session without growing forever. */
const MAX_RESOLVED_TARGETS = 128;

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
