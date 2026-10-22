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
 *
 * An action that cannot do anything is absent rather than disabled. A disabled
 * entry holds its place in the menu and says nothing about why; an absent one is
 * honest, and a menu where a press visibly does nothing is the failure this
 * avoids.
 */
export interface LspStatusAction {
	readonly id: string;
	readonly label: string;
	readonly visible: boolean;
	readonly destructive: boolean;
	/** The server key a per-server command takes; absent for whole-item actions. */
	readonly server?: string;
}

export interface LspStatusRowActions {
	readonly restart: LspStatusAction;
	readonly viewLogs: LspStatusAction;
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
	/**
	 * The state spelled out beside the name, for any server that is not running —
	 * null while it is. A row is a dot of colour and a name otherwise, which is
	 * enough for the one state a reader expects and nothing for the three they
	 * have to notice; the tooltip carries the word for anyone who asks, but a
	 * stopped server sitting in a list of running ones is the case that needs
	 * saying without being asked.
	 */
	readonly stateNote: string | null;
	/** Version and memory figures, passed through as-is. */
	readonly details: readonly LspStatusDetail[];
	readonly actions: LspStatusRowActions;
}

export interface LspStatusItemActions {
	readonly restartAll: LspStatusAction;
	readonly stopAll: LspStatusAction;
}

export interface LspStatusItemView {
	readonly running: number;
	readonly total: number;
	/**
	 * The dot's colour, and the only thing the button itself says: the trigger is
	 * an icon with a dot on it, so the counts live in `title` — the tooltip, and
	 * the accessible name the trigger reads it from.
	 */
	readonly indicator: string;
	readonly title: string;
	/** The menu shows its placeholder rather than rows. */
	readonly empty: boolean;
	readonly rows: readonly LspStatusRowView[];
	/**
	 * Whether the menu shows any whole-item entry. One field rather than the
	 * markup asking about each, because the separator above them belongs to the
	 * group: a separator left alone at the bottom of the menu separates nothing.
	 */
	readonly bulkVisible: boolean;
	readonly actions: LspStatusItemActions;
}

export function lspStatusItemView(rows: readonly LspServerStatus[]): LspStatusItemView {
	const running = rows.filter((row) => row.state === 'running').length;
	const failed = rows.filter((row) => row.state === 'failed').length;
	const total = rows.length;
	const bulkVisible = total > 0;
	return {
		running,
		total,
		indicator: indicatorFor(running, failed, total),
		title:
			total === 0
				? 'Language servers: none running'
				: `Language servers: ${running} of ${total} running${failed > 0 ? `, ${failed} failed` : ''}`,
		empty: total === 0,
		rows: rows.map(rowView),
		bulkVisible,
		actions: {
			restartAll: {
				id: LSP_RESTART_ALL_SERVERS_COMMAND,
				label: 'Restart All Servers',
				// Absent before the first server starts, like Stop All and for the
				// same reason: an entry with nothing to act on is a button that
				// visibly does nothing. Both then appear together, as the first
				// server starts.
				visible: bulkVisible,
				destructive: false
			},
			stopAll: {
				id: LSP_STOP_ALL_SERVERS_COMMAND,
				label: 'Stop All Servers',
				// Absent once every server is gone: the runtime stops an entry by
				// returning early when it has no process left, so an entry still
				// sitting there would claim to stop something and visibly do nothing.
				visible: rows.some((row) => canStop(row.state)),
				destructive: true
			}
		}
	};
}

/**
 * Whether a server in this state may still have a process to stop. A failed
 * server has already killed its own — the runtime disposes the client and kills
 * the process before it reports the failure — so it is as gone as one the user
 * stopped, which is why `failed` is not named here.
 */
function canStop(state: LspServerState): boolean {
	return state === 'running' || state === 'starting';
}

/**
 * One dot for the whole item, honest about what it summarises: red once a
 * server has failed, because a failure the status bar cannot show is a failure
 * only the menu knows about; grey while no server has started, amber while none
 * of them is running, green otherwise.
 */
function indicatorFor(running: number, failed: number, total: number): string {
	if (failed > 0) return 'bg-destructive';
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
		// Nothing to add while the server is running: that is the state a reader
		// expects to find, and a word beside every running server would only make
		// the words beside the others harder to see.
		stateNote: row.state === 'running' ? null : STATE_LABELS[row.state],
		details: row.details,
		actions: {
			restart: {
				id: LSP_RESTART_SERVER_COMMAND,
				label: 'Restart this server',
				visible: true,
				destructive: false,
				server: row.server
			},
			// Always offered: a server that has already exited still left a buffer
			// behind, and that is exactly when its logs are worth reading — the
			// runtime logs a failed start before it reports the row, so there is no
			// row here whose buffer is empty.
			viewLogs: {
				id: LSP_VIEW_LOGS_COMMAND,
				label: 'View Logs',
				visible: true,
				destructive: false,
				server: row.server
			},
			// Absent for a server with no process left, on the same reasoning as
			// Stop All: the runtime returns early, so the entry would look broken
			// when it silently does nothing.
			stop: {
				id: LSP_STOP_SERVER_COMMAND,
				label: 'Stop this server',
				visible: canStop(row.state),
				destructive: true,
				server: row.server
			}
		}
	};
}
