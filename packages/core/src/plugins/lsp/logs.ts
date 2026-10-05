/**
 * Per-server log buffers backing the Logs tab (spec #263, ADR 0020).
 *
 * Two feeds land here: the server's own stderr, and a trace of the JSON-RPC
 * traffic. Both are per running server, so the tab can filter by server as well
 * as by kind and level.
 *
 * The buffers are CAPPED, per server, at a fixed number of entries, and every
 * protocol trace line is capped at a fixed length with document bodies replaced
 * before it is stored. A long session against a chatty server is unbounded in
 * both feeds — a protocol trace is one line per keystroke and stderr is where
 * servers go when confused — so an uncapped buffer is a slow leak that only shows
 * up in a tab nobody is looking at. Dropping the oldest entries and counting the
 * drops is the deliberate trade: a truncated tail is diagnosable, an exhausted
 * heap is not. The entry cap alone is not enough, because full-content document
 * sync makes a single entry as large as the file being edited; see
 * {@link MAX_TRACE_MESSAGE_CHARS}.
 *
 * Pure data and pure functions, no runes and no host reference, so the cap and
 * the filtering are asserted directly rather than through a rendered tab.
 */

/** Which feed a line came from. `server` is stderr and lifecycle; `protocol` is the JSON-RPC trace. */
export type LspLogKind = 'server' | 'protocol';

export type LspLogLevel = 'error' | 'warn' | 'info' | 'trace';

export interface LspLogEntry {
	/**
	 * The running server this line belongs to, as `<descriptor id>@<root>`.
	 * One descriptor serves one server per project root, so the key identifies
	 * both what is running and where, which is what a picker needs to tell two
	 * roots of the same server apart.
	 */
	readonly server: string;
	readonly kind: LspLogKind;
	readonly level: LspLogLevel;
	readonly message: string;
	/** Monotonic across the store, so ordering survives per-server capping. */
	readonly sequence: number;
}

export interface LspLogFilter {
	readonly server?: string;
	readonly kind?: LspLogKind;
	readonly level?: LspLogLevel;
}

export const DEFAULT_LOG_CAPACITY_PER_SERVER = 500;

/**
 * Longest protocol trace line kept, in characters.
 *
 * The cap on entries is not a cap on memory: it bounds how many lines a server
 * may leave, and one of those lines is whatever the server or this client sent.
 * Full-content document sync means the client puts the whole open document on the
 * wire on every keystroke, so an entry cap alone retains up to five hundred
 * copies of the file being edited — the buffer grows with the file, on the path
 * that runs while the user types. This is the second bound, and it is the one
 * that makes the buffer's size a property of the cap rather than of the document.
 *
 * Document text is removed rather than merely truncated (see
 * {@link summarizeProtocolMessage}), because the head of a JSON payload is the
 * part that identifies the conversation and the tail is the part that is just
 * the file. The value is characters rather than bytes because that is what a
 * reader of the Logs tab counts, and it is within a factor of two of the memory.
 */
export const MAX_TRACE_MESSAGE_CHARS = 2000;

/** What a removed document body is replaced with, so the trace still says it sent one. */
const REDACTED_TEXT_PREFIX = '<document text: ';

/**
 * A trace line: the message with document bodies removed, then capped.
 *
 * Never throws and never fails to produce a line — a payload it cannot parse is
 * truncated as text, which is what a server sending something other than JSON
 * deserves. Total, because the client calls it on every frame in both
 * directions and a throw here would be an exception on the keystroke path.
 */
export function summarizeProtocolMessage(payload: string): string {
	return capLength(safeRedact(payload), MAX_TRACE_MESSAGE_CHARS);
}

/**
 * Replaces the fields the protocol uses for document bodies, everywhere in the
 * message.
 *
 * Structural rather than size-based on purpose: `textDocument.text` and
 * `contentChanges[].text` are the whole document by definition, while a field
 * that merely happens to be called `text` and holds one line is still worth
 * reading in a trace. Only those two shapes are removed, so a diagnostics report,
 * a completion list and a configuration dump all survive intact.
 */
function safeRedact(payload: string): string {
	try {
		return JSON.stringify(redact(JSON.parse(payload)));
	} catch {
		return payload;
	}
}

function redact(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redact);
	if (value === null || typeof value !== 'object') return value;
	const source = value as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(source)) {
		result[key] = redactEntry(key, entry);
	}
	return result;
}

function redactEntry(key: string, value: unknown): unknown {
	if (key === 'text' && typeof value === 'string') return redactText(value);
	return redact(value);
}

function redactText(value: string): string {
	return `${REDACTED_TEXT_PREFIX}${value.length} chars>`;
}

