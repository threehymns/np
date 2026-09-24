import type { PluginCleanup, PluginHostInterface } from '../types';
import {
	WORKSPACE_SERVICE_KEY,
	DIALOGS_SERVICE_KEY,
	DIFF_NAVIGATOR_SERVICE_KEY,
	type DiffNavigatorProvider
} from '../services';
import type { DialogService } from '../../state.svelte';
import type { Workspace } from '../../workspace.svelte';
import { manifest } from './manifest';
import { createGitCommands, type GitCommandContext } from './commands';
import {
	createWorkspaceGitState,
	openFolderRepository,
	initializeWorkspaceRepository,
	refreshWorkspaceRepository,
	disposeWorkspaceGitState,
	type WorkspaceGitState
} from './lifecycle';

/**
 * Setup entrypoint for the Git Core Plugin.
 *
 * Owns repository lifecycle per workspace (detection, refresh,
 * initialization) through generic host interfaces only: the
 * workspace-opened hook for folder open, the after-save hook for
 * save-triggered refresh, the shared command registry for Git commands,
 * and generic services for collaborators. No host interface mentions Git.
 *
 * Per-workspace states live in this setup closure (never module globals),
 * so concurrent hosts and tests stay isolated. Returns a cleanup that
 * stops new operations, awaits active ones, and drops published
 * repositories (ADR 0009). Command/hook/event removal is handled by the
 * host itself on deactivate/unregister.
 */
export function setup(host: PluginHostInterface): PluginCleanup {
	const states = new Map<Workspace, WorkspaceGitState>();

	const stateFor = (workspace: Workspace): WorkspaceGitState => {
		let state = states.get(workspace);
		if (!state) {
			state = createWorkspaceGitState(workspace);
			states.set(workspace, state);
		}
		return state;
	};

	const getWorkspace = (): Workspace | undefined =>
		host.getService<Workspace>(WORKSPACE_SERVICE_KEY);
	const getDialogs = () => host.getService<DialogService>(DIALOGS_SERVICE_KEY);

	// Collaborators resolve lazily at action time, so activation order
	// relative to app construction does not matter. Missing services
	// degrade to no-op/false, matching dialog-less pre-plugin behavior.
	const ctx: GitCommandContext = {
		getWorkspace,
		alert: (message) => getDialogs()?.alert?.(message),
		confirm: (message) => getDialogs()?.confirm?.(message) ?? false,
		getDiffNavigator: () =>
			host.getService<DiffNavigatorProvider>(DIFF_NAVIGATOR_SERVICE_KEY)?.getCurrentNavigator()
	};

	host.registerCommands(
		manifest.id,
		createGitCommands(ctx, {
			initializeRepository: (workspace) => initializeWorkspaceRepository(stateFor(workspace))
		})
	);

	host.registerAfterSaveHook(manifest.id, async (context) => {
		if (!context.success) return;
		// Refresh every workspace this plugin knows about, plus the
		// currently published one (which may hold a repository assigned
		// outside the folder-open lifecycle, e.g. in tests).
		const candidates = new Set<Workspace>(states.keys());
		const current = getWorkspace();
		if (current) candidates.add(current);
		for (const workspace of candidates) {
			await refreshWorkspaceRepository(stateFor(workspace));
		}
	});

	const removeWorkspaceOpenedHook = host.registerWorkspaceOpenedHook(
		manifest.id,
		async (context) => {
			await openFolderRepository(stateFor(context.workspace as Workspace), context.origin);
		}
	);

	return async () => {
		removeWorkspaceOpenedHook();
		for (const state of states.values()) {
			await disposeWorkspaceGitState(state);
		}
		states.clear();
	};
}

export { manifest };
export default { manifest, setup };
