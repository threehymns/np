/**
 * Server diagnostics, from `textDocument/publishDiagnostics` to plain data
 * (spec #263, ticket #266, ADR 0019).
 *
 * The protocol half lives here and stays free of CodeMirror: a server reports
 * per URI, its positions are line/character pairs against the text the server
 * last saw, and a publish carrying no diagnostics is how it says "this file is
 * clean" — which has to remove that server's entry rather than record an empty
 * list, or a fixed file keeps its underline forever.
 *
 * Reports are keyed by server *within* each URI, not by URI alone. Two servers
 * can report on one file — a language server and one that only knows about a
 * framework's config — and the protocol's publish is per server: each replaces
 * its own set, never the other's. A URI-keyed store would make the second
 * server's publish overwrite the first's, and make the first server stopping
 * erase everything the second still believes.
 *
 * The editor half is `diagnostic-decorations.ts`, because marks are the only
 * part that needs a CodeMirror import and the store has to stay testable on its
 * own. Neither half holds a view: the plugin may not touch it (ADR 0016), so the
 * store is the only thing that changes and the decoration reads from it.
 */

export type LspDiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

export interface LspPosition {
	/** Zero-based, as the protocol numbers lines. */
	readonly line: number;
	/** UTF-16 code units from the line start, which is also a JS string index. */
	readonly character: number;
}

export interface LspRange {
	readonly start: LspPosition;
	readonly end: LspPosition;
}

export interface LspDiagnostic {
	/** Running server that reported it, as `<descriptor id>@<root>`. */
	readonly server: string;
	readonly range: LspRange;
	readonly severity: LspDiagnosticSeverity;
	readonly message: string;
	readonly source: string | null;
	readonly code: string | null;
}

export interface LspPublishDiagnostics {
	readonly uri: string;
	/**
	 * The running server this report came from, as `<descriptor id>@<root>`.
	 * Carried on the report rather than read off its first diagnostic, because a
	 * clean report has none — and "this server says this file is clean" is the
	 * one publish that must not clear a sibling server's findings.
	 */
	readonly server: string;
	readonly diagnostics: readonly LspDiagnostic[];
}

/** Protocol severity codes. Anything outside this is left to the client. */
const SEVERITY_BY_CODE: Record<number, LspDiagnosticSeverity> = {
	1: 'error',
	2: 'warning',
	3: 'info',
	4: 'hint'
};

/**
 * Severity from the protocol's numeric code.
 *
 * The spec leaves an omitted or out-of-range severity to the client, and an
 * error is the answer every client in the ecosystem gives: rendering a build
 * failure as a hint hides the one line the user came for.
 */
export function severityFromCode(value: unknown): LspDiagnosticSeverity {
	if (typeof value === 'number') {
		const mapped = SEVERITY_BY_CODE[value];
		if (mapped !== undefined) return mapped;
	}
	return 'error';
}

/**
 * Reads one `textDocument/publishDiagnostics` payload.
 *
 * Defensive throughout, because the payload is whatever a server chose to send:
 * a missing URI makes the whole report unusable and is rejected, while a single
 * malformed entry is dropped and the rest still render. Returns null only when
 * there is nothing to file the report under.
 */
export function parsePublishDiagnostics(
	server: string,
	params: unknown
): LspPublishDiagnostics | null {
	const payload = params as { uri?: unknown; diagnostics?: unknown } | null | undefined;
	if (!payload || typeof payload.uri !== 'string' || payload.uri.length === 0) return null;
	const entries = Array.isArray(payload.diagnostics) ? payload.diagnostics : [];
	const diagnostics: LspDiagnostic[] = [];
	for (const entry of entries) {
		const diagnostic = parseDiagnostic(server, entry);
		if (diagnostic) diagnostics.push(diagnostic);
	}
	return { uri: payload.uri, server, diagnostics };
}

function parseDiagnostic(server: string, entry: unknown): LspDiagnostic | null {
	const raw = entry as
		| {
				range?: unknown;
				severity?: unknown;
				message?: unknown;
				source?: unknown;
				code?: unknown;
		  }
		| null
		| undefined;
	if (!raw) return null;
	const range = parseRange(raw.range);
	// No range means nowhere to put it, and inventing one would paint an error
	// on a line the server never named.
	if (!range) return null;
	return {
		server,
		range,
		severity: severityFromCode(raw.severity),
		message: typeof raw.message === 'string' ? raw.message : '',
		source: typeof raw.source === 'string' ? raw.source : null,
		code: codeText(raw.code)
	};
}

