import { Text } from '@codemirror/state';
import { Chunk } from '@codemirror/merge';
import type { PluginCommand } from '../commands';
import type { DiffNavigatorLike, WorkspaceLike } from '../services';
import { DEFAULT_DIFF_CONFIG, type GitChange, type VCSAdapter } from '../../project/vcs';
import { runExclusively } from '../../project/repository.svelte';
import { mapRange } from '../../commands.svelte';
import type { FileOrigin } from '../../storage';
import {
	diffOriginForFilepath,
	findBoundDocument,
	type BoundDocumentLike
} from '../../diff-binding';
import { manifest } from './manifest';

/**
 * Collaborators for Git command actions (#202).
 *
 * Plugin-local interface (NOT a host interface): Git-specific wiring is
 * allowed here. The setup builds it from generic host services
 * (workspace, dialogs, diff navigator), resolving lazily at action time
 * so activation order relative to app construction does not matter. A
 * missing workspace degrades to `false`/no-op, matching the pre-plugin
 * behavior of repository-less contexts.
 */
export interface GitCommandContext {
	getWorkspace(): WorkspaceLike | undefined;
	alert(message: string): Promise<void> | void;
	confirm(message: string): Promise<boolean> | boolean;
	getDiffNavigator(): DiffNavigatorLike | undefined;
	/**
	 * Current in-memory working-copy text for a filepath when a Document is
	 * bound to it (#273). Returns undefined when no Document covers the
	 * filepath. Lets Hunk Actions splice from what the user currently sees,
	 * including unsaved Working-copy pane edits, with no save-first gate.
	 */
	getWorkingCopyContent?(filepath: string): { content: string } | undefined;
	/**
	 * Apply an in-memory working-tree edit for a filepath: savable and
	 * undoable, never a direct disk write (#273). Returns true when a bound
	 * Document accepted the edit; false selects the disk-write fallback for
	 * headless contexts with no Document bound.
	 */
	applyWorkingTreeEdit?(filepath: string, content: string): boolean;
}

/**
 * Structural working-copy Document surface Hunk Actions need (#273). The
 * Workspace owns the real DocumentSessions; this layer only reads origin,
 * content, and dirty state through this shape so unit tests can use plain
 * fakes and the plugin never names the concrete Workspace type.
 */
export interface DirtyDocumentLike extends BoundDocumentLike {
	readonly origin: FileOrigin | null;
	readonly content: string;
	readonly isModified: boolean;
}

/**
 * Repository lifecycle entry points the commands need beyond slot reads.
 * Provided by the plugin setup closed over its per-workspace states, so
 * initialization stays tracked for disable-cleanup (ADR 0009).
 */
export interface GitRepositoryLifecycle {
	initializeRepository(workspace: WorkspaceLike): Promise<boolean>;
}

export interface HunkRange {
	fromA: number;
	toA: number;
	fromB: number;
	toB: number;
}

/** Workspace origin for a repo-relative filepath; single implementation lives in `diff-binding` (review de-dup). */
export function documentOriginForFilepath(root: FileOrigin, filepath: string): FileOrigin {
	return diffOriginForFilepath(root, filepath);
}

/**
 * Find the bound working-copy Document for a diff filepath. Delegates to
 * the shared `findBoundDocument` lookup so the Git choke point and the UI
 * binding agree, including after Save As: the caller threads the same
 * filepath->id map the Diff Viewer writes, so a Document whose origin moved
 * is still found by id instead of falling back to snapshot text.
 */
export function findDirtyDocument(
	documents: readonly DirtyDocumentLike[] | undefined,
	root: FileOrigin | null | undefined,
	filepath: string,
	boundDocIds?: Map<string, string>
): DirtyDocumentLike | undefined {
	return findBoundDocument(documents, boundDocIds, root, filepath);
}

/** Clamp a character offset into live text of `length`; shifted edits above a hunk move its range, never out of bounds. */
export function clampHunkPos(pos: number, length: number): number {
	if (pos < 0) return 0;
	return pos > length ? length : pos;
}

