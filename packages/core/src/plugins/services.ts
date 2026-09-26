/**
 * Well-known generic host service keys (#202, ADR 0008).
 *
 * The plugin host is a neutral meeting point: the app publishes opaque
 * services and plugins consume them by key with their own types. Keys and
 * value shapes are conventions owned by provider/consumer pairs, never by
 * the host, so no feature-specific methods accumulate on the host
 * interface. A second contributor (e.g. an exporter plugin) reuses the
 * same keys with no host change.
 *
 * - `workspace`: published by the Workspace itself on construction (and on
 *   setPluginHost). Lets feature plugins own per-workspace resources
 *   without the host naming any feature.
 * - `dialogs`: published by the app composer (AppState). Generic
 *   alert/confirm capability; consumers fall back to no-op/false when
 *   absent, matching the pre-plugin behavior of dialog-less contexts.
 * - `diffNavigator`: published by the app composer (AppState). Provider for
 *   the currently mounted diff view's hunk navigator, if any.
 */

import type { FileOrigin } from '../storage';
import type { VCSAdapter } from '../project/vcs';
import type { Repository } from '../project/repository.svelte';

export interface WorkspaceLike {
	readonly rootOrigin: FileOrigin | null;
	readonly hasRootPermission: boolean;
	repository: Repository | null;
	/**
	 * Owning contributor for the published repository slot (generic, no
	 * feature names). Set alongside `repository` by whichever contributor
	 * publishes it; the workspace exposes repository state only while the
	 * owner is active, so a slot left behind by a bounded-cleanup timeout
	 * stays inert in the UI.
	 */
	repositoryOwnerId: string | null;
	tabs: Array<{
		id: string;
		type: 'document' | 'diff';
		pluginId?: string;
	}>;
	activeTabId: string;
	readonly vcsFactory: (rootOrigin: FileOrigin) => VCSAdapter;
	readonly projectTree: {
		scan(origin: FileOrigin): Promise<void>;
	};
	closeTab(id: string): void;
	saveFolderState(folderUri: string): Promise<void>;
}

export const WORKSPACE_SERVICE_KEY = 'workspace';
export const DIALOGS_SERVICE_KEY = 'dialogs';
export const DIFF_NAVIGATOR_SERVICE_KEY = 'diffNavigator';
export const PLUGIN_UI_LOADER_SERVICE_KEY = 'plugin-ui-loader';

export interface PluginUILoader {
	load(pluginId: string): Promise<void>;
}

/**
 * Minimal hunk-navigation surface published by the mounted diff view.
 * Structural match for the app-level navigator type; defined here so
 * plugins can consume it without importing app modules.
 */
export interface DiffNavigatorLike {
	nextHunk(): void;
	prevHunk(): void;
}

/**
 * Provider for the currently mounted diff view's navigator, if any.
 * The app composer publishes one instance; plugins resolve it lazily so
 * activation order (before/after app construction) does not matter.
 */
export interface DiffNavigatorProvider {
	getCurrentNavigator(): DiffNavigatorLike | undefined;
}
