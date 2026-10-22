/**
 * Server diagnostics, from `textDocument/publishDiagnostics` to plain data
 * (spec #263, ticket #266, ADR 0020).
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
 * A report also carries the document version it was computed against, because
 * a pull and a push for one file can be in flight at the same time and the one
 * that lands last is not the one that was computed last. The store refuses a
 * result that is older than the one it holds (ADR 0029).
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
	/**
	 * The document version the server computed these diagnostics against, when
	 * the protocol carried one. Absent means the server named no revision: it
	 * said nothing about which text it looked at, so the revision cannot order
	 * it against a result that names one, and the source does that instead
	 * (ADR 0029).
	 */
	readonly version?: number;
}

export type LspDiagnosticSource = 'push' | 'pull';

export interface LspPulledDiagnostics {
	readonly uri: string;
	readonly server: string;
	readonly diagnostics: readonly LspDiagnostic[];
	/**
	 * The document version the pull was computed against: the version last
	 * synced to that server. Absent means no revision was named, which is what
	 * a pull with nothing to compare against carries.
	 */
	readonly version?: number;
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
	const payload = params as { uri?: unknown; diagnostics?: unknown; version?: unknown } | null | undefined;
	if (!payload || typeof payload.uri !== 'string' || payload.uri.length === 0) return null;
	const entries = Array.isArray(payload.diagnostics) ? payload.diagnostics : [];
	const diagnostics: LspDiagnostic[] = [];
	for (const entry of entries) {
		const diagnostic = parseDiagnostic(server, entry);
		if (diagnostic) diagnostics.push(diagnostic);
	}
	return { uri: payload.uri, server, diagnostics, version: parseVersion(payload.version) };
}

/**
 * The document version a publish was computed against.
 *
 * The protocol's `version` is optional, and a server that sends none has said
 * nothing about which text it looked at — which is a different thing from a
 * version of zero, so absent stays absent.
 */
function parseVersion(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	return undefined;
}

/**
 * Reads a single diagnostic object from a protocol payload.
 * Drops malformed entries with invalid ranges or non-finite positions.
 */
