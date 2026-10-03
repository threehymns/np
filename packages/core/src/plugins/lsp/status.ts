import type { LspServerState, LspServerStatus } from './lifecycle';

/**
 * What the status menu shows for one server (spec #263, ticket #266).
 *
 * The details slot is the deliberate part. Version and memory figures are named
 * follow-ups, and the way they arrive later has to be as data rather than as a
 * redesign of the status line, so the slot is shaped now and shipped empty: the
 * menu already has somewhere to put a figure, and the follow-up fills it in
 * without touching the component's structure.
 */
export interface LspStatusDetail {
	readonly label: string;
	readonly value: string;
}

export interface LspServerStatusRow {
	readonly server: string;
	readonly descriptorId: string;
	readonly root: string;
	readonly marker: string | null;
	readonly state: LspServerState;
	readonly pid: number | undefined;
	/** Empty until the version and memory follow-ups land. */
	readonly details: readonly LspStatusDetail[];
}

export function toServerStatusRows(servers: readonly LspServerStatus[]): LspServerStatusRow[] {
	return servers.map((server) => ({ ...server, details: [] }));
}