import { Text } from "@codemirror/state";
import { Chunk } from "@codemirror/merge";
import {
	DocumentSession,
	diffOriginForFilepath,
	findBoundDocument,
	DEFAULT_DIFF_CONFIG,
	type FileOrigin,
	type GitChange,
	type Storage
} from "@np/core";

// Single implementation of the diff-filepath origin + bound-Document lookup
// lives in `@np/core` (`diff-binding`); re-exported here under the binding's
// historic names so existing seams keep working. The Git Hunk Actions choke
// point resolves through the same core lookup, so the pane and the commands
// agree — including after a Save As moves the Document's origin.
export { findBoundDocument } from "@np/core";

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
 *   so URI lookup reuses the already-open Document when present (see
 *   `diffOriginForFilepath` in `@np/core`);
 * - a filepath -> document-id map survives Save As origin changes (see
 *   `findBoundDocument` in `@np/core`; the map itself is workspace-owned so
 *   Hunk Actions resolve the same Document);
 * - deleted files never bind (their presentation stays read-only; file-edge
 *   semantics belong to #272).
 */

/** Build the workspace origin for a repo-relative diff filepath. */
export const originForDiffFilepath = diffOriginForFilepath;

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
 * Deleted files render the Original pane only (issue #272): there is no
 * working-copy surface to type into, so no binding and no b-pane.
 */
export function isOriginalOnly(status: GitChange["status"]): boolean {
	return status === "D";
}

/**
 * Whether two GitChange snapshots differ in any field the diff panes
 * render from. Compares by VALUE only: the viewer builds a fresh
 * `{...fileChange, ...}` object every render, so a reference check here
 * is always true and forces a hunk-widget reconfigure + MergeView
 * dispatch for every file on every keystroke (lag with many expanded
 * files). Missing fields (status/combined/filepath) would instead miss
 * real changes, so they are compared too.
 */
export function hasGitChangeChanged(prev: GitChange, next: GitChange): boolean {
	return (
		prev.filepath !== next.filepath ||
		prev.status !== next.status ||
		prev.staged !== next.staged ||
		prev.combined !== next.combined ||
		prev.stagedContent !== next.stagedContent ||
		prev.originalContent !== next.originalContent ||
		prev.modifiedContent !== next.modifiedContent ||
		prev.diff !== next.diff
	);
}

/**
 * Per-file memo for live hunk computation (issue: laggy typing with many
 * expanded files). `allHunks` re-evaluates on every keystroke; without a
 * memo each keystroke runs `Chunk.build` for EVERY expanded file. The
 * memo reuses cached chunks when both inputs are unchanged (reference-
 * or value-equal strings), so a keystroke recomputes only the edited
 * file. Keyed by the caller on filepath (one entry per visible file).
 */
export function createLiveHunkMemo() {
	const cache = new Map<string, { orig: string; mod: string; hunks: readonly Chunk[] }>();
	return {
		getOrCompute(filepath: string, originalContent: string, effectiveModified: string): readonly Chunk[] {
			const cached = cache.get(filepath);
			if (cached && cached.orig === originalContent && cached.mod === effectiveModified) {
				return cached.hunks;
			}
			const hunks = computeLiveHunks(originalContent, effectiveModified);
			cache.set(filepath, { orig: originalContent, mod: effectiveModified, hunks });
			return hunks;
		},
		prune(activeFilepaths: Set<string>) {
			for (const key of [...cache.keys()]) {
				if (!activeFilepaths.has(key)) cache.delete(key);
			}
		},
		size(): number {
			return cache.size;
		}
	};
}

/**
 * Display/navigation hunks of the base snapshot against live working-copy
 * text (issue #272). A version-control refresh replaces the snapshot's
 * original/staged sides while the bound Document keeps unsaved pane edits,
 * so hunks re-derive around Document content instead of going stale — and
 * typing above a hunk shifts the hunks below it. Unbound callers pass the
 * snapshot's modified content, which reduces to the stored diff.
 */
export function computeLiveHunks(
	originalContent: string,
	effectiveModifiedContent: string
): readonly Chunk[] {
	const origText = Text.of(originalContent.split(/\r?\n/));
	const modText = Text.of(effectiveModifiedContent.split(/\r?\n/));
	return Chunk.build(origText, modText, DEFAULT_DIFF_CONFIG);
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
 * tab or stealing focus. A clean bound Document reloads to new repository
 * content; dirty Documents keep their edits. Returns undefined when the
 * diff is not loaded yet, the file is deleted, or there is no workspace
 * root.
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
	if (existing) {
		existing.syncCleanSnapshot(snapshotModifiedContent);
		return existing;
	}
	if (!scope.rootOrigin) return undefined;
	const origin = originForDiffFilepath(scope.rootOrigin, change.filepath);
	const doc = new DocumentSession(scope.storage, snapshotModifiedContent, origin);
	doc.refreshPermissionState(scope.coversOrigin(origin));
	scope.documents.push(doc);
	boundDocIds.set(change.filepath, doc.id);
	return doc;
}
