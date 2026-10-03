import { DocumentSession } from "../../../core/src/document.svelte";
import { toURI, type FileOrigin, type Storage } from "../../../core/src/storage";
import type { GitChange } from "../../../core/src/project/vcs";

/**
 * Shared-Document binding for the split Diff Viewer Working-copy pane
 * (issue #269).
 *
 * The b-pane of the split MergeView edits the same DocumentSession an
 * Editor tab shows. These pure helpers own the binding rules so the
 * component stays thin and the rules are unit-testable without mounting
 * Svelte or CodeMirror:
 *
 * - origin construction mirrors `openFileInRegularTab` (root + filepath),
 *   so URI lookup reuses the already-open Document when present;
 * - a filepath -> document-id map survives Save As origin changes;
 * - deleted files never bind (their presentation stays read-only; file-edge
 *   semantics belong to #272).
 */

/** Build the workspace origin for a repo-relative diff filepath. */
export function originForDiffFilepath(root: FileOrigin, filepath: string): FileOrigin {
	return {
		scheme: root.scheme,
		path: root.path + "/" + filepath,
		name: filepath.split("/").pop() || filepath
	};
}

/**
 * Find the shared Document for a diff filepath: the explicitly bound id
 * first (survives Save As origin changes), then a URI match against open
 * documents. Stale id entries are pruned.
 */
export function findBoundDocument(
	documents: DocumentSession[],
	boundDocIds: Map<string, string>,
	root: FileOrigin | null,
	filepath: string
): DocumentSession | undefined {
	const boundId = boundDocIds.get(filepath);
	if (boundId) {
		const byId = documents.find((d) => d.id === boundId);
		if (byId) return byId;
		boundDocIds.delete(filepath);
	}
	if (!root) return undefined;
	const uri = toURI(originForDiffFilepath(root, filepath));
	return documents.find((d) => d.origin && toURI(d.origin) === uri);
}

/**
 * Whether the split Working-copy pane is editable: a shared Document is
 * bound and the file is not deleted. Deleted files offer the Original pane
 * only (file-edge semantics belong to #272).
 */
export function isSplitWorkingCopyEditable(
	status: GitChange["status"],
	boundDoc: DocumentSession | undefined
): boolean {
	if (status === "D") return false;
	return boundDoc !== undefined;
}

/**
 * B-pane content source: live Document content when bound (so tab
 * keystrokes appear in the pane and git snapshot refreshes cannot clobber
 * typing), otherwise the detached git snapshot string.
 */
export function resolveSplitRightContent(
	boundDoc: DocumentSession | undefined,
	snapshotModifiedContent: string | undefined
): string {
	if (boundDoc) return boundDoc.content;
	return snapshotModifiedContent ?? "";
}

/**
 * Diff file header dirty state. Reads the same `Document.isModified` as
 * the regular tab header, so both indicators always agree.
 */
export function isDiffHeaderDirty(boundDoc: DocumentSession | undefined): boolean {
	return boundDoc?.isModified ?? false;
}

export interface SplitDocumentScope {
	documents: DocumentSession[];
	storage: Storage;
	rootOrigin: FileOrigin | null;
	coversOrigin(origin: FileOrigin): boolean;
}

/**
 * Ensure a shared Document exists for the diff filepath, reusing the open
 * one when present. New Documents start from the git snapshot's
 * working-tree content (content == baseline, so clean), without opening a
 * tab or stealing focus. Returns undefined when the diff is not loaded yet,
 * the file is deleted, or there is no workspace root.
 */
export function ensureSplitDocument(
	scope: SplitDocumentScope,
	boundDocIds: Map<string, string>,
	change: GitChange,
	snapshotModifiedContent: string | undefined
): DocumentSession | undefined {
	if (change.status === "D") return undefined;
	if (snapshotModifiedContent === undefined) return undefined;
	const existing = findBoundDocument(scope.documents, boundDocIds, scope.rootOrigin, change.filepath);
	if (existing) return existing;
	if (!scope.rootOrigin) return undefined;
	const origin = originForDiffFilepath(scope.rootOrigin, change.filepath);
	const doc = new DocumentSession(scope.storage, snapshotModifiedContent, origin);
	doc.refreshPermissionState(scope.coversOrigin(origin));
	scope.documents.push(doc);
	boundDocIds.set(change.filepath, doc.id);
	return doc;
}
