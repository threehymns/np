import type { LspProcess } from '../services';
import { describeError } from './describe-error';
import { LspLogStore, splitLogLines } from './logs';

/**
 * JSON-RPC over stdio, as the LSP plugin's own code (spec #263, ADR 0020).
 *
 * Framing is `Content-Length` headers, a `\r\n\r\n` separator, then exactly that
 * many bytes of UTF-8 body. The parser is byte-oriented on purpose: a pipe
 * read can split anywhere, including inside a multi-byte character, so decoding
 * a chunk as it arrives turns `café` into `caf<U+FFFD>`. Headers are ASCII by
 * spec and only ever a handful of bytes, so they are decoded as text; a body is
 * decoded only once all of its bytes have arrived, which makes the decode exact
 * by construction rather than by a `stream: true` dance. The same lesson is
 * written into `apps/desktop/src/main.ts` for git output.
 *
 * Nothing here needs a Node global, so the client runs unchanged in the browser
 * build, where the transport seam simply never supplies a process (ADR 0006
 * permits that; web is out of scope for spec #263).
 */

const CRLFCRLF = [13, 10, 13, 10];
const textEncoder = new TextEncoder();
const headerDecoder = new TextDecoder('ascii');
const bodyDecoder = new TextDecoder('utf-8');

/** Encodes one message as a framed payload. Byte length, not string length. */
export function frameMessage(payload: string): Uint8Array {
	const body = textEncoder.encode(payload);
	const header = textEncoder.encode(`Content-Length: ${body.byteLength}\r\n\r\n`);
	const framed = new Uint8Array(header.byteLength + body.byteLength);
	framed.set(header, 0);
	framed.set(body, header.byteLength);
	return framed;
}

export interface FrameParser {
	/** Feeds bytes in, returns every complete message body they finished. */
	push(chunk: Uint8Array): string[];
}

function indexOfSeparator(bytes: Uint8Array, from: number): number {
	for (let i = from; i <= bytes.length - CRLFCRLF.length; i++) {
		if (
			bytes[i] === CRLFCRLF[0] &&
			bytes[i + 1] === CRLFCRLF[1] &&
			bytes[i + 2] === CRLFCRLF[2] &&
			bytes[i + 3] === CRLFCRLF[3]
		) {
			return i;
		}
	}
	return -1;
}

export function createFrameParser(): FrameParser {
	let buffered = new Uint8Array(0);
	let contentLength = -1;

	return {
		push(chunk) {
			const merged = new Uint8Array(buffered.length + chunk.length);
			merged.set(buffered, 0);
			merged.set(chunk, buffered.length);
			buffered = merged;

			const messages: string[] = [];
			for (;;) {
				if (contentLength < 0) {
					const separator = indexOfSeparator(buffered, 0);
					if (separator < 0) break;
					const header = headerDecoder.decode(buffered.subarray(0, separator));
					const match = /content-length:\s*(\d+)/i.exec(header);
					if (!match) {
						// Unframeable input on a stream that only ever carries
						// frames means the two sides disagree about the protocol.
						// Dropping the header is the only recovery that can make
						// progress; the trace shows what arrived.
						buffered = buffered.slice(separator + CRLFCRLF.length);
						continue;
					}
					contentLength = Number(match[1]);
					buffered = buffered.slice(separator + CRLFCRLF.length);
				}
				if (buffered.length < contentLength) break;
				const body = buffered.slice(0, contentLength);
				buffered = buffered.slice(contentLength);
				contentLength = -1;
				messages.push(bodyDecoder.decode(body));
			}
			return messages;
		}
	};
}

export interface JsonRpcMessage {
	readonly jsonrpc?: string;
	readonly id?: number | string | null;
	readonly method?: string;
	readonly params?: unknown;
	readonly result?: unknown;
	readonly error?: { code?: number; message?: string };
}