export function parseDiagnostic(server: string, entry: unknown): LspDiagnostic | null {
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

interface StoreDiagnosticSlice {
	readonly diagnostics: readonly LspDiagnostic[];
	readonly source: LspDiagnosticSource;
	/**
	 * The document version these diagnostics were computed against, or undefined
	 * when the result named no revision.
	 *
	 * Not the store's own `revision` counter: that one says "something changed
	 * here", this one says "which text this answer is about".
	 */
	readonly version: number | undefined;
}

interface DiagnosticOrderMeta {
	readonly source: LspDiagnosticSource;
	readonly version: number | undefined;
}

export class LspDiagnosticsStore {
	private readonly byUri = new Map<string, Map<string, StoreDiagnosticSlice>>();
	private readonly orderMeta = new Map<string, Map<string, DiagnosticOrderMeta>>();
	private readonly listeners = new Set<() => void>();
	private sequence = 0;

	/**
	 * Files one server's report for one URI, replacing only that server's set.
	 * An empty report clears that server's findings and nothing else, so a
	 * second server serving the same file keeps its marks.
	 */
	publish(report: LspPublishDiagnostics): void {
		const current = this.orderMeta.get(report.uri)?.get(report.server);
		// Refused before anything else, so a report the store does not take
		// changes nothing: the slice stays as it is, the revision does not
		// move, and a view that re-reads on every notification is not woken.
		if (current && !this.accepts(current, report.version, 'push')) return;
		this.recordOrder(report.uri, report.server, 'push', report.version);
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
		const servers = existing ?? new Map<string, StoreDiagnosticSlice>();
		servers.set(report.server, {
			diagnostics: report.diagnostics,
			source: 'push',
			version: report.version
		});
		this.byUri.set(report.uri, servers);
		this.changed();
	}

	/**
	 * Files diagnostics obtained via document pull (textDocument/diagnostic).
	 * A fresh pull report takes the place of the push or pull entry it beats.
	 * An empty diagnostics list clears that server's slice with clean-file semantics.
	 */
	pull(report: LspPulledDiagnostics): void {
		const current = this.orderMeta.get(report.uri)?.get(report.server);
		if (current && !this.accepts(current, report.version, 'pull')) return;
		this.recordOrder(report.uri, report.server, 'pull', report.version);
		const existing = this.byUri.get(report.uri);
		if (report.diagnostics.length === 0) {
			if (!existing?.delete(report.server)) return;
			if (existing.size === 0) this.byUri.delete(report.uri);
			this.changed();
			return;
		}
		const servers = existing ?? new Map<string, StoreDiagnosticSlice>();
		servers.set(report.server, {
			diagnostics: report.diagnostics,
			source: 'pull',
			version: report.version
		});
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
		for (const slice of servers.values()) all.push(...slice.diagnostics);
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
		for (const [uri, servers] of [...this.orderMeta]) {
			if (!servers.delete(server)) continue;
			if (servers.size === 0) this.orderMeta.delete(uri);
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
		this.orderMeta.delete(uri);
		if (!this.byUri.delete(uri)) return;
		this.changed();
	}

	clear(): void {
		this.orderMeta.clear();
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

	/**
	 * Whether an incoming result may take the place of the one already held
	 * for a path and a server.
	 *
	 * The rule runs in the order the protocol states it: the revision decides
	 * when both answers name one and they differ, and the source decides in
	 * every other case.
	 *
	 * Two answers that name a revision are compared on it: the one computed
	 * against the older text is the older answer, so the higher revision
	 * takes the slice and the lower is refused. The source cannot say which
	 * that is — a pull that was already in flight when the text changed was
	 * computed against the text before the change, and it lands last.
	 *
	 * Two answers at the same revision are about the same text, so the
	 * revision is a tie rather than a comparison, and the source decides: a
	 * push never replaces a pull, and a pull replaces a push.
	 *
	 * Where the revisions cannot be compared — one of them names none, or
	 * neither does — the source decides as well, and it decides whichever way
	 * round the two sit: a pull is the newer word for a path and a push is
	 * not, so a pull takes the slice from a push and a push never takes it
	 * from a pull. The protocol's version is optional, so a server that sends
	 * none has said nothing about which text it looked at, and the source
	 * order is what says so.
	 *
	 * The cost is that a result that names no revision is not held back by
	 * one that does: two pushes are ordered by arrival rather than by
	 * revision, and a server that names a version on some publishes and not
	 * on others gets the later one either way.
	 *
	 * The alternative — refusing a result that names no revision against one
	 * that does, in either direction — was rejected because it makes the
	 * pull inert for every server that pushes without a version: the push
	 * names no revision, the pull does, neither displaces the other, the
	 * slice stays revision-less, and every later revisioned result is
	 * refused too. A server that says nothing about its text must not be
	 * able to overwrite an answer that does, and the source order is what
	 * says so.
	 */
	private recordOrder(
		uri: string,
		server: string,
		source: LspDiagnosticSource,
		version: number | undefined
	): void {
		let servers = this.orderMeta.get(uri);
		if (!servers) {
			servers = new Map();
			this.orderMeta.set(uri, servers);
		}
		servers.set(server, { source, version });
	}

	private accepts(
		held: DiagnosticOrderMeta,
		incomingVersion: number | undefined,
		incomingSource: LspDiagnosticSource
	): boolean {
		// Two answers that name a revision are compared on it: the one computed
		// against the older text is the older answer. The same revision is not a
		// comparison — both are about the same text — so the source decides there.
		if (
			held.version !== undefined &&
			incomingVersion !== undefined &&
			held.version !== incomingVersion
		) {
			return incomingVersion > held.version;
		}
		// One of them names no revision, so the revisions cannot be compared and
		// the source decides, as ADR 0029 decided: a pull is the newer word for a
		// path, a push is not.
		return !(incomingSource === 'push' && held.source === 'pull');
	}

	private changed(): void {
		this.sequence++;
		for (const listener of [...this.listeners]) listener();
	}
}
