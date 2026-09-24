import type { DocumentSession } from '../document.svelte';
import type { FileOrigin } from '../storage';

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

/**
 * Context passed to workspace-opened hooks (#202, ADR 0013 extension).
 * The workspace passes itself opaquely: the host never names the
 * workspace type, and each consumer casts to the type it needs. The
 * origin is the folder the workspace just opened with permission granted.
 */
export interface WorkspaceOpenedContext {
	readonly origin: FileOrigin;
	readonly workspace: unknown;
}

/**
 * Hook function executed after a workspace opens a folder, awaited by the
 * workspace before it proceeds (tree scan, session restore). Lets feature
 * plugins own per-workspace resources (repository detection, watchers)
 * without hardwired core paths. Per ADR 0013 a throwing hook is contained,
 * logged against its plugin, and never an implicit veto: remaining hooks
 * still run and folder open proceeds. Hooks of inactive plugins are skipped.
 */
export type WorkspaceOpenedHook = (
	context: WorkspaceOpenedContext
) => Promise<void> | void;

export interface WorkspaceOpenedHookEntry {
	readonly pluginId: string;
	readonly hook: WorkspaceOpenedHook;
}