/**
 * Map a snapshot hunk's working-tree range through current Document text.
 * The widget fires with the chunk built from snapshot text, which goes stale
 * when edits above the hunk shift lines; mapping the B range through the
 * snapshot->current diff with end clamping lands the action on the intended
 * lines. The base (A) side never moves: the base snapshot is fixed while
 * only the working copy is edited.
 */
export function mapStaleHunkRange(
	hunk: HunkRange,
	snapshotModText: Text,
	currentModText: Text
): HunkRange {
	const mapped = mapRange(hunk.fromB, hunk.toB, snapshotModText, currentModText);
	return {
		fromA: hunk.fromA,
		toA: hunk.toA,
		fromB: clampHunkPos(mapped.from, currentModText.length),
		toB: clampHunkPos(mapped.to, currentModText.length)
	};
}

/**
 * Whether a working-tree range covers live change: any overlap with a live
 * chunk counts, and a collapsed (insertion-point) range matches the chunk
 * whose span holds it. A hunk whose range matches no live change is stale
 * (e.g. the user already reverted those lines by typing) and must no-op.
 */
export function liveHunkCoversRange(
	liveChunks: readonly Chunk[],
	fromB: number,
	toB: number
): boolean {
	return liveChunks.some((c) => {
		if (fromB < toB) return fromB < c.toB && toB > c.fromB;
		return c.fromB <= fromB && fromB <= c.toB;
	});
}

/**
 * Single owner of the `getWorkspace()?.project.repository` + adapter-capability
 * guard: resolves the project repository only when it offers the named
 * optional adapter method, otherwise undefined so the caller degrades to
 * `false`/no-op (matching pre-plugin repository-less behavior). Hunk
 * actions keep their own throwing guards (they need per-action messages),
 * everything else goes through here.
 */
function requireRepositoryWithAdapter<M extends keyof VCSAdapter>(
	ctx: GitCommandContext,
	method: M
): NonNullable<WorkspaceLike['project']['repository']> | undefined {
	const repo = ctx.getWorkspace()?.project.repository;
	if (!repo || !repo.adapter[method]) return undefined;
	return repo;
}

/**
 * Restores the reference content's CRLF line endings onto spliced output.
 * Text-based diff math normalizes to LF; without this, any hunk operation
 * on a CRLF file rewrites every line ending and dirties the whole file.
 */
function applyLineEndings(content: string, reference: string): string {
	if (!reference.includes('\r\n')) return content;
	return content.replace(/(?<!\r)\n/g, '\r\n');
}

/**
 * Splices [from, to] in the target Text document and restores the endings of
 * `reference`, the raw file content whose bytes the result will overwrite.
 * Index writes pass the index content as reference, working-tree writes the
 * working-tree content. Pairing them at one call site keeps that rule unmissable.
 */
function splicePreservingEndings(
	target: Text,
	from: number,
	to: number,
	replacement: string,
	reference: string
): string {
	return applyLineEndings(spliceText(target, from, to, replacement), reference);
}

/**
 * Replaces a character slice [from, to] in the target Text document with the replacement string.
 */
function spliceText(target: Text, from: number, to: number, replacement: string): string {
	return target.sliceString(0, from) + replacement + target.sliceString(to);
}

/**
 * Git command contributions, registered through the shared command registry
 * from the Git plugin's modules (ADR 0012, ADR 0015). Behavior matches the
 * previous core-registered commands exactly; only the collaborator source
 * changed (explicit context instead of AppState).
 */