export interface LspClientOptions {
	readonly process: LspProcess;
	/** Log key of the running server, `<descriptor id>@<root>`. */
	readonly server: string;
	readonly logs: LspLogStore;
	/**
	 * Bound on how long `shutdown` may wait for a reply before the process is
	 * killed. A server that ignores `shutdown` must still die: leaving it behind
	 * is the orphan a disable has to prevent (ADR 0009).
	 */
	readonly shutdownTimeoutMs?: number;
	/**
	 * Bound on the `initialize` handshake, distinct from the fetch timeout the
	 * settings own (#265). A server that cannot complete the handshake cannot
	 * serve anything, so an unbounded wait would strand the runtime on a
	 * document it will never be able to answer.
	 */
	readonly initializeTimeoutMs?: number;
	/**
	 * Server-to-client notifications, which carry no id and expect no reply.
	 * Diagnostics arrive this way. A notification the caller does not handle is
	 * still recorded in the protocol trace, so nothing is lost by having no
	 * listener at all.
	 */
	readonly onNotification?: (method: string, params: unknown) => void;
}

export class LspRequestError extends Error {
	readonly code: number | undefined;

	constructor(server: string, method: string, error: { code?: number; message?: string } | undefined) {
		super(
			`Language server request "${method}" for "${server}" failed: ${error?.message ?? 'unknown error'}` +
				`${error?.code !== undefined ? ` (code ${error.code})` : ''}.\n` +
				`Action: Inspect this server's logs ("${server}") for the failing method; the plugin degrades to no LSP result rather than failing the document.`
		);
		this.name = 'LspRequestError';
		this.code = error?.code;
	}
}

export class LspTimeoutError extends Error {
	constructor(server: string, method: string, timeoutMs: number) {
		super(
			`Language server "${server}" did not answer "${method}" within ${timeoutMs}ms.\n` +
				`Action: Raise the fetch timeout setting if this server is simply slow, or restart it from the status menu if it is wedged.`
		);
		this.name = 'LspTimeoutError';
	}
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2000;
/** Short: a server that has not left by now is one that will not leave at all. */
const DEFAULT_EXIT_TIMEOUT_MS = 1000;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 5000;

interface PendingRequest {
	readonly method: string;
	resolve(value: unknown): void;
	reject(error: unknown): void;
}

export class LspClient {
	private readonly parser = createFrameParser();
	private readonly pending = new Map<number, PendingRequest>();
	private nextId = 1;
	private disposed = false;
	private stderrRest = '';
	/**
	 * stderr is decoded as a stream, unlike a frame body. stderr is not framed,
	 * so a pipe read can end inside a multi-byte character; a one-shot decode
	 * would write U+FFFD into a diagnostic line — the same corruption the frame
	 * parser avoids by only decoding whole frames.
	 */
	private readonly stderrDecoder = new TextDecoder('utf-8');
	private exitInfo: { code: number | null; signal: string | null } | null = null;

	constructor(private readonly options: LspClientOptions) {
		options.process.stdout.onData((chunk) => this.receive(chunk));
		options.process.stderr.onData((chunk) => this.receiveStderr(chunk));
		void options.process.exit.then((exit) => {
			this.exitInfo = exit;
			const error = new Error(
				`Language server "${options.server}" exited (code ${exit.code ?? 'null'}, signal ${exit.signal ?? 'none'}` +
				`${exit.error ? `, ${exit.error}` : ''}).`
			);
			for (const [, waiter] of this.pending) waiter.reject(error);
			this.pending.clear();
		});
	}

	get pid(): number | undefined {
		return this.options.process.pid;
	}

	notify(method: string, params?: unknown): void {
		this.send({ jsonrpc: '2.0', method, params });
	}

