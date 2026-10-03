import type { FileOrigin, Storage } from '../storage';
import type { SessionPersistence } from '../persistence';
import type { VCSAdapter } from './vcs';
import { Worktree } from './worktree.svelte';
import type { Repository } from './repository.svelte';

/**
 * The shared backing store behind one Workspace: its search scope, its
 * repositories and git state, and its settings. One Project per Workspace —
 * switching Workspaces switches Projects.
 *
 * Project owns everything about the opened folder: its Worktrees, its
 * Repository, its root-permission flag, and the storage and VCS seams those
 * need. Workspace holds exactly one Project and retains only window state
 * (open documents, tabs, active tab, pending close).
 *
 * Opening a folder replaces the current one, exactly as before: the caller
 * drops the previous folder's repository before the asynchronous VCS probe
 * so the UI never shows stale branch or change state for a folder that is
 * going away. Making opening additive (held-project list, active-project
 * notion, pinning, recency, per-project persistence) is separate work.
 *
 * Today the Project holds exactly one Worktree — the single root the product
 * opens — so the level is exercised by real code rather than introduced
 * empty. Nothing creates a second Worktree yet.
 */
export class Project {
	worktrees = $state<Worktree[]>([]);
	repository = $state<Repository | null>(null);
	repositoryOwnerId = $state<string | null>(null);
	hasRootPermission = $state(false);

	storage: Storage;
	vcsFactory: (rootOrigin: FileOrigin) => VCSAdapter;
	persistence: SessionPersistence;

	constructor(
		storage: Storage,
		vcsFactory: (rootOrigin: FileOrigin) => VCSAdapter,
		persistence: SessionPersistence
	) {
		this.storage = storage;
		this.vcsFactory = vcsFactory;
		this.persistence = persistence;
	}

	get rootOrigin(): FileOrigin | null {
		return this.worktrees[0]?.root ?? null;
	}

	set rootOrigin(origin: FileOrigin | null) {
		if (!origin) {
			this.worktrees = [];
			return;
		}
		const current = this.worktrees[0];
		if (current && current.root.scheme === origin.scheme && current.root.path === origin.path) {
			return;
		}
		this.worktrees = [new Worktree(origin)];
	}

	get worktree(): Worktree | null {
		return this.worktrees[0] ?? null;
	}
}
