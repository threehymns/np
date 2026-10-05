import type {
	LspLogEntry,
	LspLogFilter,
	LspLogKind,
	LspLogLevel,
	LspLogStore,
	LspLogsFocus
} from '@np/core';

/**
 * What the Logs tab decides, as data (spec #263, ticket #266, ADR 0019).
 *
 * The tab's only decisions are which lines a set of picker selections selects,
 * what the picker calls each server, and what the counter says. All three are
 * pure functions of a store and three strings, so they are asserted here
 * instead of through a rendered tab — the tab itself is markup over this, plus
 * the subscription that turns a pipe write into reactive state.
 *
 * Plain module on purpose: no runes (see `tests/runes-file-placement.test.ts`),
 * and the store is taken as its read side so a test can drive a real one.
 */

/** The slice of the store the tab reads, so the view is drivable without a plugin. */
export type LspLogsReader = Pick<
	LspLogStore,
	'read' | 'servers' | 'droppedCount' | 'focused'
>;

export interface LspLogServerOption {
	/** The full `<descriptor id>@<root>` key, which is what the filter compares. */
	readonly value: string;
	readonly label: string;
}

export interface LspLogsView {
	readonly entries: readonly LspLogEntry[];
	readonly serverOptions: readonly LspLogServerOption[];
	/** `1 line` / `12 lines`, counting both feeds together. */
	readonly lineCount: string;
	/** `3 dropped`, or null when the buffer has discarded nothing. */
	readonly droppedNote: string | null;
	readonly empty: boolean;
}

/**
 * The three picker selections as one store filter.
 *
 * Each picker binds its "All ..." entry to the empty string, and a key the
 * filter omits is what the store reads as "everything", so a blank selection
 * cannot narrow the buffer.
 */
export function lspLogFilter(server: string, kind: string, level: string): LspLogFilter {
	return {
		...(server ? { server } : {}),
		...(kind ? { kind: kind as LspLogKind } : {}),
		...(level ? { level: level as LspLogLevel } : {})
	};
}

/**
 * A server key as the root alone: two roots of one descriptor are the same
 * server to a reader, and the picker has room for the root but not for the pair.
 * A key with nothing after the separator is shown whole.
 */
export function shortServer(server: string): string {
	// The separator is the FIRST '@': a descriptor id never carries one, while a
	// project root can (`packages/@scope/app`), and splitting on the last would
	// collapse two scoped roots onto the same label — which is the one thing
	// this picker has to keep apart.
	const at = server.indexOf('@');
	return at === -1 ? server : server.slice(at + 1);
}

/** What the tab does with a narrowing request: the picker value, and the request it has acted on. */
export interface LspLogsFocusDecision {
	readonly filter: string;
	readonly adopted: number;
}

/**
 * The server picker after a narrowing request.
 *
 * Only a request newer than the one the tab last acted on moves the picker, for
 * two reasons that point the same way. A protocol trace writes a line per
 * keystroke, so acting on the store's focus whenever it is read would undo the
 * reader's own selection the moment they made it; and a request is counted
 * rather than compared, so asking twice for the server the tab is already
 * narrowed to still lands. A request naming no server is the palette's way of
 * asking for every server, so it clears the picker rather than leaving it.
 */
export function applyLogsFocus(
	current: string,
	focus: LspLogsFocus | undefined,
	adopted: number
): LspLogsFocusDecision {
	if (!focus || focus.request <= adopted) return { filter: current, adopted };
	return { filter: focus.server ?? '', adopted: focus.request };
}

/**
 * The tab over one store. An absent store is the ordinary case of a plugin that
 * is not active: the tab still renders, empty, rather than failing inside a
 * plugin-owned view.
 */
export function lspLogsView(logs: LspLogsReader | undefined, filter: LspLogFilter): LspLogsView {
	const entries = logs?.read(filter) ?? [];
	const dropped = logs?.droppedCount ?? 0;
	return {
		entries,
		serverOptions: (logs?.servers() ?? []).map((server) => ({
			value: server,
			label: shortServer(server)
		})),
		lineCount: `${entries.length} ${entries.length === 1 ? 'line' : 'lines'}`,
		droppedNote: dropped > 0 ? `${dropped} dropped` : null,
		empty: entries.length === 0
	};
}
