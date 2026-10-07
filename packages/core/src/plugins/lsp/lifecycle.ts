import {
	COMPLETION_RESOLVE_SERVICE_KEY,
	HOVER_COORDINATOR_SERVICE_KEY,
	SETTINGS_READER_SERVICE_KEY,
	WORKSPACE_SERVICE_KEY,
	type CompletionAnswer,
	type CompletionCoordinator,
	type CompletionQuery,
	type CompletionResolveCoordinator,
	type CompletionSuggestion,
	type HoverAnswer as GenericHoverAnswer,
	type HoverCoordinator,
	type HoverQuery as GenericHoverQuery,
	type LspPlatform,
	type SettingsReader,
	type SettingsRead,
	type SettingsSubscribe,
	type WorkspaceLike
} from '../services';
import type { PluginHostInterface } from '../types';
import type { RegisteredLspDescriptor } from '../lsp-descriptors';
import { LspClient } from './client';
import { mergeResolvedCompletion, parseServerCompletions, toResolveParams } from './completions';
import { parseServerHover, type ServerHover } from './hover';
import { parsePublishDiagnostics, type LspDiagnosticsStore } from './diagnostics';
import { lspDisabledReason, lspEnabledFor } from './lsp-gate';
import type { LspLogStore } from './logs';
import { basenameOfUri, fromFileUri, toFileUri } from './root';
import { describeError } from './describe-error';
import { lspServerKey, LspTargetResolver, type LspTargetInput } from './targets';
import type { LspServerState, LspServerStatus, LspServerStatusApi, LspStatusDetail } from './status';
import { resolveLspPlatform } from './platform';

export { lspServerKey };
export type { LspServerState, LspServerStatus };

/**
 * Server lifecycle (spec #263, ADR 0020).
 *
 * A server is identified by `<descriptor id>@<project root>`: one descriptor
 * runs one process per project root, so a monorepo with three TypeScript
 * projects gets three servers and each one is restarted and stopped on its own.
 *
 * Every entry point here is safe to call from an observer. A document arrives as
 * an event (ADR 0013) and a settings change arrives as a subscription, so neither
 * can throw back at the editor: a conflict, a missing platform, a server that will
 * not start, and a protocol failure are all recorded and returned, never raised.
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

/**
 * One position's hover query, as the hover source states it (spec #280).
 *
 * The coordinates are the protocol's own — a zero-based line and a UTF-16
 * offset within it — and `timeoutMs` is the same `lsp_fetch_timeout_ms` bound
 * completions use, where absent means no bound was chosen.
 */
export interface HoverQuery {
	readonly document: LspDocumentInput;
	readonly line: number;
	readonly character: number;
	readonly timeoutMs?: number;
}

/**
 * The three-way answer a hover provider gives.
 *
 * `'serving'` with a null hover is still serving: the server answered and
 * reported nothing, which hovers to nothing rather than to an error. Only
 * `'unavailable'` is a failure, and it degrades to the same nothing on screen
 * — diagnostics, completions and note hovers keep their current behaviour
 * because a hover that cannot answer never claims the tooltip.
 */
export type HoverAnswer =
	| { readonly state: 'inactive'; readonly reason: string }
	| { readonly state: 'serving'; readonly hover: ServerHover | null }
	| { readonly state: 'unavailable'; readonly provider: string; readonly reason: string };

/** How far either side of the selection the visible-window resolve covers (#292). */
export const RESOLVE_WINDOW_BEFORE_AFTER = 4;

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
	/**
	 * Overrides the resolved settings the `editor.lsp` gate reads. This is the
	 * injection seam tests use; without it the reader is resolved from
	 * `SETTINGS_READER_SERVICE_KEY` per use, so an app that publishes it late still
	 * gets it. Absent, the gate reads the documented default and every language is
	 * served — which is the answer a runtime with no settings at all must give,
	 * because silence is indistinguishable from a switch the user cannot find.
	 */
	readonly readSettings?: SettingsRead;
	/**
	 * Overrides the settings-change subscription that re-evaluates the gate while
	 * the editor sits idle, the seam's other half and the same injection argument as
	 * `readSettings`. Absent, it is resolved from the published reader.
	 */
	readonly subscribeSettings?: SettingsSubscribe;
	/** Bound on one server's `initialize` handshake. See `LspClientOptions`. */
	readonly initializeTimeoutMs?: number;
}