function parseRange(value: unknown): LspRange | null {
	const raw = value as { start?: unknown; end?: unknown } | null | undefined;
	if (!raw) return null;
	const start = parsePosition(raw.start);
	const end = parsePosition(raw.end);
	if (!start || !end) return null;
	return { start, end };
}

function parsePosition(value: unknown): LspPosition | null {
	const raw = value as { line?: unknown; character?: unknown } | null | undefined;
	if (!raw) return null;
	if (typeof raw.line !== 'number' || !Number.isFinite(raw.line)) return null;
	if (typeof raw.character !== 'number' || !Number.isFinite(raw.character)) return null;
	return { line: raw.line, character: raw.character };
}

/** LSP allows a number or a string code, and only the text is worth showing. */
function codeText(value: unknown): string | null {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	return null;
}

export class LspDiagnosticsStore {
	private readonly byUri = new Map<string, Map<string, readonly LspDiagnostic[]>>();
	private readonly listeners = new Set<() => void>();
	private sequence = 0;

	/**
	 * Files one server's report for one URI, replacing only that server's set.
	 * An empty report clears that server's findings and nothing else, so a
	 * second server serving the same file keeps its marks.
	 */
	publish(report: LspPublishDiagnostics): void {
		const existing = this.byUri.get(report.uri);
		if (report.diagnostics.length === 0) {
			// Nothing filed and nothing to clear: not a change, so a view that
			// re-reads on every notification is not woken for a file no server has
			// an opinion about.
			if (!existing?.delete(report.server)) return;
			if (existing.size === 0) this.byUri.delete(report.uri);
			this.changed();
			return;
		}
		const servers = existing ?? new Map<string, readonly LspDiagnostic[]>();
		servers.set(report.server, report.diagnostics);
		this.byUri.set(report.uri, servers);
		this.changed();
	}

	/**
	 * Every server's findings for one URI. Servers are read in the order they
	 * first published, and each server's own list keeps the order it arrived in,
	 * so one report is not reshuffled because an unrelated server said something.
	 */
	read(uri: string): readonly LspDiagnostic[] {
		const servers = this.byUri.get(uri);
		if (!servers) return [];
		const all: LspDiagnostic[] = [];
		for (const diagnostics of servers.values()) all.push(...diagnostics);
		return all;
	}

	uris(): string[] {
		return [...this.byUri.keys()];
	}

	/**
	 * Drops one server's findings and leaves every other server's for that URI.
	 *
	 * A stopped server's findings describe a process that is no longer watching
	 * the file, and leaving them painted would make a restart look like it did
	 * nothing. But a URI is not owned by one server: a document can be served by
	 * two, and dropping the whole entry would erase the other server's findings as
	 * a side effect of the first one stopping. So only that server's slice goes,
	 * and a URI whose last slice went goes with it.
	 */
	dropServer(server: string): void {
		let dropped = false;
		for (const [uri, servers] of [...this.byUri]) {
			if (!servers.delete(server)) continue;
			if (servers.size === 0) this.byUri.delete(uri);
			dropped = true;
		}
		if (dropped) this.changed();
	}

	/**
	 * Drops every server's findings for one URI.
	 *
	 * The counterpart to `dropServer`, for the case where the document rather than
	 * the process has gone away: a language with `editor.lsp` off stops being
	 * diagnosed, and findings painted before that was set are a description of a
	 * server that is no longer meant to have an opinion. Both servers' slices go,
	 * because neither is still serving the file.
	 */
	dropUri(uri: string): void {
		if (!this.byUri.delete(uri)) return;
		this.changed();
	}

	clear(): void {
		if (this.byUri.size === 0) return;
		this.byUri.clear();
		this.changed();
	}

	/** Bumped on every change, so a consumer can notice without subscribing. */
	get revision(): number {
		return this.sequence;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private changed(): void {
		this.sequence++;
		for (const listener of [...this.listeners]) listener();
	}
}
