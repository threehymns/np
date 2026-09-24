/**
 * Event observation types (ADR 0013: Events observe, hooks participate).
 * Events record that something happened; subscribers cannot mutate the outcome,
 * veto it, or fail the operation, and the host need not await them in any particular order.
 */

export type EventHandler<T = any> = (payload: T) => void | Promise<void>;

export interface EventHandlerEntry<T = any> {
	readonly pluginId?: string;
	readonly handler: EventHandler<T>;
}
