import { Repository } from '../../project/repository.svelte';
import { toURI, type FileOrigin } from '../../storage';
import type { WorkspaceLike } from '../services';

/**
 * Per-workspace repository ownership for the Git Core Plugin (#202).
 *
 * The plugin owns one state object per workspace, created in the setup
 * closure (never module globals, so concurrent hosts/tests stay isolated).
 * The state tracks the repository instance this plugin published, in-flight
 * operations, and future per-workspace disposables (file watchers land
 * here when added; none exist yet).
 */
export interface WorkspaceGitState {
	readonly workspace: WorkspaceLike;
	readonly ownerId: string;
	/** The repository instance this plugin published, if any. */
	repository: Repository | null;
	/** Set on disable: new operations stop, in-flight results are dropped. */
	disposed: boolean;
	/** In-flight lifecycle operations; cleanup awaits them (ADR 0009: active writes finish). */
	pending: Set<Promise<unknown>>;
	/** Per-workspace disposables (watchers); run on cleanup. */
	disposables: Array<() => void>;
	/** Token identifying the most recently initiated folder-open operation. */
	currentOpenId: number;
	isActive(): boolean;
}

export function createWorkspaceGitState(
	workspace: WorkspaceLike,
	isActive: () => boolean = () => true,
	ownerId = 'git'
): WorkspaceGitState {
	return {
		workspace,
		ownerId,
		repository: null,
		disposed: false,
		pending: new Set(),
		disposables: [],
		currentOpenId: 0,
		isActive
	};
}

/**
 * Tracks a lifecycle promise so disable-cleanup can await active
 * operations. Never rejects the tracker itself.
 */
function track<T>(state: WorkspaceGitState, promise: Promise<T>): Promise<T> {
	state.pending.add(promise);
	const tracked = promise.finally(() => {
		state.pending.delete(promise);
	});
	return tracked;
}

/**
 * Drops the published repository, but only when the workspace slot still
 * holds this plugin's instance (or nothing): never clobber a foreign
 * repository another owner published after us.
 */
export function disposePublishedRepository(state: WorkspaceGitState): void {
	const workspace = state.workspace;
	if (workspace.repository === null || workspace.repository === state.repository) {
		workspace.repository = null;
	}
	if (workspace.repositoryOwnerId === null || workspace.repositoryOwnerId === state.ownerId) {
		workspace.repositoryOwnerId = null;
	}
	state.repository = null;
}

/**
 * Folder-open lifecycle: detect + refresh for one workspace, previously
 * hardwired inline in Workspace.openDirectory / requestRootPermission /
 * restoreSession. The workspace clears its slot and awaits this through
 * the generic workspace-opened hook before scanning and restoring tabs,
 * preserving the old ordering exactly.
 *
 * A fresh Repository (fresh adapter via the workspace's generic
 * vcsFactory) is created per open, so the old adapter.reset() dance is
 * unnecessary: the stale adapter is discarded with the old Repository.
 * Detect errors no longer reach the folder-open caller: the host contains
 * per-hook failures (ADR 0013), logs them against this plugin, and folder
 * open proceeds with the slot in the safe empty state (null).
 */
export async function openFolderRepository(
	state: WorkspaceGitState,
	origin: FileOrigin
): Promise<void> {
	const openId = ++state.currentOpenId;
	disposePublishedRepository(state);
	if (state.disposed || !state.isActive()) return;

	const targetUri = toURI(origin);
	const repo = new Repository(origin, state.workspace.vcsFactory);
	const detected = await track(state, repo.adapter.detect(origin.path));

	if (
		state.disposed ||
		!state.isActive() ||
		state.currentOpenId !== openId ||
		!state.workspace.rootOrigin ||
		toURI(state.workspace.rootOrigin) !== targetUri
	) {
		return;
	}

	if (detected) {
		state.workspace.repository = repo;
		state.workspace.repositoryOwnerId = state.ownerId;
		state.repository = repo;
		await track(state, repo.refresh());

		if (
			state.disposed ||
			!state.isActive() ||
			state.currentOpenId !== openId ||
			!state.workspace.rootOrigin ||
			toURI(state.workspace.rootOrigin) !== targetUri
		) {
			if (state.workspace.repository === repo) {
				state.workspace.repository = null;
			}
			if (state.workspace.repositoryOwnerId === state.ownerId) {
				state.workspace.repositoryOwnerId = null;
			}
			if (state.repository === repo) {
				state.repository = null;
			}
			return;
		}
	}
}

