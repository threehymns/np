import {
	fromFileUri,
	type DiagnosticSeverity,
	type DiagnosticsSeverityFilter,
	type DiagnosticsSort,
	type LspDiagnostic
} from '@np/core';

/**
 * What the project-wide diagnostics tab shows, as data (spec #309, issue #309,
 * ADR 0022, ADR 0029).
 *
 * The tab is a view over the merged diagnostics store: it reads the findings
 * the store holds and decides which of them the reader sees, in what order,
 * and with which lines around them. All three decisions are here, as pure
 * functions of the store's contents and the tab's own filter, so they are
 * asserted without a rendered tab — the tab itself is markup over this, plus
 * the subscription that turns a store change into reactive state.
 *
 * Plain module on purpose: no runes (see `tests/runes-file-placement.test.ts`),
 * and the store is taken as its read side so a test can drive a real one.
 */

/**
 * The slice of the merged store the tab reads.
 *
 * Exactly the store's public surface, and nothing else: the tab never sees a
 * client, a server or a protocol message, so it cannot report a finding the
 * editor does not paint or miss one the editor does.
 */
export interface DiagnosticsStoreReader {
	read(uri: string): readonly LspDiagnostic[];
	uris(): string[];
}

/**
 * The text of a file, by its path, or undefined when the tab has none.
 *
 * The text is the workspace's own: a document the editor has open, with the
 * unsaved edits in it. A file the workspace has no document for has no text
 * here, and the finding is shown without its surroundings rather than against
 * a second reading of the disk.
 */
export type DiagnosticsTextReader = (path: string) => string | undefined;

/** One line of the code around a finding. */
export interface DiagnosticsExcerptLine {
	/** 1-based, as an editor counts lines. */
	readonly number: number;
	readonly text: string;
	/** True for the lines the finding covers. */
	readonly flagged: boolean;
}

/** One finding, as the tab shows it. */
export interface DiagnosticsViewEntry {
	/** The URI the server addressed the file with. */
	readonly uri: string;
	/** The file's path. */
	readonly path: string;
	readonly severity: DiagnosticSeverity;
	readonly message: string;
	readonly source: string | null;
	readonly code: string | null;
	/** The server that reported it. */
	readonly server: string;
	/** 0-based, as the protocol numbers lines. */
	readonly line: number;
	/** 0-based, as the protocol counts characters in the line. */
	readonly character: number;
	/**
	 * The lines around the finding, or null when there are none to show: the
	 * file has no text, or the finding is about a line the text no longer has.
	 */
	readonly excerpt: readonly DiagnosticsExcerptLine[] | null;
}

/** One file's findings, as a multibuffer section. */
export interface DiagnosticsViewSection {
	/** The path the section is named by. */
	readonly filepath: string;
	/** Stable identity across content updates. */
	readonly key: string;
	/** The file's absolute path. */
	readonly path: string;
	readonly entries: readonly DiagnosticsViewEntry[];
	/** The most serious severity among the findings. */
	readonly severity: DiagnosticSeverity;
}

/** Everything the tab renders. */
export interface DiagnosticsView {
	readonly sections: readonly DiagnosticsViewSection[];
	/** Every finding, in the order the tab shows them. */
	readonly entries: readonly DiagnosticsViewEntry[];
	/** "3 findings". */
	readonly count: string;
	readonly empty: boolean;
}

export interface DiagnosticsViewOptions {
	/** The severity the reader narrowed to, or `all`. */
	readonly filter: DiagnosticsSeverityFilter;
	/** The order the findings are shown in. */
	readonly sort: DiagnosticsSort;
	/** Where the text of a file comes from. */
	readonly readText?: DiagnosticsTextReader;
	/** The project root, so a path can be shown relative to it. */
	readonly rootPath?: string | null;
}

/**
 * How many lines of context surround a finding.
 *
 * Two on each side: enough to see what the finding is about — the statement
 * it sits in, and the one before it — without turning every finding into a
 * screenful.
 */
export const DIAGNOSTICS_CONTEXT_LINES = 2;

/** The severity order: the first is the most serious. */
const SEVERITY_RANK: Record<DiagnosticSeverity, number> = {
	error: 0,
	warning: 1,
	info: 2,
	hint: 3
};

/**
 * The findings the tab shows, in the order it shows them, grouped by file.
 *
 * The severity order is the one a reader wants: the most serious first, then
 * the file, then the position in it — so two findings of the same severity in
 * the same file keep the order the file has them in, and a file's findings
 * stay together under the file's header. The path order reads the project as
 * a tree of files instead, and inside a file it is the file's own order.
 */