export function createGitCommands(
	ctx: GitCommandContext,
	lifecycle: GitRepositoryLifecycle
): PluginCommand[] {
	const gitCommands: PluginCommand[] = [];

	gitCommands.push({
		id: 'git.init',
		label: 'Git: Initialize Repository',
		category: 'Source Control',
		action: async () => {
			try {
				const workspace = ctx.getWorkspace();
				if (!workspace) return false;
				return await lifecycle.initializeRepository(workspace);
			} catch (e) {
				console.error('Failed to initialize repository', e);
				await ctx.alert(`Failed to initialize repository: ${(e as Error).message}`);
				return false;
			}
		}
	});

	async function runGitOp(
		label: string,
		op: (repo: NonNullable<WorkspaceLike['project']['repository']>) => Promise<void>
	): Promise<boolean> {
		const repo = ctx.getWorkspace()?.project.repository;
		if (!repo) return false;
		try {
			return await runExclusively(repo, async () => {
				await op(repo);
				await repo.refresh();
				return true;
			});
		} catch (e) {
			console.error(`${label} failed:`, e);
			await ctx.alert(`${label} failed: ${(e as Error).message}`);
			return false;
		}
	}

	gitCommands.push({
		id: 'git.stage',
		label: 'Git: Stage File',
		category: 'Source Control',
		action: async (filepath: string) => {
			if (!filepath) return false;
			if (!requireRepositoryWithAdapter(ctx, 'stageFile')) return false;
			return await runGitOp(`Failed to stage file '${filepath}'`, async (r) => {
				await r.adapter.stageFile!(filepath);
			});
		}
	});

	gitCommands.push({
		id: 'git.unstage',
		label: 'Git: Unstage File',
		category: 'Source Control',
		action: async (filepath: string) => {
			if (!filepath) return false;
			if (!requireRepositoryWithAdapter(ctx, 'unstageFile')) return false;
			return await runGitOp(`Failed to unstage file '${filepath}'`, async (r) => {
				await r.adapter.unstageFile!(filepath);
			});
		}
	});

	gitCommands.push({
		id: 'git.discard',
		label: 'Git: Discard Changes',
		category: 'Source Control',
		action: async (filepath: string, options?: { staged?: boolean }, skipConfirm = false) => {
			if (!filepath) return false;
			if (!skipConfirm) {
				const confirmed = await ctx.confirm(
					`Are you sure you want to discard changes in '${filepath}'? This action cannot be undone.`
				);
				if (!confirmed) return false;
			}
			const repo = requireRepositoryWithAdapter(ctx, 'discardChanges');
			if (!repo) return false;
			return await runGitOp(`Failed to discard changes in '${filepath}'`, async (r) => {
				await r.adapter.discardChanges!(filepath, options);
			});
		}
	});

	gitCommands.push({
		id: 'git.commit',
		label: 'Git: Commit',
		category: 'Source Control',
		action: async (
			message: string,
			options?: { author?: { name: string; email: string }; amend?: boolean }
		) => {
			const repo = requireRepositoryWithAdapter(ctx, 'commit');
			if (!repo) return false;

			const stagedCount = repo.changes.filter((c) => c.staged).length;
			if (stagedCount === 0 && !options?.amend) {
				await ctx.alert('Cannot commit: No staged changes to commit.');
				return false;
			}

			return await runGitOp('Commit', async (r) => {
				await r.adapter.commit!(message, options);
			});
		}
	});

	gitCommands.push({
		id: 'git.createBranch',
		label: 'Git: Create Branch',
		category: 'Source Control',
		action: async (branchName: string) => {
			if (!branchName) return false;
			if (!requireRepositoryWithAdapter(ctx, 'createBranch')) return false;
			return await runGitOp(`Failed to create branch '${branchName}'`, async (r) => {
				await r.adapter.createBranch!(branchName);
			});
		}
	});

	gitCommands.push({
		id: 'git.stageAll',
		label: 'Git: Stage All Changes',
		category: 'Source Control',
		action: async () => {
			const repo = requireRepositoryWithAdapter(ctx, 'stageAll');
			if (!repo) return false;
			try {
				return await repo.stageAll();
			} catch (e) {
				console.error('Failed to stage all changes', e);
				await ctx.alert(`Failed to stage all changes: ${(e as Error).message}`);
				return false;
			}
		}
	});

	gitCommands.push({
		id: 'git.unstageAll',
		label: 'Git: Unstage All Changes',
		category: 'Source Control',
		action: async () => {
			const repo = requireRepositoryWithAdapter(ctx, 'unstageAll');
			if (!repo) return false;
			try {
				return await repo.unstageAll();
			} catch (e) {
				console.error('Failed to unstage all changes', e);
				await ctx.alert(`Failed to unstage all changes: ${(e as Error).message}`);
				return false;
			}
		}
	});

	gitCommands.push({
		id: 'git.discardAll',
		label: 'Git: Discard All Changes',
		category: 'Source Control',
		action: async () => {
			const confirmed = await ctx.confirm(
				'Are you sure you want to discard ALL uncommitted changes? This action cannot be undone.'
			);
			if (!confirmed) return false;

			const repo = requireRepositoryWithAdapter(ctx, 'discardAll');
			if (!repo) return false;
			try {
				return await repo.discardAll();
			} catch (e) {
				console.error('Failed to discard all changes', e);
				await ctx.alert(`Failed to discard all changes: ${(e as Error).message}`);
				return false;
			}
		}
	});

	gitCommands.push({
		id: 'git.openDiff',
		label: 'Git: Open Uncommitted Changes',
		category: 'Source Control',
		action: (filepath?: string) => {
			const ws = ctx.getWorkspace();
			if (!ws) return;
			const id = '__project_diff__';
			const existing = ws.tabs.find((t) => t.id === id);
			if (!existing) {
				ws.tabs.push({ id, type: 'diff', pluginId: manifest.id });
			}
			ws.activeTabId = id;
			if (ws.project.repository) {
				ws.project.repository.setActiveDiffFileByPath(filepath);
			}
		}
	});

	gitCommands.push({
		id: 'git.stageHunk',
		label: 'Git: Stage Hunk',
		category: 'Source Control',
		action: async (change: GitChange, hunk: HunkRange) => {
			await applyHunkAction(ctx, change, hunk, 'stage');
		}
	});

	gitCommands.push({
		id: 'git.unstageHunk',
		label: 'Git: Unstage Hunk',
		category: 'Source Control',
		action: async (change: GitChange, hunk: HunkRange) => {
			await applyHunkAction(ctx, change, hunk, 'unstage');
		}
	});

	gitCommands.push({
		id: 'git.discardHunk',
		label: 'Git: Discard Hunk',
		category: 'Source Control',
		action: async (change: GitChange, hunk: HunkRange) => {
			await applyHunkAction(ctx, change, hunk, 'discard');
		}
	});

	return gitCommands;
}

