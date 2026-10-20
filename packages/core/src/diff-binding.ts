import { toURI, type FileOrigin } from './storage';

/**
 * Minimal structural surface the shared diff-Document lookup needs (#269,
 * #273). Both the UI Working-copy binding and the Git Hunk Actions choke
 * point read through this shape, so unit tests can use plain fakes and
 * neither layer names the concrete Workspace or DocumentSession types.
 */
export interface BoundDocumentLike {
	/** Stable id surviving Save-As origin changes; absent in headless fakes. */
	readonly id?: string;
	readonly origin: FileOrigin | null;
}

/**
 * Single owner of the workspace-origin construction for a repo-relative
 * diff filepath (#269, review de-dup of `originForDiffFilepath` vs
 * `documentOriginForFilepath`). Mirrors `openFileInRegularTab` (root +
 * filepath), so URI lookup reuses the already-open Document instead of
 * creating a second truth.
 */
export function diffOriginForFilepath(root: FileOrigin, filepath: string): FileOrigin {
	return {
		scheme: root.scheme,
		path: root.path + '/' + filepath,
		name: filepath.split('/').pop() || filepath
	};
}

/**
 * Single owner of the shared-Document lookup for a diff filepath (review
 * de-dup of UI `findBoundDocument` vs Git `findDirtyDocument`).
 *
 * The explicitly bound id wins (it survives Save-As origin changes: the
 * pane stays bound to the same Document even though its URI moved), then a
 * URI match against open documents. Stale id entries are pruned so a closed
 * Document never shadows a reopened one. Returns undefined when there is no
 * workspace root or no Document covers the filepath (deleted files stay
 * Original-only, headless contexts stay on the snapshot path).
 */
export function findBoundDocument<T extends BoundDocumentLike>(
	documents: readonly T[] | undefined,
	boundDocIds: Map<string, string> | undefined,
	root: FileOrigin | null | undefined,
	filepath: string
): T | undefined {
	if (!documents) return undefined;
	const boundIds = boundDocIds;
	const boundId = boundIds?.get(filepath);
	if (boundIds && boundId) {
		const byId = documents.find((d) => d.id === boundId);
		if (byId) return byId;
		boundIds.delete(filepath);
	}
	if (!root) return undefined;
	const uri = toURI(diffOriginForFilepath(root, filepath));
	return documents.find((d) => d.origin && toURI(d.origin) === uri);
}