export function diagnosticsView(
	store: DiagnosticsStoreReader | undefined,
	options: DiagnosticsViewOptions
): DiagnosticsView {
	const entries: DiagnosticsViewEntry[] = [];
	for (const uri of store?.uris() ?? []) {
		for (const diagnostic of store?.read(uri) ?? []) {
			if (options.filter !== 'all' && diagnostic.severity !== options.filter) continue;
			entries.push(toEntry(uri, diagnostic, options.readText));
		}
	}

	const sorted = [...entries].sort(comparatorFor(options.sort));
	const sections = groupIntoSections(sorted, options.rootPath ?? null);

	return {
		sections,
		entries: sorted,
		count: `${sorted.length} ${sorted.length === 1 ? 'finding' : 'findings'}`,
		empty: sorted.length === 0
	};
}

function comparatorFor(sort: DiagnosticsSort): (a: DiagnosticsViewEntry, b: DiagnosticsViewEntry) => number {
	if (sort === 'path') {
		return (a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.character - b.character;
	}
	return (a, b) =>
		SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
		a.path.localeCompare(b.path) ||
		a.line - b.line ||
		a.character - b.character;
}

/**
 * The findings of one file, in one section.
 *
 * The sections follow the order of the findings they hold, so the file with
 * the most serious finding comes first under the severity order, and the
 * files come in their own order under the path order.
 */
function groupIntoSections(
	entries: readonly DiagnosticsViewEntry[],
	rootPath: string | null
): DiagnosticsViewSection[] {
	const buckets = new Map<string, DiagnosticsViewEntry[]>();
	for (const entry of entries) {
		const bucket = buckets.get(entry.uri);
		if (bucket) bucket.push(entry);
		else buckets.set(entry.uri, [entry]);
	}

	const sections: DiagnosticsViewSection[] = [];
	for (const [uri, bucket] of buckets) {
		const first = bucket[0]!;
		sections.push({
			filepath: displayPath(first.path, rootPath),
			key: uri,
			path: first.path,
			entries: bucket,
			severity: bucket.reduce(
				(worst, entry) => (SEVERITY_RANK[entry.severity] < SEVERITY_RANK[worst] ? entry.severity : worst),
				first.severity
			)
		});
	}
	return sections;
}

/**
 * A path relative to the project root, when the file is under it.
 *
 * The root prefix is the same for every file in the project, so it says
 * nothing about which file is which; the path under it does.
 */
export function displayPath(path: string, rootPath: string | null): string {
	if (!rootPath) return path;
	const root = rootPath.replace(/\/+$/, '');
	if (path === root) return path;
	if (path.startsWith(root + '/')) return path.slice(root.length + 1);
	return path;
}

function toEntry(
	uri: string,
	diagnostic: LspDiagnostic,
	readText?: DiagnosticsTextReader
): DiagnosticsViewEntry {
	const path = fromFileUri(uri) ?? uri;
	return {
		uri,
		path,
		severity: diagnostic.severity,
		message: diagnostic.message,
		source: diagnostic.source,
		code: diagnostic.code,
		server: diagnostic.server,
		line: diagnostic.range.start.line,
		character: diagnostic.range.start.character,
		excerpt: excerptFor(diagnostic, readText?.(path))
	};
}

/**
 * The lines around a finding.
 *
 * Null when there are none: the file has no text in the workspace, or the
 * finding is about a line the text no longer has — a report computed against
 * an older revision of the file. Neither is worth dropping the finding over,
 * so the finding is shown and the surroundings are simply not there.
 */
function excerptFor(
	diagnostic: LspDiagnostic,
	text: string | undefined
): readonly DiagnosticsExcerptLine[] | null {
	if (text === undefined) return null;
	const lines = text.split(/\r?\n/);
	const start = diagnostic.range.start.line;
	const end = Math.max(start, diagnostic.range.end.line);
	if (start < 0 || start >= lines.length) return null;

	const from = Math.max(0, start - DIAGNOSTICS_CONTEXT_LINES);
	const to = Math.min(lines.length - 1, end + DIAGNOSTICS_CONTEXT_LINES);
	const excerpt: DiagnosticsExcerptLine[] = [];
	for (let index = from; index <= to; index++) {
		excerpt.push({
			number: index + 1,
			text: lines[index]!,
			flagged: index >= start && index <= end
		});
	}
	return excerpt;
}