/**
 * Writes a discarded hunk's new working-tree content; if that write fails,
 * restores the index to `stagedText` before rethrowing, so a half-applied
 * discard never leaves index and working tree describing different versions of
 * the file. Callers must have already verified both adapter methods exist.
 */
async function updateFileWithIndexRollback(
	repo: NonNullable<WorkspaceLike['project']['repository']>,
	filepath: string,
	newWorkingTreeContent: string,
	stagedText: Text,
	stagedContent: string
): Promise<void> {
	try {
		await repo.adapter.updateFileContent!(filepath, newWorkingTreeContent);
	} catch (err) {
		try {
			await repo.adapter.updateIndexContent!(
				filepath,
				applyLineEndings(stagedText.toString(), stagedContent)
			);
		} catch (rollbackErr) {
			console.error('Failed to rollback index after working-tree write failure:', rollbackErr);
		}
		throw err;
	}
}

/**
 * Writes new index content optimistically; if the write fails, restores the
 * prior index content before rethrowing, so the index is never left
 * half-written (#273). The caller surfaces the failure through the shared
 * alert path in `performHunkAction`.
 */
async function updateIndexWithRollback(
	repo: NonNullable<WorkspaceLike['project']['repository']>,
	filepath: string,
	newIndexContent: string,
	stagedText: Text,
	stagedContent: string
): Promise<void> {
	try {
		await repo.adapter.updateIndexContent!(filepath, newIndexContent);
	} catch (err) {
		try {
			await repo.adapter.updateIndexContent!(
				filepath,
				applyLineEndings(stagedText.toString(), stagedContent)
			);
		} catch (rollbackErr) {
			console.error('Failed to rollback index after index write failure:', rollbackErr);
		}
		throw err;
	}
}

