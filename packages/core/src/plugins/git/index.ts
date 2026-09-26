import type { PluginCleanup, PluginHostInterface } from '../types';
import {
	WORKSPACE_SERVICE_KEY,
	DIALOGS_SERVICE_KEY,
	DIFF_NAVIGATOR_SERVICE_KEY,
	type DiffNavigatorProvider,
	type WorkspaceLike
} from '../services';
import { createPilotComponent } from '../ui-contributions';
import type { DialogService } from '../../state.svelte';
import { toURI } from '../../storage';
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
import { createGitEditorContributions } from './gutter';
import {
	GIT_PANEL_ID,
	GIT_PANEL_TITLE,
	GIT_PANEL_ORDER,
	GIT_STATUS_ID,
	GIT_STATUS_ORDER,
	getGitUIComponents
} from './ui';

/**
 * Setup entrypoint for the Git Core Plugin.
 *
 * Owns repository lifecycle per workspace (detection, refresh,
 * initialization) through generic host interfaces only: the
 * workspace-opened hook for folder open, the after-save hook for
 * save-triggered refresh, the shared command registry for Git commands,
 * and generic services for collaborators. No host interface mentions Git.
 *
 * Presentation is purely contributory (#203): the sidebar panel and status
 * entries register through `host.registerSidebarPanel` /
 * `host.registerStatusBarItem`, and gutter decorations through
 * `host.registerEditorContribution`, composed by the host with unchanged
 * precedence. Real Svelte components arrive via the generic UI-components
 * service provided by the UI bridge (`@np/ui`); headless hosts (Bun tests)
 * fall back to pilot components so the wiring is verified without importing
 * `.svelte` files into `@np/core`.
 *
 * Per-workspace states live in this setup closure (never module globals),
 * so concurrent hosts and tests stay isolated. Returns a cleanup that
 * stops new operations, awaits active ones, and drops published
 * repositories (ADR 0009). Command/hook/event/UI/editor removal is handled
 * by the host itself on deactivate/unregister — verified by tests, not
 * reimplemented here.
 */
export async function setup(host: PluginHostInterface): Promise<PluginCleanup> {
	const states = new Map<WorkspaceLike, WorkspaceGitState>();

	const stateFor = (workspace: WorkspaceLike): WorkspaceGitState => {
		let state = states.get(workspace);
		if (!state) {
			state = createWorkspaceGitState(
				workspace,
				() => host.getPluginState(manifest.id) === 'activating' || host.isPluginActive(manifest.id)
			);
			states.set(workspace, state);
		}
		return state;
	};

	const getWorkspace = (): WorkspaceLike | undefined =>
		host.getService<WorkspaceLike>(WORKSPACE_SERVICE_KEY);
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

	host.registerEditorContributions(manifest.id, createGitEditorContributions());

	const uiComponents = getGitUIComponents(host);
	if (uiComponents) {
		host.registerSidebarPanel(manifest.id, {
			id: GIT_PANEL_ID,
			title: GIT_PANEL_TITLE,
			order: GIT_PANEL_ORDER,
			icon: uiComponents.panelIcon,
			component: uiComponents.panelComponent
		});
		host.registerStatusBarItem(manifest.id, {
			id: GIT_STATUS_ID,
			alignment: 'left',
			order: GIT_STATUS_ORDER,
			component: uiComponents.statusComponent
		});
		if (uiComponents.diffComponent) {
			host.registerTabContent(manifest.id, {
				id: manifest.id,
				title: 'Uncommitted Changes',
				icon: uiComponents.diffIcon,
				component: uiComponents.diffComponent
			});
		}
	} else {
		host.registerSidebarPanel(manifest.id, {
			id: GIT_PANEL_ID,
			title: GIT_PANEL_TITLE,
			order: GIT_PANEL_ORDER,
			component: createPilotComponent('git-panel')
		});
		host.registerStatusBarItem(manifest.id, {
			id: GIT_STATUS_ID,
			alignment: 'left',
			order: GIT_STATUS_ORDER,
			component: createPilotComponent('git-status')
		});
	}

	host.registerAfterSaveHook(manifest.id, async (context) => {
		if (!context.success) return;
		// Refresh every workspace this plugin knows about, plus the
		// currently published one (which may hold a repository assigned
		// outside the folder-open lifecycle, e.g. in tests).
		const candidates = new Set<WorkspaceLike>(states.keys());
		const current = getWorkspace();
		if (current) candidates.add(current);
		for (const workspace of candidates) {
			await refreshWorkspaceRepository(stateFor(workspace));
		}
	});

	const removeWorkspaceOpenedHook = host.registerWorkspaceOpenedHook(
		manifest.id,
		async (context) => {
			// A throw here (e.g. detect failure) is contained by the host
			// (ADR 0013): logged against this plugin with remaining hooks
			// still running, folder open proceeding with an empty slot.
			await openFolderRepository(stateFor(context.workspace as WorkspaceLike), context.origin);
		}
	);

	const current = getWorkspace();
	if (current?.rootOrigin && current.hasRootPermission) {
		await openFolderRepository(stateFor(current), current.rootOrigin);
	}

	return async () => {
		removeWorkspaceOpenedHook();
		const workspaces = new Set(states.keys());
		const current = getWorkspace();
		if (current) workspaces.add(current);
		for (const workspace of workspaces) {
			const state = states.get(workspace);
			if (state) await disposeWorkspaceGitState(state);
			for (const tab of workspace.tabs.filter(
				(tab) => tab.type === 'diff' && tab.pluginId === manifest.id
			)) {
				workspace.closeTab(tab.id);
			}
			// Persist the closed diff tabs under the folder this plugin owns. A
			// workspace with no root folder has nothing of Git's to close, and
			// the unscoped (folder-less) session bucket is not Git's to rewrite,
			// so no empty URI is handed to the workspace.
			if (workspace.rootOrigin) {
				await workspace.saveFolderState(toURI(workspace.rootOrigin));
			}
		}
		states.clear();
	};
}

export { manifest };
export default { manifest, setup };
