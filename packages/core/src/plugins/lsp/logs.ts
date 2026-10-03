/**
 * Per-server log buffers backing the Logs tab (spec #263, ADR 0019).
 *
 * Two feeds land here: the server's own stderr, and a trace of the JSON-RPC
 * traffic. Both are per running server, so the tab can filter by server as well
 * as by kind and level.
 *
 * The buffers are CAPPED, per server, at a fixed number of entries. A long
 * session against a chatty server is unbounded in both feeds — a protocol trace
 * is one line per keystroke and stderr is where servers go when confused — so an
 * uncapped buffer is a slow leak that only shows up in a tab nobody is looking
 * at. Dropping the oldest entries and counting the drops is the deliberate
 * trade: a truncated tail is diagnosable, an exhausted heap is not.
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

export class LspLogStore {
	private readonly buffers = new Map<string, LspLogEntry[]>();
	private nextSequence = 0;
	private dropped = 0;
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

	/** Appends one JSON-RPC message, outbound or inbound, as a trace line. */
	appendProtocolTrace(server: string, direction: 'sent' | 'received', message: string): LspLogEntry {
		return this.append({
			server,
			kind: 'protocol',
			level: 'trace',
			message: `${direction === 'sent' ? '-->' : '<--'} ${message}`
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
