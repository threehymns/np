import type { FileOrigin } from '../storage';
import type { TreeNode } from './tree.svelte';

/**
 * A checkout within a Project, holding a root path and the file entries
 * scanned beneath it.
 *
 * A Worktree is a filesystem checkout — one directory and the entries found
 * under it — not a repository (git state) and not a project root (the folder
 * a Project was opened on lives one level up). It does not scan or read on
 * its own: the existing scanner produces entries and the Worktree holds them,
 * so the leaf arrives exercised by the single root the product opens today
 * rather than sitting empty until a linked-worktree feature exists.
 *
 * Today a Project has exactly one Worktree — its root — so this type is
 * constructed from the same root the product already opens and the existing
 * single-root path continues to work unchanged.
 */
export class Worktree {
	root: FileOrigin;
	entries = $state<TreeNode[]>([]);

	constructor(root: FileOrigin, entries: TreeNode[] = []) {
		this.root = root;
		this.entries = entries;
	}
}