interface OpenDocument {
	readonly uri: string;
	/**
	 * The registry's language name, kept so the gate can be re-read for this
	 * document without resolving it again: the name is what `editor.languages` is
	 * keyed by, and re-resolving would mean a language lookup per document per
	 * settings change.
	 */
	readonly language: string | null;
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
	/** Null until the server's `initialize` result reports it. */
	serverVersion: string | null;
	/** Snapshot, not a live read: the menu reads rows synchronously on render. */
	memoryBytes: number | null;
}

/** A document presented to the runtime, waiting to be synced to its server. */
interface PendingDocument {
	/**
	 * The server it was resolved to, or null until {@link LspTargetResolver} answers.
	 * Set on the way out of the wait rather than at registration, because the server
	 * is what resolution decides and registration is what has to come first.
	 */
	server: string | null;
	readonly input: LspDocumentInput & { path: string };
}

/**
 * How long a completion request is held when the caller asked for no bound.
 *
 * `lsp_fetch_timeout_ms` defaults to `0`, which means *the user has not chosen a
 * bound* rather than *wait forever*: spec #263 asks for words behind a server
 * that errors **or times out**, and a request with no bound can never time out,
 * so out of the box a wedged server held the popover open forever and words
 * never got their turn — silence, which is the one outcome the `fallback` mode
 * exists to prevent (ADR 0021).
 *
 * So the runtime keeps its own bound rather than passing the setting's absence
 * straight through. It is the same reasoning as `initialize`'s: an unbounded wait
 * on a server is a wait on a document this runtime may never be able to answer.
 * A user who wants a different bound sets one, and a non-zero setting still wins
 * — this is only what happens when none was chosen.
 *
 * Sized against the round trip rather than the whole life of a server: the
 * handshake and the process start are bounded separately, so this covers one
 * request's silence, which is the failure `words` answers behind.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 5000;

/**
 * The running-server table, and the only reader of it.
 *
 * `implements LspServerStatusApi` because that interface is the whole of what a
 * status bar needs: the rows, a change notification, and a revision counter for
 * a consumer that would rather poll than subscribe. Nothing else about starting
 * and stopping a process is exposed by reading status.
 */