	async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
		const id = this.nextId++;
		const message = { jsonrpc: '2.0', id, method, params };
		const settled = new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { method, resolve, reject });
		});
		this.send(message);
		if (timeoutMs === undefined) return await settled;
		return await withTimeout(settled, timeoutMs, () => {
			this.pending.delete(id);
		}, () => new LspTimeoutError(this.options.server, method, timeoutMs));
	}

	/**
	 * `initialize` then `initialized`, the handshake every server requires
	 * before it will answer anything else.
	 *
	 * Full-document sync is what is sent: every change carries the whole text.
	 * Incremental sync is the recorded later optimisation (ADR 0020), held back
	 * until large-file behaviour is actually measured rather than assumed. The
	 * sync kind itself is the server's `change` to announce, so the client's
	 * declaration is only which sync notifications it supports — and it sends
	 * none of the save-time ones.
	 */
	async initialize(params: Record<string, unknown>): Promise<unknown> {
		const result = await this.request(
			'initialize',
			{
				processId: await this.resolveProcessId(),
				clientInfo: { name: 'np' },
				...params,
				capabilities: {
					// ClientCapabilities per LSP 3.17: what this client does, not
					// what a server offers. The previous table used
					// server-capability names (`textDocumentSync`,
					// `completionProvider`) here, which spec-correct servers
					// ignore — so one answered as if no completion support had
					// been declared at all.
					textDocument: {
						synchronization: {
							dynamicRegistration: false,
							willSave: false,
							willSaveWaitUntil: false,
							didSave: false
						},
						completion: {
							// The client issues `textDocument/completion` (see
							// `LspRuntime.fetch`) and must say so. Declaring nothing while
							// asking for the answers anyway is a protocol error: a server is
							// entitled to answer "no completions here" for a client that never
							// advertised that it wanted any, and vtsls does exactly that.
							dynamicRegistration: false,
							completionItem: {
								// No `resolveSupport`, deliberately, and the reasoning is the
								// same as the declaration above. Nothing in the client
								// implements `completionItem/resolve` (ADR 0021 records why:
								// CodeMirror has no "this option is now selected" hook, so
								// the round trip has nowhere to hang), and advertising
								// properties to resolve would be a claim the client cannot
								// keep — at the cost of a request per keystroke.
								//
								// No trigger-character declaration either, for the same
								// reason from the other side: trigger characters arrive in
								// the *server's* `completionProvider`, and there is no
								// client-capability field for them. This client has no
								// per-character trigger to declare: CodeMirror decides when
								// to ask, the trigger policy filters it (`min_word_length`,
								// prose silence, the global popup toggle), and the field
								// stays descriptor data out of the client's table by the
								// same ADR 0020 boundary as before.
							}
						}
					},
					...((params.capabilities as Record<string, unknown> | undefined) ?? {})
				}
			},
			this.options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS
		);
		this.notify('initialized', {});
		return result;
	}

	/**
	 * The client pid to declare in `initialize`, or null when the transport cannot
	 * name the parent.
	 *
	 * The spec uses `processId` for one thing: a server watches the parent and exits
	 * when it dies, so a renderer that crashes does not leave a server running for
	 * the rest of the login. `null` is the spec's own "no process id available", so
	 * it stays the honest answer — but the desktop transport *does* have the parent
	 * and arrives at it over IPC, two round trips after `spawn()` returned. Reading
	 * `process.parentPid` while building the params therefore finds nothing and sends
	 * nothing, which is why the value is awaited rather than read once.
	 *
	 * Bounded by the handshake budget and degrading to `null` rather than hanging:
	 * a transport that never names its parent must not strand the runtime on a
	 * document it can never serve. Waiting cannot cost more than it already did —
	 * this client's first write is deferred until the transport names the parent
	 * anyway — so the bound is a guard against a broken transport, not against IPC.
	 */
	private async resolveProcessId(): Promise<number | null> {
		const known = this.options.process.parentPid;
		if (known !== undefined) return known;
		const ready = this.options.process.ready;
		if (!ready) return null;
		return (await settleWithin(ready, this.options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS)) ?? null;
	}

	/**
	 * `shutdown`, then `exit`, then a kill for any server that outlives the bound.
	 *
	 * Every wait here is bounded, including the wait for the process to go. A
	 * server that answers neither notification must still be killed, and an
	 * unbounded wait for its exit would hang the disable that asked for it — the
	 * orphan case is precisely the one that must not be trusted to cooperate.
	 */
	async stop(): Promise<void> {
		if (this.disposed) return;
		const bound = this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
		try {
			await this.request('shutdown', null, bound);
			this.notify('exit');
		} catch (error) {
			this.options.logs.appendServerNote(
				this.options.server,
				'warn',
				`Shutdown handshake failed, killing the process instead: ${describeError(error)}`
			);
		}
		if (!(await this.waitForExit(DEFAULT_EXIT_TIMEOUT_MS))) {
			this.options.logs.appendServerNote(
				this.options.server,
				'warn',
				`Server did not exit after shutdown and exit, killing it.`
			);
		}
		this.options.process.kill();
		this.dispose();
	}

	private async waitForExit(timeoutMs: number): Promise<boolean> {
		if (this.exitInfo !== null) return true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const expiry = new Promise<'timeout'>((resolve) => {
			timer = setTimeout(() => resolve('timeout'), timeoutMs);
		});
		try {
			const outcome = await Promise.race([
				this.options.process.exit.then(() => 'exited' as const),
				expiry
			]);
			return outcome === 'exited';
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	/**
	 * Detaches and settles: anything still awaiting a reply is failed rather than
	 * left pending, because a caller that awaited a request this client has just
	 * abandoned would wait forever. Safe to call twice.
	 */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		const error = new Error(
			`Language server "${this.options.server}" was released before it answered.\n` +
				`Action: Check this server's logs ("${this.options.server}"); the request was abandoned with the client.`
		);
		for (const [, waiter] of this.pending) waiter.reject(error);
		this.pending.clear();
	}

	private send(message: JsonRpcMessage): void {
		const payload = JSON.stringify(message);
		this.options.logs.appendProtocolTrace(this.options.server, 'sent', payload);
		this.options.process.stdin.write(frameMessage(payload));
	}

	private receive(chunk: Uint8Array): void {
		for (const body of this.parser.push(chunk)) {
			this.options.logs.appendProtocolTrace(this.options.server, 'received', body);
			let message: JsonRpcMessage;
			try {
				message = JSON.parse(body) as JsonRpcMessage;
			} catch {
				this.options.logs.appendServerNote(
					this.options.server,
					'error',
					`Discarded an unparseable message: ${body.slice(0, 200)}`
				);
				continue;
			}
			if (
				typeof message.method === 'string' &&
				(message.id === undefined || message.id === null)
			) {
				this.options.onNotification?.(message.method, message.params);
				continue;
			}
			if (typeof message.id === 'number' && (message.result !== undefined || message.error !== undefined)) {
				const waiter = this.pending.get(message.id);
				if (!waiter) continue;
				this.pending.delete(message.id);
				if (message.error) waiter.reject(new LspRequestError(this.options.server, waiter.method, message.error));
				else waiter.resolve(message.result);
				continue;
			}
		}
	}

	private receiveStderr(chunk: Uint8Array): void {
		const { lines, rest } = splitLogLines(
			this.stderrRest,
			this.stderrDecoder.decode(chunk, { stream: true })
		);
		this.stderrRest = rest;
		for (const line of lines) {
			if (line.trim().length > 0) this.options.logs.appendServerLine(this.options.server, line);
		}
	}
}

async function withTimeout<T>(
	settled: Promise<T>,
	timeoutMs: number,
	onTimeout: () => void,
	makeError: () => Error
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expiry = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			onTimeout();
			reject(makeError());
		}, timeoutMs);
	});
	try {
		return await Promise.race([settled, expiry]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * A value, or null when it did not arrive in time. Unlike {@link withTimeout}
 * this does not fail the operation it is waiting on: a late answer to a question
 * whose default is "none" is the same answer as no answer, and raising here would
 * turn a slow transport into a failed handshake.
 */
async function settleWithin<T>(pending: Promise<T>, timeoutMs: number): Promise<T | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expiry = new Promise<'timeout'>((resolve) => {
		timer = setTimeout(() => resolve('timeout'), timeoutMs);
	});
	try {
		const outcome = await Promise.race([pending, expiry]);
		return outcome === 'timeout' ? null : outcome;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