/** Keeps the head of a line and says how much of the tail is missing. */
function capLength(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}… (+${text.length - max} chars)`;
}

/**
 * Key the LSP plugin publishes its log store under, so the Logs tab (#266) can
 * read the buffers without importing plugin state. Value shape is owned by the
 * pair — this store and that tab — and the host treats the service as opaque
 * (ADR 0008), exactly as the `git:ui-components` precedent does. The UI side
 * derives the same string from the manifest id.
 */
export const LSP_LOG_STORE_SERVICE_KEY = 'lsp:log-store';

/**
 * Appends to one server's buffer, dropping the oldest entries past the cap.
 *
 * Exported as the cap's only implementation so the bound is asserted directly:
 * the store is a thin shell around it, and a bug that grows the buffer instead
 * of truncating it would otherwise only be observable through a tab.
 */
export function appendCapped(
	entries: readonly LspLogEntry[],
	entry: LspLogEntry,
	capacity: number
): { entries: LspLogEntry[]; dropped: number } {
	if (capacity <= 0) return { entries: [], dropped: entries.length + 1 };
	if (entries.length < capacity) return { entries: [...entries, entry], dropped: 0 };
	const dropped = entries.length - capacity + 1;
	return { entries: [...entries.slice(dropped), entry], dropped };
}

/**
 * Classifies a line of server stderr.
 *
 * Servers do not tag their stderr, so the level is read off the text: a line
 * that says `error` is an error even though it arrived on a stream the spec
 * only says is "diagnostic output". Everything else is information, because a
 * server that logs freely at warn would bury the errors in its own noise.
 */
export function classifyServerOutput(line: string): LspLogLevel {
	const lowered = line.toLowerCase();
	if (lowered.includes('error') || lowered.includes('fatal') || lowered.includes('exception')) {
		return 'error';
	}
	if (lowered.includes('warn')) return 'warn';
	return 'info';
}

/**
 * The newest request to narrow the Logs tab to one server.
 *
 * A request rather than a setting, because the Logs tab has a picker of its own:
 * the command that opens the tab names a server and the tab opens on it, after
 * which the reader is free to change or clear that selection by hand. Hence the
 * number beside the server — the tab needs to tell a fresh request from a repeat
 * (asking twice for the server it already shows is still an ask) and from an
 * appended line, which is not an ask at all and arrives on every keystroke.
 */
export interface LspLogsFocus {
	/** The `<descriptor id>@<root>` key to show, or null for every server. */
	readonly server: string | null;
	/** Bumped per request, including a repeat of the server already asked for. */
	readonly request: number;
}

export class LspLogStore {
	private readonly buffers = new Map<string, LspLogEntry[]>();
	private nextSequence = 0;
	private dropped = 0;
	private focus: LspLogsFocus = { server: null, request: 0 };
	private readonly listeners = new Set<() => void>();

	constructor(private readonly capacityPerServer: number = DEFAULT_LOG_CAPACITY_PER_SERVER) {}

	append(input: Omit<LspLogEntry, 'sequence'>): LspLogEntry {
		const entry: LspLogEntry = { ...input, sequence: this.nextSequence++ };
		const existing = this.buffers.get(entry.server) ?? [];
		const result = appendCapped(existing, entry, this.capacityPerServer);
		this.buffers.set(entry.server, result.entries);
		this.dropped += result.dropped;
		this.notify();
		return entry;
	}

	/** Appends one server stderr line, classifying its level. */
	appendServerLine(server: string, line: string): LspLogEntry {
		return this.append({ server, kind: 'server', level: classifyServerOutput(line), message: line });
	}

	/**
	 * Appends one JSON-RPC message, outbound or inbound, as a trace line.
	 *
	 * Summarized rather than stored whole: the conversation is what a reader of
	 * the Logs tab is debugging, and full-content sync would otherwise park a
	 * copy of the open document in the buffer on every keystroke.
	 */
	appendProtocolTrace(server: string, direction: 'sent' | 'received', message: string): LspLogEntry {
		return this.append({
			server,
			kind: 'protocol',
			level: 'trace',
			message: `${direction === 'sent' ? '-->' : '<--'} ${summarizeProtocolMessage(message)}`
		});
	}

	/**
	 * Every matching entry in the order it was appended, across all servers.
	 * Interleaved rather than grouped: the tab is a chronological feed, and a
	 * server's protocol trace is only readable against its own stderr.
	 */
	read(filter: LspLogFilter = {}): LspLogEntry[] {
		const all: LspLogEntry[] = [];
		for (const [server, entries] of this.buffers) {
			if (filter.server !== undefined && filter.server !== server) continue;
			for (const entry of entries) {
				if (filter.kind !== undefined && filter.kind !== entry.kind) continue;
				if (filter.level !== undefined && filter.level !== entry.level) continue;
				all.push(entry);
			}
		}
		return all.sort((a, b) => a.sequence - b.sequence);
	}

	/** Server keys with buffered lines, in the order they first appeared. */
	servers(): string[] {
		return [...this.buffers.keys()];
	}

	/**
	 * Asks the Logs tab to show one server's lines, or every server's when
	 * unnamed — which is what the palette's argument-free entry means.
	 *
	 * Counted rather than compared: re-opening the tab for the server it is
	 * already focused on is as much a request as any other, and the tab decides
	 * for itself whether to act on it (see {@link LspLogsFocus}).
	 */
	requestFocus(server?: string): void {
		this.focus = {
			server: server !== undefined && server.length > 0 ? server : null,
			request: this.focus.request + 1
		};
		this.notify();
	}

	/** The newest narrowing request, so the tab can tell a fresh one from a repeat. */
	get focused(): LspLogsFocus {
		return this.focus;
	}

	/** The Clear action: one server's buffer, or every buffer when unnamed. */
	clear(server?: string): void {
		if (server === undefined) {
			this.buffers.clear();
			this.dropped = 0;
			this.notify();
			return;
		}
		this.buffers.delete(server);
		this.notify();
	}

	/** Entries the cap discarded, so a truncated buffer never reads as complete. */
	get droppedCount(): number {
		return this.dropped;
	}

	/** Bumped on every append and clear, so a view can re-read without polling. */
	get revision(): number {
		return this.nextSequence;
	}

	/**
	 * Notified whenever a buffer changes, so the Logs tab re-reads instead of
	 * polling. Pure data and plain callbacks on purpose: the store must not need
	 * a rune to be observable.
	 */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private notify(): void {
		for (const listener of [...this.listeners]) listener();
	}
}

/** Splits a stderr chunk into whole lines, keeping a partial tail for the next chunk. */
export function splitLogLines(buffered: string, chunk: string): { lines: string[]; rest: string } {
	const combined = buffered + chunk;
	const parts = combined.split(/\r?\n/);
	const rest = parts.pop() ?? '';
	return { lines: parts, rest };
}
