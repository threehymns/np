/**
 * Server status: what the status menu shows for one server (spec #263, ticket
 * #266).
 *
 * The type lives here rather than beside the runtime because both halves need
 * it — the runtime produces it and the menu reads it — and because there is
 * exactly one of it. An earlier shape had a "status" and a "status row" with
 * the same six fields, one built from the other by spread; the menu could then
 * hold either, and a caller that read the wrong one still compiled.
 *
 * The details slot is the deliberate part. Version and memory figures are named
 * follow-ups, and the way they arrive later has to be as data rather than as a
 * redesign of the status line, so the slot is shaped now and shipped empty: the
 * menu already has somewhere to put a figure, and the follow-up fills it in
 * without touching the component's structure.
 */

export type LspServerState = 'starting' | 'running' | 'stopped' | 'failed';

/** One extra line on a server's status row, such as a version or a memory figure. */
export interface LspStatusDetail {
	readonly label: string;
	readonly value: string;
}

export interface LspServerStatus {
	/** Running server, as `<descriptor id>@<root>`; identifies what and where. */
	readonly server: string;
	readonly descriptorId: string;
	readonly root: string;
	readonly marker: string | null;
	readonly state: LspServerState;
	readonly pid: number | undefined;
	/** Version and memory figures (ticket #282); empty once the server has no process left. */
	readonly details: readonly LspStatusDetail[];
}

/**
 * The read side of the runtime, which is all a status bar needs.
 *
 * Declared as an interface rather than a class import so the UI consumes the
 * contract — `getStatusRows`, `subscribe`, `revision` — and never the runtime's
 * own type. That is the same provider/consumer-by-key arrangement ADR 0008
 * describes for services, applied to an object the provider hands over.
 */
export interface LspServerStatusApi {
	/** One row per known server, in the order the runtime learned about them. */
	getStatusRows(): LspServerStatus[];
	/**
	 * Notified when the server set or any server's state changes, so a menu
	 * re-reads rather than polls. A plain callback, not a rune: the runtime is
	 * process code and stays usable without a Svelte compiler.
	 */
	subscribe(listener: () => void): () => void;
	/** Bumped on every status change, so a consumer can notice without subscribing. */
	readonly revision: number;
}
