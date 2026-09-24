import type { DocumentSession } from '../document.svelte';

export const CORE_HOOKS_OWNER = 'core';

/**
 * Context passed to before-save hooks.
 * Context is mutable by reference if a hook needs to modify inputs (e.g. options).
 */
export interface BeforeSaveContext {
	document: DocumentSession;
	options?: { forceNewOrigin?: boolean; [key: string]: any };
}

/**
 * Result returned by a before-save hook.
 * Returning { cancel: true, reason: string } cancels the save with a user-visible reason.
 */
export interface BeforeSaveResult {
	cancel?: boolean;
	reason?: string;
}

/**
 * Hook function executed before a document save operation (ADR 0013).
 * Runs sequentially in plugin activation order and is always awaited.
 * Can cancel save by returning `{ cancel: true, reason: string }` or throwing `SaveCancelledError`.
 * If it throws any other error, the error is caught and logged, remaining hooks run, and save proceeds.
 */
export type BeforeSaveHook = (
	context: BeforeSaveContext
) => Promise<BeforeSaveResult | void> | BeforeSaveResult | void;

export interface BeforeSaveHookEntry {
	readonly pluginId: string;
	readonly hook: BeforeSaveHook;
}

/**
 * Context passed to after-save hooks.
 */
export interface AfterSaveContext {
	document: DocumentSession;
	options?: { forceNewOrigin?: boolean; [key: string]: any };
	success: boolean;
}

/**
 * Hook function executed after a document save operation finishes.
 * Runs in plugin activation order and is awaited.
 * Any error is caught and logged against the contributing plugin.
 */
export type AfterSaveHook = (context: AfterSaveContext) => Promise<void> | void;

export interface AfterSaveHookEntry {
	readonly pluginId: string;
	readonly hook: AfterSaveHook;
}

export interface ActiveHookContext {
	readonly pluginId: string;
	readonly operation: string;
	readonly phase: string;
}