/**
 * Repository initialization (`git init` flow), previously
 * Workspace.initializeRepository. Runs the adapter init, refreshes
 * metadata, and rescans the project tree, with the same stale-folder
 * guards: results are never published for an outdated folder.
 * Init errors propagate to the `git.init` caller, as before.
 */
export async function initializeWorkspaceRepository(state: WorkspaceGitState): Promise<boolean> {
	const workspace = state.workspace;
	if (!workspace.rootOrigin || !workspace.hasRootPermission) {
		return false;
	}

	const targetOrigin = workspace.rootOrigin;
	const targetUri = toURI(targetOrigin);

	// Ownership guard (ADR 0009: runtime resources are scoped to their
	// actual owner). Init takes ownership only when the slot is empty or
	// holds this plugin's own publication: a foreign repository published
	// by another contributor is never dropped. Aborting with an actionable
	// diagnostic keeps the failure AI-fixable instead of silently
	// clobbering state this plugin does not own.
	if (workspace.repository !== null && workspace.repository !== state.repository) {
		throw new Error(
			`Cannot initialize repository: the workspace slot holds a repository owned by another contributor, not the Git plugin.\n` +
				`Action: Remove or disable the owning contributor before running "Git: Initialize Repository", or publish through the Git plugin's folder-open lifecycle instead.`
		);
	}
	// Clear stale repository state before async initialization. At this
	// point the slot is empty or owned, so dropping it is safe (unlike a
	// foreign publication, which the guard above already rejected); the
	// staleness guards below still protect newer folders from stale
	// publication.
	workspace.repository = null;
	workspace.repositoryOwnerId = null;
	state.repository = null;
	if (state.disposed || !state.isActive()) return false;

	const repo = new Repository(targetOrigin, workspace.vcsFactory);
	const adapter = repo.adapter;

	if (!adapter.init || typeof adapter.init !== 'function') {
		throw new Error('VCS adapter does not support repository initialization');
	}

	await track(state, adapter.init(targetOrigin.path));

	// The folder may have switched while init was deferred; do not
	// publish results for an outdated folder. Likewise, never clobber a
	// foreign repository another contributor published while init was in
	// flight (ADR 0009): drop the stale result instead.
	if (state.disposed || !state.isActive() || !workspace.rootOrigin || toURI(workspace.rootOrigin) !== targetUri) {
		return false;
	}
	if (workspace.repository !== null && workspace.repository !== state.repository) {
		return false;
	}

	workspace.repository = repo;
	workspace.repositoryOwnerId = state.ownerId;
	state.repository = repo;
	const refreshed = await track(state, repo.refresh());
	if (!refreshed) {
		disposePublishedRepository(state);
		return false;
	}
	if (state.disposed || !state.isActive() || !workspace.rootOrigin || toURI(workspace.rootOrigin) !== targetUri) {
		disposePublishedRepository(state);
		return false;
	}
	try {
		await workspace.projectTree.scan(targetOrigin);
	} catch (e) {
		disposePublishedRepository(state);
		throw e;
	}
	if (state.disposed || !state.isActive() || !workspace.rootOrigin || toURI(workspace.rootOrigin) !== targetUri) {
		disposePublishedRepository(state);
		return false;
	}
	return true;
}

/**
 * Save-triggered refresh for one workspace: refreshes whatever repository
 * the slot currently holds (no identity requirement — a manually assigned
 * repository refreshes exactly as the old hardwired hook did).
 */
export async function refreshWorkspaceRepository(state: WorkspaceGitState): Promise<void> {
	if (state.disposed || !state.isActive()) return;
	const repo = state.workspace.repository;
	if (!repo) return;
	try {
		await track(state, repo.refresh());
	} catch (e) {
		console.error('Auto-refresh after save failed', e);
	}
}

/**
 * Disable-cleanup for one workspace (ADR 0009): stops new operations,
 * awaits active ones, runs per-workspace disposables, then drops the
 * published repository so the UI falls back to its "No Git Repository"
 * empty state instead of showing stale branch/changes.
 */
export async function disposeWorkspaceGitState(state: WorkspaceGitState): Promise<void> {
	state.disposed = true;

	const inFlight = [...state.pending];
	if (inFlight.length > 0) {
		await Promise.allSettled(inFlight);
	}

	for (const dispose of state.disposables.splice(0)) {
		try {
			dispose();
		} catch (e) {
			console.error('[GitPlugin] Error disposing workspace resource:', e);
		}
	}

	disposePublishedRepository(state);
}
