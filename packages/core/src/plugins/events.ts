/**
 * Event observation types (ADR 0013: Events observe, hooks participate).
 * Events record that something happened; subscribers cannot mutate the outcome,
 * veto it, or fail the operation, and the host need not await them in any particular order.
 */

export type EventHandler<T = unknown> = {
	bivarianceHack(payload: T): void | Promise<void>;
}['bivarianceHack'];

export interface EventHandlerEntry<T = unknown> {
	readonly pluginId: string;
	readonly handler: EventHandler<T>;
}