/**
 * Applies a hunk discard's new working-tree content as an in-memory edit on
 * the bound Document when one exists (savable and undoable, never a direct
 * disk write); otherwise falls back to the disk write with index rollback
 * for headless contexts with no Document bound (#273).
 */
async function writeWorkingTreeWithIndexRollback(
	ctx: GitCommandContext,
	repo: NonNullable<WorkspaceLike['project']['repository']>,
	filepath: string,
	newWorkingTreeContent: string,
	stagedText: Text,
	stagedContent: string
): Promise<void> {
	if (ctx.applyWorkingTreeEdit?.(filepath, newWorkingTreeContent)) return;
	await updateFileWithIndexRollback(repo, filepath, newWorkingTreeContent, stagedText, stagedContent);
}

export async function applyHunkAction(
	ctx: GitCommandContext,
	change: GitChange,
	hunk: HunkRange,
	action: 'stage' | 'unstage' | 'discard'
) {
	const repo = ctx.getWorkspace()?.project.repository;
	if (!repo) return;

	await runExclusively(repo, () => performHunkAction(ctx, repo, change, hunk, action));
}

async function performHunkAction(
	ctx: GitCommandContext,
	repo: NonNullable<WorkspaceLike['project']['repository']>,
	change: GitChange,
	hunk: HunkRange,
	action: 'stage' | 'unstage' | 'discard'
) {
	try {
		if (action === 'stage' || action === 'unstage') {
			if (!repo.adapter.updateIndexContent) {
				throw new Error(`VCS adapter does not support updating index for hunk ${action}`);
			}
		} else if (action === 'discard') {
			if (!repo.adapter.updateFileContent) {
				throw new Error('VCS adapter does not support updating file content for hunk discard');
			}
		}

		let origContent = change.originalContent;
		let modContent = change.modifiedContent;
		let stagedContent = change.stagedContent;

		if (typeof origContent !== 'string' || typeof modContent !== 'string') {
			const diff = await repo.getFileDiff(
				change.filepath,
				change.combined ? undefined : { staged: change.staged }
			);
			if (diff) {
				origContent = diff.originalContent;
				modContent = diff.modifiedContent;
				if (diff.stagedContent !== undefined) {
					stagedContent = diff.stagedContent;
				}
			}
		}

		if (typeof origContent !== 'string' || typeof modContent !== 'string') {
			throw new Error(`Cannot perform hunk ${action}: missing diff content for ${change.filepath}`);
		}

		if (stagedContent === undefined) {
			if (change.combined) {
				throw new Error(
					`Cannot perform hunk ${action}: combined change for ${change.filepath} is missing staged content`
				);
			}
			stagedContent = change.staged ? modContent : origContent;
		}

		// Dirty-hunk content-resolution choke point (#273): when the file's
		// Document carries unsaved Working-copy pane edits, the working-tree
		// side of the splice is current Document content with derived diff
		// state rebuilt from it — not the last stored snapshot. The
		// substitution happens here, before any chunk-build, range-map, or
		// splice runs, so nothing else in the diff plumbing, range-mapping
		// math, or storage providers needs changes. Typing never moves the
		// index: staged content still derives from the snapshot above.
		//
		// `modifiedContent` is the working tree except in staged scope
		// (staged && !combined), where it is the index; only the
		// working-tree side is ever substituted. A bound but unmodified
		// Document holds exactly the snapshot text, so the clean path below
		// is byte-identical to snapshot behavior.
		const modIsWorkingTree = !change.staged || change.combined === true;
		const workingCopy = modIsWorkingTree
			? ctx.getWorkingCopyContent?.(change.filepath)
			: undefined;
		const snapshotModContent = modContent;
		const dirtyActive =
			workingCopy !== undefined &&
			typeof workingCopy.content === 'string' &&
			workingCopy.content !== modContent;
		if (dirtyActive) {
			modContent = workingCopy.content;
		}

		const origText = Text.of(origContent.split(/\r?\n/));
		const snapshotModText = Text.of(snapshotModContent.split(/\r?\n/));
		const modText = dirtyActive ? Text.of(modContent.split(/\r?\n/)) : snapshotModText;
		const stagedText = Text.of(stagedContent.split(/\r?\n/));

		// Stale-range guard (#273): the widget fires with the chunk built
		// from snapshot text. Ranges from an older snapshot fail the
		// snapshot bounds check; ranges whose lines the user already
		// reverted by typing match no live change. Both no-op silently: no
		// writes, no alert, no refresh — stale controls never misapply.
		if (
			hunk.fromA < 0 ||
			hunk.toA < 0 ||
			hunk.fromB < 0 ||
			hunk.toB < 0 ||
			hunk.fromA > hunk.toA ||
			hunk.fromB > hunk.toB ||
			hunk.toA > origText.length ||
			hunk.toB > snapshotModText.length
		) {
			return;
		}
		// Shifted edits above the hunk map through current text with end
		// clamping; the clean path keeps the range verbatim.
		const effHunk = dirtyActive
			? mapStaleHunkRange(hunk, snapshotModText, modText)
			: hunk;
		const liveChunks = Chunk.build(origText, modText, DEFAULT_DIFF_CONFIG);
		if (!liveHunkCoversRange(liveChunks, effHunk.fromB, effHunk.toB)) {
			return;
		}

		if (action === 'stage') {
			const indexRange = mapRange(effHunk.fromA, effHunk.toA, origText, stagedText);
			const newIndexContent = splicePreservingEndings(
				stagedText,
				indexRange.from,
				indexRange.to,
				modText.sliceString(effHunk.fromB, effHunk.toB),
				stagedContent
			);

			await updateIndexWithRollback(repo, change.filepath, newIndexContent, stagedText, stagedContent);
		} else if (action === 'unstage') {
			const indexRange = mapRange(effHunk.fromB, effHunk.toB, modText, stagedText);
			const newIndexContent = splicePreservingEndings(
				stagedText,
				indexRange.from,
				indexRange.to,
				origText.sliceString(effHunk.fromA, effHunk.toA),
				stagedContent
			);

			await updateIndexWithRollback(repo, change.filepath, newIndexContent, stagedText, stagedContent);
		} else if (action === 'discard') {
			const origHunkSlice = origText.sliceString(effHunk.fromA, effHunk.toA);

			if (change.staged && !change.combined) {
				// Staged-scope hunks live in HEAD-vs-index space (modText is the
				// index), so discarding must also revert the hunk's mirror image
				// in the working tree. Resolve the real working-tree text first: writing
				// a splice of the index over the working tree would destroy
				// unrelated unstaged edits.
				if (!repo.adapter.updateIndexContent) {
					throw new Error('VCS adapter does not support updating index for hunk discard');
				}
				const wtDiff = await repo.getFileDiff(change.filepath, { staged: false });
				// The working-tree side of a staged-scope discard is live
				// Document content when pane edits exist (#273); the fetched
				// snapshot would otherwise clobber unsaved typing with stale
				// bytes.
				let wtContent = wtDiff?.modifiedContent;
				const wtWorkingCopy = ctx.getWorkingCopyContent?.(change.filepath);
				if (
					typeof wtContent === 'string' &&
					wtWorkingCopy !== undefined &&
					typeof wtWorkingCopy.content === 'string' &&
					wtWorkingCopy.content !== wtContent
				) {
					wtContent = wtWorkingCopy.content;
				}

				const indexRange = mapRange(effHunk.fromB, effHunk.toB, modText, stagedText);
				const newIndexContent = splicePreservingEndings(
					stagedText,
					indexRange.from,
					indexRange.to,
					origHunkSlice,
					stagedContent
				);

				if (typeof wtContent !== 'string') {
					// Working-tree text unavailable: revert the index only. The
					// discarded hunk resurfaces as an unstaged change instead of
					// guessing at working-tree bytes that were never read.
					await updateIndexWithRollback(repo, change.filepath, newIndexContent, stagedText, stagedContent);
				} else {
					const wtText = Text.of(wtContent.split(/\r?\n/));
					const unstagedChunks = Chunk.build(stagedText, wtText, DEFAULT_DIFF_CONFIG);
					const wtRange = mapRange(effHunk.fromB, effHunk.toB, stagedText, wtText);
					const wtStartLine = wtText.lineAt(Math.min(wtRange.from, wtText.length)).number;
					const wtEndLine = wtText.lineAt(Math.min(wtRange.to, wtText.length)).number;
					// Unstaged edits inside the hunk's region cannot be reverted
					// without destroying them; leave the working tree untouched so
					// they survive as an unstaged change.
					const overlapsUnstaged = unstagedChunks.some((uc: Chunk) => {
						const ucStartLine = wtText.lineAt(Math.min(uc.fromB, wtText.length)).number;
						const ucEndLine = wtText.lineAt(Math.min(uc.toB, wtText.length)).number;
						return wtStartLine <= ucEndLine && wtEndLine >= ucStartLine;
					});

					await updateIndexWithRollback(repo, change.filepath, newIndexContent, stagedText, stagedContent);

					if (!overlapsUnstaged) {
						const newWorkingTreeContent = splicePreservingEndings(
							wtText,
							wtRange.from,
							wtRange.to,
							origHunkSlice,
							wtContent
						);
						await writeWorkingTreeWithIndexRollback(
							ctx,
							repo,
							change.filepath,
							newWorkingTreeContent,
							stagedText,
							stagedContent
						);
					}
				}
			} else {
				const unstagedChunks = Chunk.build(stagedText, modText, DEFAULT_DIFF_CONFIG);
				const lineStartB = modText.lineAt(Math.min(effHunk.fromB, modText.length)).number;
				const lineEndB = modText.lineAt(Math.min(effHunk.toB, modText.length)).number;
				const isUnstaged = unstagedChunks.some((uc: Chunk) => {
					const ucStartB = modText.lineAt(Math.min(uc.fromB, modText.length)).number;
					const ucEndB = modText.lineAt(Math.min(uc.toB, modText.length)).number;
					return lineStartB <= ucEndB && lineEndB >= ucStartB;
				});

				if (isUnstaged) {
					const indexRange = mapRange(effHunk.fromA, effHunk.toA, origText, stagedText);
					const newWorkingTreeContent = splicePreservingEndings(
						modText,
						effHunk.fromB,
						effHunk.toB,
						stagedText.sliceString(indexRange.from, indexRange.to),
						modContent
					);

					// Unstaged discards touch no index state; with a bound
					// Document the revert lands as an in-memory edit,
					// otherwise it writes through as before.
					if (!ctx.applyWorkingTreeEdit?.(change.filepath, newWorkingTreeContent)) {
						await repo.adapter.updateFileContent!(change.filepath, newWorkingTreeContent);
					}
				} else {
					if (!repo.adapter.updateIndexContent) {
						throw new Error('VCS adapter does not support updating index for hunk discard');
					}
					const indexRange = mapRange(effHunk.fromB, effHunk.toB, modText, stagedText);
					const newIndexContent = splicePreservingEndings(
						stagedText,
						indexRange.from,
						indexRange.to,
						origHunkSlice,
						stagedContent
					);
					const newWorkingTreeContent = splicePreservingEndings(
						modText,
						effHunk.fromB,
						effHunk.toB,
						origHunkSlice,
						modContent
					);

					await updateIndexWithRollback(repo, change.filepath, newIndexContent, stagedText, stagedContent);
					if (repo.adapter.updateFileContent) {
						await writeWorkingTreeWithIndexRollback(
							ctx,
							repo,
							change.filepath,
							newWorkingTreeContent,
							stagedText,
							stagedContent
						);
					}
				}
			}
		}
		await repo.refresh();
	} catch (e) {
		console.error(`Failed to ${action} hunk:`, e);
		await ctx.alert(`Failed to ${action} hunk in '${change.filepath}': ${(e as Error).message}`);
	}
}