export class LspRuntime
	implements LspServerStatusApi, CompletionCoordinator, HoverCoordinator, CompletionResolveCoordinator
{
	private readonly servers = new Map<string, RunningServer>();
	private readonly openDocuments = new Map<string, OpenDocument>();
	/** Document URI to the server it is synced to, so a restart re-opens it. */
	private readonly documentServers = new Map<string, string>();
	/**
	 * Documents presented to the runtime and not yet sent, keyed by URI.
	 *
	 * The workspace opens every restored document in a loop right after session
	 * restore, so the second file of a folder is presented while the first is still
	 * handshaking, and the document that resolves *first* is not the document that
	 * was presented first. A document dropped for arriving too early had no server
	 * completions and no diagnostics until somebody typed in it, which is the bug
	 * this map is: waiting here is what makes restoring a folder serve every file in
	 * it rather than one of them.
	 *
	 * Bounded by construction rather than by a cap. A document leaves as soon as it
	 * is sent, and one that cannot be sent is dropped — by a gate, by the document
	 * being detached, by the resolution naming no server, by its server failing or
	 * stopping, by the runtime being disposed. So the map holds at most the documents
	 * in hand at one moment, which for this runtime is the open ones.
	 */
	private readonly pendingDocuments = new Map<string, PendingDocument>();
	private readonly targets: LspTargetResolver;
	private readonly statusListeners = new Set<() => void>();
	/** Held so a disable really releases it; see {@link LspRuntime.dispose}. */
	private unsubscribeSettings?: () => void;
	private statusRevision = 0;
	private disposed = false;
	/**
	 * What each running server said it can do, read out of its own
	 * `initialize` reply (spec #280, #292).
	 *
	 * `resolveProvider` gates the `completionItem/resolve` round trip and
	 * `hoverProvider` gates `textDocument/hover`; `executeCommands` gates a
	 * resolved `command` at confirm time. All three are the server's to
	 * announce, and a server that never announced one is treated as not
	 * offering it.
	 */
	private readonly serverCapabilities = new Map<
		string,
		{ resolveProvider: boolean; hoverProvider: boolean; executeCommands: readonly string[] }
	>();
	/**
	 * Once-only resolve guard per item (spec #280, #292).
	 *
	 * Keyed `${server}\0${label}\0${data-json}`: one successful round trip
	 * fills docs/detail for good, and a second request for the same item is
	 * a request the server already answered. Cleared with the server, so a
	 * restart re-resolves rather than serving stale docs.
	 */
	private readonly resolvedItems = new Set<string>();

	constructor(private readonly options: LspRuntimeOptions) {
		this.targets = new LspTargetResolver({
			host: options.host,
			logs: options.logs,
			platform: () => this.resolvePlatform()
		});
		this.ensureSettingsSubscription();
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
			details: statusDetailsFor(entry)
		}));
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
		this.ensureSettingsSubscription();
		const uri = toFileUri(path);
		try {
			const gate = this.gateFor(input);
			if (!gate.enabled) {
				// Declined before resolution, so nothing is scoped, no root is walked
				// and no platform is asked. A language already synced to a server is
				// closed rather than left stale: "off" has to mean this document is no
				// longer that server's business, and a server still holding the text
				// keeps publishing for it. The server itself is left alone unless that
				// was the last document it was serving — see {@link LspRuntime.stopWhenUnserved}.
				this.detachDocument(uri);
				return null;
			}
			// Registered before the target is resolved, and resolved on the way out,
			// because the order documents are *presented* in is not the order they
			// arrive in: resolution walks the filesystem, so two documents from one
			// folder come back in whichever order their probes settle. Registration is
			// the only synchronous step here, and it is the one that has to record
			// order.
			this.pendingDocuments.set(uri, { server: null, input: { ...input, path } });
			const target = await this.targets.resolve(input);
			if (!target) {
				this.pendingDocuments.delete(uri);
				return null;
			}
			const server = lspServerKey(target.descriptor.id, target.root);
			const registered = this.pendingDocuments.get(uri);
			if (registered) registered.server = server;
			const entry = await this.ensureRunning(server, target.descriptor, target.root, target.marker);
			if (entry.state !== 'running' || !entry.client) {
				// Left queued while a handshake is in flight, because that is the only
				// state in which a send is coming. A failed entry, a stopped one and one
				// the user stopped have no handshake to wait for, and holding the text
				// for them would sync stale content to a server that is not serving.
				if (entry.state !== 'starting') this.pendingDocuments.delete(uri);
				return server;
			}

			// Sent by the flush rather than here, so one document has one sender: a
			// queue flushed alongside a direct send would put the document that started
			// the server behind whatever was waiting for it, which is the reverse of
			// the order they were presented in.
			this.flushPending(entry);
			return server;
		} catch (error) {
			// The document that failed is not one any server should be sent: two
			// descriptors claiming one file is a conflict to report, not text to sync.
			this.pendingDocuments.delete(uri);
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
	 * bound, where absent means *no bound was chosen*: the setting's own default
	 * of `0` expressed rather than a separate sentinel. Both come from the generic
	 * query the editor asks, which is what lets the shell issue one without naming
	 * a language server. An absent bound is answered with
	 * {@link DEFAULT_FETCH_TIMEOUT_MS} rather than carried through, so `unavailable`
	 * stays reachable for a server that hangs rather than only for one that errors.
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
			const gate = this.gateFor(document);
			// The same `inactive` the editor's source settles without asking, so a
			// caller that reaches the runtime directly gets the answer the chain would
			// have given it. Not `unavailable`: nothing failed, the user said no.
			if (!gate.enabled) {
				return { state: 'inactive', reason: gate.reason };
			}
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
			// A query can be the path that started this server, so it can also be the
			// one that watched the handshake land. Draining here is what stops the
			// documents that were waiting on that start from waiting for a keystroke.
			this.flushPending(entry);
			const result = await entry.client.request(
				'textDocument/completion',
				{
					textDocument: { uri: toFileUri(path) },
					position: { line, character }
				},
				timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
			);
			const list = parseServerCompletions(result);
			return { state: 'serving', items: list.items, incomplete: list.incomplete };
		} catch (error) {
			// Logged as well as returned. Words appearing behind a failed request is
			// indistinguishable from words working, from the outside, so the reason
			// has to be somewhere the Logs tab (#266) can show it.
			const reason = describeError(error);
			this.options.logs.appendServerNote(
				server,
				'warn',
				`Completion request failed, so words answer instead: ${reason}`
			);
			return { state: 'unavailable', provider: server, reason };
		}
	}

	/**
	 * One `textDocument/hover` round trip for a position (spec #280).
	 *
	 * Hover is its own request with no resolve phase (#292): it shares only
	 * the fan-out shape and the Markdown pipeline with the resolve path, and
	 * a symbol the server does not report hovers to nothing rather than to
	 * an error — so `serving` with a null hover and every non-serving state
	 * all mean "no tooltip", leaving diagnostics, completions and note hovers
	 * exactly as they were.
	 *
	 * Contained like every entry point here: a failed request is recorded and
	 * returned rather than raised.
	 */
	async fetchHover(query: HoverQuery | GenericHoverQuery): Promise<HoverAnswer> {
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
			const gate = this.gateFor(document);
			if (!gate.enabled) {
				return { state: 'inactive', reason: gate.reason };
			}
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
			if (!this.canHover(server)) {
				return { state: 'inactive', reason: `Server "${server}" offers no hover.` };
			}
			this.syncDocument(entry, { ...document, path });
			this.flushPending(entry);
			const result = await entry.client.request(
				'textDocument/hover',
				{
					textDocument: { uri: toFileUri(path) },
					position: { line, character }
				},
				timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
			);
			return { state: 'serving', hover: parseServerHover(result) };
		} catch (error) {
			const reason = describeError(error);
			this.options.logs.appendServerNote(server, 'warn', `Hover request failed: ${reason}`);
			return { state: 'unavailable', provider: server, reason };
		}
	}

	/**
	 * One `completionItem/resolve` round trip for an item (spec #280, #292).
	 *
	 * Gated per server on `resolveProvider`: a server that never announced it
	 * keeps its first reply as its last, and the item is returned unchanged.
	 * Once-only per item via {@link resolvedItems}: a second request for the
	 * same key is one the server already answered. A failed resolve degrades
	 * to the unresolved item rather than to an error, because docs that never
	 * arrive are the pre-resolve behaviour rather than a new failure.
	 */
	async resolveCompletion(
		document: LspDocumentInput,
		item: CompletionSuggestion,
		timeoutMs?: number
	): Promise<CompletionSuggestion> {
		const path = document.path;
		if (this.disposed || !path) return item;
		if (!this.gateFor(document).enabled) return item;
		let server = 'lsp';
		try {
			const target = await this.targets.resolve(document);
			if (!target) return item;
			server = lspServerKey(target.descriptor.id, target.root);
			const entry = await this.ensureRunning(server, target.descriptor, target.root, target.marker);
			if (entry.state !== 'running' || !entry.client) return item;
			if (!this.canResolve(server)) return item;
			const key = this.resolveKey(server, item);
			if (this.resolvedItems.has(key)) return item;
			this.syncDocument(entry, { ...document, path });
			this.flushPending(entry);
			const result = await entry.client.request(
				'completionItem/resolve',
				toResolveParams(item),
				timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
			);
			this.resolvedItems.add(key);
			return mergeResolvedCompletion(item, result);
		} catch (error) {
			this.options.logs.appendServerNote(
				server,
				'warn',
				`Resolve request failed, keeping the unresolved item: ${describeError(error)}`
			);
			return item;
		}
	}

	/**
	 * Resolves the visible window around one selection, once-only (#292).
	 *
	 * The window is the selection plus {@link RESOLVE_WINDOW_BEFORE_AFTER}
	 * entries either side. Items whose documentation already arrived are
	 * skipped except the selection itself, which is always re-resolved for
	 * out-of-spec servers that return more later; items already resolved are
	 * never asked twice. Returns the items in order, with resolved entries
	 * replaced by their merged form.
	 */
	async resolveVisible(
		document: LspDocumentInput,
		items: readonly CompletionSuggestion[],
		selectedIndex: number,
		timeoutMs?: number
	): Promise<readonly CompletionSuggestion[]> {
		if (items.length === 0) return items;
		const selected = Math.max(0, Math.min(selectedIndex, items.length - 1));
		const from = Math.max(0, selected - RESOLVE_WINDOW_BEFORE_AFTER);
		const to = Math.min(items.length - 1, selected + RESOLVE_WINDOW_BEFORE_AFTER);
		const resolved = [...items];
		for (let index = from; index <= to; index++) {
			const item = resolved[index];
			// Already documented and not the selection: nothing withheld.
			if (item.documentation && index !== selected) continue;
			resolved[index] = await this.resolveCompletion(document, item, timeoutMs);
		}
		return resolved;
	}

	/** Generic resolve seam: hands back the suggestion with docs/detail filled. */
	async resolveItem(
		item: CompletionSuggestion,
		document: GenericHoverQuery['document'],
		timeoutMs?: number
	): Promise<CompletionSuggestion> {
		return this.resolveCompletion(
			{
				path: document.path,
				fileName: document.fileName,
				content: document.content,
				language: document.language
			},
			item,
			timeoutMs
		);
	}

	/** Generic command seam: fire-and-forget, gated on the server offering it. */
	runCommand(
		command: string,
		args: readonly unknown[] | undefined,
		document: GenericHoverQuery['document']
	): void {
		void this.executeCompletionCommand(
			{
				path: document.path,
				fileName: document.fileName,
				content: document.content,
				language: document.language
			},
			command,
			args
		);
	}

	/** Whether one server announced `completionProvider.resolveProvider`. */
	canResolve(server: string): boolean {
		return this.serverCapabilities.get(server)?.resolveProvider === true;
	}

	/** Whether one server announced a hover provider. */
	canHover(server: string): boolean {
		return this.serverCapabilities.get(server)?.hoverProvider === true;
	}

	/**
	 * Runs one resolved command at confirm time, gated on the server offering
	 * it in `executeCommandProvider` (#292).
	 *
	 * Fire-and-forget: a command that fails is logged, not raised, because the
	 * primary insert already landed and failing the document over a follow-up
	 * would be worse than dropping it.
	 */
	async executeCompletionCommand(
		document: LspDocumentInput,
		command: string,
		args?: readonly unknown[]
	): Promise<void> {
		const path = document.path;
		if (this.disposed || !path) return;
		if (!this.gateFor(document).enabled) return;
		let server = 'lsp';
		try {
			const target = await this.targets.resolve(document);
			if (!target) return;
			server = lspServerKey(target.descriptor.id, target.root);
			const entry = await this.ensureRunning(server, target.descriptor, target.root, target.marker);
			if (entry.state !== 'running' || !entry.client) return;
			if (!this.canExecuteCommand(server, command)) return;
			await entry.client.request(
				'workspace/executeCommand',
				{ command, arguments: args ?? [] },
				DEFAULT_FETCH_TIMEOUT_MS
			);
		} catch (error) {
			this.options.logs.appendServerNote(
				server,
				'warn',
				`Command "${command}" failed: ${describeError(error)}`
			);
		}
	}

	/** Whether one server may run a resolved command at confirm time (#292). */
	canExecuteCommand(server: string, command: string): boolean {
		return this.serverCapabilities.get(server)?.executeCommands.includes(command) === true;
	}

	private resolveKey(server: string, item: CompletionSuggestion): string {
		let data = '';
		try {
			data = JSON.stringify(item.data ?? null);
		} catch {
			data = String(item.data);
		}
		return `${server}|${item.label}|${data}`;
	}

	/**
	 * Sends the document's current text to one running server: `didOpen` the
	 * first time, full-content `didChange` after that (ADR 0020).
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
			language: this.targets.languageNameFor(input),
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
	 * Sends the documents that are waiting on one server, in the order they were
	 * presented, and empties them.
	 *
	 * `openDocument` sends nothing itself: every document it is handed goes out from
	 * here, so a queue flushed alongside a direct send cannot put the document that
	 * started a server behind the ones that were waiting for it.
	 *
	 * The gate is read again per document. A queued document was never in
	 * `openDocuments`, so {@link LspRuntime.onSettingsChanged} — which walks that map
	 * — never saw it to detach, and a switch flipped while this document was waiting
	 * has to outrank the presentation that queued it.
	 *
	 * A client that has gone ends the flush: a stop or a dispose clears it, and
	 * nothing here can start a server, so there is nothing left to send to.
	 */
	private flushPending(entry: RunningServer): void {
		if (!entry.client || this.pendingDocuments.size === 0) return;
		for (const [uri, pending] of [...this.pendingDocuments]) {
			if (pending.server !== entry.server) continue;
			this.pendingDocuments.delete(uri);
			if (!this.gateFor(pending.input).enabled) continue;
			this.syncDocument(entry, pending.input);
		}
	}

	/**
	 * Forgets the documents waiting on one server. Called where the server is being
	 * taken away on purpose — an explicit stop, a restart, a server nothing is served
	 * from any more, a disable — and where a handshake failed and will not be answered.
	 *
	 * A failed start drops rather than keeps: the text is as stale as the handshake
	 * that never answered, and the next document event presents the current one.
	 *
	 * Not part of {@link LspRuntime.stopEntry}, because one of its callers is the
	 * revival path: a document that arrives while its server is down is what brings
	 * it back, and dropping the queue there would throw away the very document that
	 * caused the restart, along with every other one presented while it was down.
	 */
	private dropResolved(server: string): void {
		if (this.resolvedItems.size === 0) return;
		for (const key of [...this.resolvedItems]) {
			if (key.startsWith(server + '|')) this.resolvedItems.delete(key);
		}
	}

	private dropPending(server: string): void {
		if (this.pendingDocuments.size === 0) return;
		for (const [uri, pending] of this.pendingDocuments) {
			if (pending.server === server) this.pendingDocuments.delete(uri);
		}
	}

	/**
	 * Restarts one server in place. Its documents are re-opened against the new
	 * process, so a restart is not a silent loss of context.
	 */
	async restartServer(server: string): Promise<boolean> {
		const existing = this.servers.get(server);
		if (!existing) return false;
		this.dropPending(server);
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
		this.dropPending(server);
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
			this.dropPending(entry.server);
			await this.stopEntry(entry);
			entry.stoppedByUser = true;
		}
	}

	/** Plugin disablement: stop everything and forget it. No process may survive. */
	async dispose(): Promise<void> {
		// Set first: a document event that lands mid-teardown must not start a
		// server the disable is in the middle of stopping.
		this.disposed = true;
		// Released before the slow part, and released at all: a settings change that
		// arrives after a disable has nothing left to act on, and holding the
		// subscription would keep a disposed runtime reachable for the rest of the
		// session.
		this.unsubscribeSettings?.();
		this.unsubscribeSettings = undefined;
		await this.stopAll();
		this.servers.clear();
		this.openDocuments.clear();
		this.pendingDocuments.clear();
		this.documentServers.clear();
		this.serverCapabilities.clear();
		this.resolvedItems.clear();
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
			// Another caller may have started a replacement while the stop was
			// in flight; returning it keeps one entry per server key.
			if (this.disposed) return existing;
			const replacement = this.servers.get(server);
			if (replacement && replacement !== existing) return replacement;
		}

		const entry: RunningServer = {
			server,
			descriptor,
			root,
			marker,
			state: 'starting',
			stoppedByUser: false,
			serverVersion: null,
			memoryBytes: null
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
			const initResult = await client.initialize({
				rootUri: toFileUri(root),
				workspaceFolders: [{ uri: toFileUri(root), name: descriptor.id }],
				capabilities: {}
			});
			this.serverCapabilities.set(server, readServerCapabilities(initResult));
			// A stop or a restart that landed while the handshake was in flight
			// wins. Otherwise the awaiting start would come back afterwards and
			// report a server the user had already stopped as running again.
			if (entry.client !== client) {
				await client.stop();
				return entry;
			}
			// A restart is a new handshake, so the version is re-reported here.
			entry.serverVersion = parseServerVersion(initResult);
			entry.state = 'running';
			this.statusChanged();
			// Fire and forget: a slow or failed observation must not hold the start.
			void this.refreshMemory(entry);
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
			this.dropPending(server);
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

	/**
	 * Never fails the start: any observation failure leaves "not reported".
	 * Guarded against a stop or restart that landed while the read was in flight.
	 */
	private async refreshMemory(entry: RunningServer): Promise<void> {
		const pid = entry.client?.pid;
		const platform = this.resolvePlatform();
		if (pid === undefined || platform?.processMemory === undefined) return;
		let bytes: number | null;
		try {
			bytes = await platform.processMemory(pid);
		} catch {
			return;
		}
		if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return;
		if (this.servers.get(entry.server) !== entry || entry.state !== 'running') return;
		entry.memoryBytes = bytes;
		this.statusChanged();
	}

	private async stopEntry(entry: RunningServer): Promise<void> {
		const client = entry.client;
		entry.client = undefined;
		entry.state = 'stopped';
		this.serverCapabilities.delete(entry.server);
		this.dropResolved(entry.server);
		// A stopped row keeps no figures from the dead process.
		entry.serverVersion = null;
		entry.memoryBytes = null;
		// The queue is deliberately untouched: one of this method's callers is the
		// revival path, where the stop is about to be followed by a start that should
		// serve whatever is still waiting. The callers that mean it drops the waiters
		// with the server say so themselves — see {@link LspRuntime.dropPending}.
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
	 *
	 * A report about a language the user turned servers off for is dropped rather
	 * than filed, and whatever was already painted for it goes with it. The gate
	 * cannot be left to "the document was never synced": a project-wide server
	 * indexes the workspace and reports on files it was never asked about, so the
	 * report arrives from a server that is running for some *other* language, or was
	 * running when the setting changed.
	 */
	private onNotification(server: string, method: string, params: unknown): void {
		if (method !== 'textDocument/publishDiagnostics') return;
		const report = parsePublishDiagnostics(server, params);
		if (!report) return;
		const fileName = basenameOfUri(report.uri);
		if (!this.gateFor({ path: fromFileUri(report.uri), fileName }).enabled) {
			this.options.diagnostics?.dropUri(report.uri);
			return;
		}
		this.options.diagnostics?.publish(report);
	}

	/**
	 * `editor.lsp` for a document's language, or the documented default when the app
	 * published no settings reader.
	 *
	 * Read per use rather than cached, so the switch cannot outlive the value it was
	 * read from; the change itself is observed too ({@link
	 * LspRuntime.onSettingsChanged}), because per-use reads only take effect when the
	 * next use happens to arrive. Resolved here rather than passed down, because the
	 * runtime is what decides whether to spawn and the document is what carries the
	 * language — see `lsp-gate.ts` for why that has to be this way.
	 */
	private gateFor(input: LspTargetInput): { enabled: boolean; reason: string } {
		const read = this.options.readSettings ?? this.publishedSettingsReader();
		if (!read) return { enabled: true, reason: '' };
		const language = this.targets.languageNameFor(input);
		if (lspEnabledFor(read, language)) return { enabled: true, reason: '' };
		return { enabled: false, reason: lspDisabledReason(language) };
	}

	/**
	 * The app's resolved settings, read through the seam rather than captured once,
	 * for the same reason the platform is: an app that publishes it after the plugin
	 * is active still gets it.
	 */
	private publishedSettingsReader(): SettingsRead | undefined {
		const reader = this.options.host.getService<SettingsReader>(SETTINGS_READER_SERVICE_KEY);
		// Narrowed into the published object's own `read` rather than captured off
		// `this`, so the call is the reader's and not the runtime's.
		return reader ? (namespace, key) => reader.read(namespace, key) : undefined;
	}

	/**
	 * Subscribes to the app's settings-value changes, once, and leaves the field
	 * empty while there is nothing to subscribe to — so an app that publishes the
	 * reader later still gets the subscription on the next document event.
	 */
	private ensureSettingsSubscription(): void {
		if (this.unsubscribeSettings) return;
		const subscribe = this.options.subscribeSettings ?? this.publishedSettingsSubscribe();
		if (subscribe) {
			this.unsubscribeSettings = subscribe(() => void this.onSettingsChanged());
		}
	}

	private publishedSettingsSubscribe(): SettingsSubscribe | undefined {
		const reader = this.options.host.getService<SettingsReader>(SETTINGS_READER_SERVICE_KEY);
		return reader?.subscribe?.bind(reader);
	}

	/**
	 * Re-evaluates the gate for every document this runtime is syncing, because a
	 * settings change is not a keystroke and waiting for the next one makes the
	 * switch look broken.
	 *
	 * Only a document whose gate actually flipped is touched. The notification says
	 * that *something* changed and the common case by a wide margin is that nothing
	 * this runtime cares about did — every unrelated setting, and every other
	 * plugin's namespace — so the work here is two settings reads per synced
	 * document and nothing else: no root walk, no spawn, no protocol traffic. A
	 * language that is turned *on* again is not acted on either; the next document
	 * event starts its server, which is the same order events have always arrived in.
	 */
	private async onSettingsChanged(): Promise<void> {
		if (this.disposed) return;
		const read = this.options.readSettings ?? this.publishedSettingsReader();
		if (!read) return;
		// Collected before the detach: detaching is what forgets which server a
		// document belonged to.
		const affected = new Set<string>();
		for (const [uri, document] of [...this.openDocuments]) {
			if (lspEnabledFor(read, document.language)) continue;
			const server = this.documentServers.get(uri);
			if (server) affected.add(server);
			this.detachDocument(uri);
		}
		for (const server of affected) await this.stopWhenUnserved(server);
	}

	/**
	 * Stops a server nothing is served from any more, and forgets it.
	 *
	 * An explicit lifecycle decision rather than teardown at the call site, so the
	 * pid accounting, the diagnostics drop and the no-orphan guarantee are the same
	 * ones an explicit stop from the status menu gets. Called for a server a gate
	 * transition may have emptied, which is the only case it acts on: a server still
	 * serving an enabled document is left running, because a settings toggle must
	 * not kill a process other open files depend on.
	 *
	 * Not `stoppedByUser`: the user did not stop it, and turning the setting back on
	 * has to bring it back on the next document event. Forgetting the entry rather
	 * than leaving it `stopped` is the point — the status menu shows what exists, and
	 * a row with no process and no document is the thing this whole slice exists to
	 * stop looking like.
	 */
	private async stopWhenUnserved(server: string): Promise<void> {
		const entry = this.servers.get(server);
		if (!entry) return;
		for (const bound of this.documentServers.values()) {
			if (bound === server) return;
		}
		// Nothing is bound to it and nothing ever will be: the gate emptied it, so the
		// documents waiting on it go with the server rather than to the next start.
		this.dropPending(server);
		await this.stopEntry(entry);
		this.servers.delete(server);
		this.statusChanged();
	}

	/**
	 * Stops tracking one document, addressed by its URI because every map here is
	 * keyed by URI: `didClose` to a server holding it, and its findings off the
	 * gutter.
	 *
	 * Not a server stop, on its own. The process is shared by every language its
	 * descriptor serves and may be mid-answer for another document, so closing one
	 * file is the whole of what the setting asks for — killing the process would be
	 * the per-process gate `lsp-gate.ts` argues against. Whether the last document
	 * just left is a separate question, asked by {@link LspRuntime.stopWhenUnserved}.
	 *
	 * A near no-op for a document the runtime never synced, which is the common case:
	 * the gate is consulted on every keystroke and most of them arrive for a
	 * document that was never scoped to a server in the first place.
	 */
	private detachDocument(uri: string): void {
		this.options.diagnostics?.dropUri(uri);
		// Ahead of the early return below: a document that has not been synced is bound
		// to nothing yet, so this is the only thing that can take it off the queue.
		// The same rule — "off" means this document is no longer that server's
		// business — reached from the queue rather than from the open set.
		this.pendingDocuments.delete(uri);
		const server = this.documentServers.get(uri);
		if (!server) return;
		const document = this.openDocuments.get(uri);
		this.documentServers.delete(uri);
		if (!document) return;
		this.openDocuments.delete(uri);
		this.servers.get(server)?.client?.notify('textDocument/didClose', { textDocument: { uri } });
	}

	private log(entry: RunningServer, level: 'info' | 'warn' | 'error', message: string): void {
		this.options.logs.appendServerNote(entry.server, level, message);
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

/**
 * Reads what a server offered out of its own `initialize` reply.
 *
 * All three are the server's to announce: a missing capability is not an
 * error, it is a server that does not offer it. `hoverProvider` arrives as
 * a boolean or an options object per the spec, so any truthy non-boolean
 * counts as offered.
 */
function readServerCapabilities(result: unknown): {
	resolveProvider: boolean;
	hoverProvider: boolean;
	executeCommands: readonly string[];
} {
	const caps = (result as { capabilities?: unknown } | null | undefined)?.capabilities;
	if (typeof caps !== 'object' || caps === null) {
		return { resolveProvider: false, hoverProvider: false, executeCommands: [] };
	}
	const record = caps as Record<string, unknown>;
	const completion = record.completionProvider as Record<string, unknown> | undefined;
	const hover = record.hoverProvider;
	const execute = record.executeCommandProvider as Record<string, unknown> | undefined;
	const commands = Array.isArray(execute?.commands)
		? (execute as { commands: unknown[] }).commands.filter((c): c is string => typeof c === 'string')
		: [];
	return {
		resolveProvider: (completion?.resolveProvider as boolean | undefined) === true,
		hoverProvider: hover === true || (typeof hover === 'object' && hover !== null),
		executeCommands: commands
	};
}

/**
 * Null for anything but a non-empty `serverInfo.version` string. A server that
 * omits the field is conforming, not broken.
 */
export function parseServerVersion(result: unknown): string | null {
	if (typeof result !== 'object' || result === null) return null;
	const info = (result as { serverInfo?: unknown }).serverInfo;
	if (typeof info !== 'object' || info === null) return null;
	const version = (info as { version?: unknown }).version;
	return typeof version === 'string' && version.length > 0 ? version : null;
}

/** Version and memory for live and starting servers; stopped and failed rows are cleared. */
function statusDetailsFor(entry: RunningServer): LspStatusDetail[] {
	if (entry.state !== 'running' && entry.state !== 'starting') return [];
	return [
		{ label: 'version', value: entry.serverVersion ?? 'not reported' },
		{
			label: 'memory',
			value: entry.memoryBytes !== null ? formatMemoryBytes(entry.memoryBytes) : 'not reported'
		}
	];
}

/** Never blank and never zero: an unknown figure is the caller's "not reported". */
export function formatMemoryBytes(bytes: number): string {
	const MIB = 1024 * 1024;
	if (bytes >= MIB) return `${Math.max(1, Math.round(bytes / MIB))} MiB`;
	return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
}
