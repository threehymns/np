import {
	LSP_RESTART_ALL_SERVERS_COMMAND,
	LSP_RESTART_SERVER_COMMAND,
	LSP_STOP_ALL_SERVERS_COMMAND,
	LSP_STOP_SERVER_COMMAND,
	LSP_VIEW_LOGS_COMMAND,
	type LspServerState,
	type LspServerStatus,
	type LspStatusDetail
} from '@np/core';

/**
 * What the status menu decides, as data (spec #263, ticket #266, ADR 0015).
 *
 * None of this needs a component. It used to live inline in `LspStatusItem`, and
 * one piece of it was already drifting: the five command ids were typed as string
 * literals while `core`'s `commands` module exported the same five as constants,
 * so renaming a command there left the menu dispatching nothing — no type error,
 * no test failure, and a user finding out. The ids are imported here instead,
 * and `status-view.test.ts` holds this surface against the ids a real
 * `PluginHost` registered, which is the version of that comparison that survives
 * the rename.
 *
 * Plain module on purpose: no runes, so every decision below is asserted
 * headlessly (see `tests/runes-file-placement.test.ts`), and the component keeps
 * only what is genuinely a view concern — the subscription, the derived view
 * object, the markup.
 */

const STATE_LABELS: Record<LspServerState, string> = {
	running: 'running',
	starting: 'starting',
	stopped: 'stopped',
	failed: 'failed'
};

const STATE_DOTS: Record<LspServerState, string> = {
	running: 'bg-emerald-500',
	starting: 'bg-amber-500 animate-pulse',
	stopped: 'bg-muted-foreground/50',
	failed: 'bg-destructive'
};

/**
 * One entry in the menu. `id` is always a registered command id, so the menu
 * item and the palette entry are the same action rather than two that happen to
 * be worded alike.
 */
export interface LspStatusAction {
	readonly id: string;
	readonly label: string;
	readonly disabled: boolean;
	readonly destructive: boolean;
	/** The server key a per-server command takes; absent for whole-item actions. */
	readonly server?: string;
}

export interface LspStatusRowActions {
	readonly restart: LspStatusAction;
	readonly stop: LspStatusAction;
}

/** Everything one server's submenu needs, resolved rather than derived in markup. */
export interface LspStatusRowView {
	readonly server: string;
	/** Submenu tooltip: the server key, plus how it was started when it was. */
	readonly title: string;
	readonly descriptorId: string;
	readonly label: string;
	readonly dot: string;
	/** Empty until the version and memory follow-ups land, passed through as-is. */
	readonly details: readonly LspStatusDetail[];
	readonly actions: LspStatusRowActions;
}

export interface LspStatusItemActions {
	readonly restartAll: LspStatusAction;
	readonly stopAll: LspStatusAction;
	readonly viewLogs: LspStatusAction;
}

export interface LspStatusItemView {
	readonly running: number;
	readonly total: number;
	readonly indicator: string;
	readonly title: string;
	/** `running/total`, or null when there is no server to count. */
	readonly count: string | null;
	/** The menu shows its placeholder rather than rows. */
	readonly empty: boolean;
	readonly rows: readonly LspStatusRowView[];
	readonly actions: LspStatusItemActions;
}

export function lspStatusItemView(rows: readonly LspServerStatus[]): LspStatusItemView {
	const running = rows.filter((row) => row.state === 'running').length;
	const total = rows.length;
	return {
		running,
		total,
		indicator: indicatorFor(running, total),
		title:
			total === 0
				? 'Language servers: none running'
				: `Language servers: ${running} of ${total} running`,
		count: total === 0 ? null : `${running}/${total}`,
		empty: total === 0,
		rows: rows.map(rowView),
		actions: {
			restartAll: {
				id: LSP_RESTART_ALL_SERVERS_COMMAND,
				label: 'Restart All Servers',
				// Disabled rather than absent when there is nothing to act on, so
				// the bottom of the menu keeps its shape instead of three entries
				// appearing and vanishing as the first server starts.
				disabled: total === 0,
				destructive: false
			},
			stopAll: {
				id: LSP_STOP_ALL_SERVERS_COMMAND,
				label: 'Stop All Servers',
				disabled: total === 0,
				destructive: true
			},
			// Never disabled: a server that has already exited still left a buffer
			// behind, and that is exactly when the Logs tab is worth opening.
			viewLogs: {
				id: LSP_VIEW_LOGS_COMMAND,
				label: 'View Logs',
				disabled: false,
				destructive: false
			}
		}
	};
}

/**
 * One dot for the whole item, honest about what it summarises: grey while no
 * server has started, amber while none of them is running, green otherwise.
 */
function indicatorFor(running: number, total: number): string {
	if (running > 0) return 'bg-emerald-500';
	if (total > 0) return 'bg-amber-500';
	return 'bg-muted-foreground/40';
}

function rowView(row: LspServerStatus): LspStatusRowView {
	return {
		server: row.server,
		title: `${row.server}${row.marker ? ` (via ${row.marker})` : ''}`,
		descriptorId: row.descriptorId,
		label: STATE_LABELS[row.state],
		dot: STATE_DOTS[row.state],
		details: row.details,
		actions: {
			restart: {
				id: LSP_RESTART_SERVER_COMMAND,
				label: 'Restart this server',
				disabled: false,
				destructive: false,
				server: row.server
			},
			// A stopped server has nothing left to stop: offering the action makes
			// the menu look broken when it silently does nothing.
			stop: {
				id: LSP_STOP_SERVER_COMMAND,
				label: 'Stop this server',
				disabled: row.state === 'stopped',
				destructive: true,
				server: row.server
			}
		}
	};
}
