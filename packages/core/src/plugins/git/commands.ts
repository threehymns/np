import { Text } from '@codemirror/state';
import { Chunk } from '@codemirror/merge';
import type { PluginCommand } from '../commands';
import type { DiffNavigatorLike } from '../services';
import { DEFAULT_DIFF_CONFIG, type GitChange, type VCSAdapter } from '../../project/vcs';
import { runExclusively } from '../../project/repository.svelte';
import { mapRange } from '../../commands.svelte';
import type { Workspace } from '../../workspace.svelte';
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
	getWorkspace(): Workspace | undefined;
	alert(message: string): Promise<void> | void;
	confirm(message: string): Promise<boolean> | boolean;
	getDiffNavigator(): DiffNavigatorLike | undefined;
}

/**
 * Repository lifecycle entry points the commands need beyond slot reads.
 * Provided by the plugin setup closed over its per-workspace states, so
 * initialization stays tracked for disable-cleanup (ADR 0009).
 */
export interface GitRepositoryLifecycle {
	initializeRepository(workspace: Workspace): Promise<boolean>;
}

export interface HunkRange {
	fromA: number;
	toA: number;
	fromB: number;
	toB: number;
}

/**
 * Single owner of the `getWorkspace()?.repository` + adapter-capability
 * guard: resolves the workspace repository only when it offers the named
 * optional adapter method, otherwise undefined so the caller degrades to
 * `false`/no-op (matching pre-plugin repository-less behavior). Hunk
 * actions keep their own throwing guards (they need per-action messages),
 * everything else goes through here.
 */
function requireRepositoryWithAdapter<M extends keyof VCSAdapter>(
	ctx: GitCommandContext,
	method: M
): NonNullable<Workspace['repository']> | undefined {
	const repo = ctx.getWorkspace()?.repository;
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
 * Index writes pass the index content as reference, worktree writes the
 * worktree content. Pairing them at one call site keeps that rule unmissable.
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
		op: (repo: NonNullable<Workspace['repository']>) => Promise<void>
	): Promise<boolean> {
		const repo = ctx.getWorkspace()?.repository;
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
			if (ws.repository) {
				ws.repository.setActiveDiffFileByPath(filepath);
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
 * Writes a discarded hunk's new worktree content; if that write fails,
 * restores the index to `stagedText` before rethrowing, so a half-applied
 * discard never leaves index and worktree describing different versions of
 * the file. Callers must have already verified both adapter methods exist.
 */
async function updateFileWithIndexRollback(
	repo: NonNullable<Workspace['repository']>,
	filepath: string,
	newWorktreeContent: string,
	stagedText: Text,
	stagedContent: string
): Promise<void> {
	try {
		await repo.adapter.updateFileContent!(filepath, newWorktreeContent);
	} catch (err) {
		try {
			await repo.adapter.updateIndexContent!(
				filepath,
				applyLineEndings(stagedText.toString(), stagedContent)
			);
		} catch (rollbackErr) {
			console.error('Failed to rollback index after worktree write failure:', rollbackErr);
		}
		throw err;
	}
}

export async function applyHunkAction(
	ctx: GitCommandContext,
	change: GitChange,
	hunk: HunkRange,
	action: 'stage' | 'unstage' | 'discard'
) {
	const repo = ctx.getWorkspace()?.repository;
	if (!repo) return;

	await runExclusively(repo, () => performHunkAction(ctx, repo, change, hunk, action));
}

async function performHunkAction(
	ctx: GitCommandContext,
	repo: NonNullable<Workspace['repository']>,
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

		const origText = Text.of(origContent.split(/\r?\n/));
		const modText = Text.of(modContent.split(/\r?\n/));
		const stagedText = Text.of(stagedContent.split(/\r?\n/));
		if (action === 'stage') {
			const indexRange = mapRange(hunk.fromA, hunk.toA, origText, stagedText);
			const newIndexContent = splicePreservingEndings(
				stagedText,
				indexRange.from,
				indexRange.to,
				modText.sliceString(hunk.fromB, hunk.toB),
				stagedContent
			);

			await repo.adapter.updateIndexContent!(change.filepath, newIndexContent);
		} else if (action === 'unstage') {
			const indexRange = mapRange(hunk.fromB, hunk.toB, modText, stagedText);
			const newIndexContent = splicePreservingEndings(
				stagedText,
				indexRange.from,
				indexRange.to,
				origText.sliceString(hunk.fromA, hunk.toA),
				stagedContent
			);

			await repo.adapter.updateIndexContent!(change.filepath, newIndexContent);
		} else if (action === 'discard') {
			const origHunkSlice = origText.sliceString(hunk.fromA, hunk.toA);

			if (change.staged && !change.combined) {
				// Staged-scope hunks live in HEAD-vs-index space (modText is the
				// index), so discarding must also revert the hunk's mirror image
				// in the worktree. Resolve the real worktree text first: writing
				// a splice of the index over the worktree would destroy
				// unrelated unstaged edits.
				if (!repo.adapter.updateIndexContent) {
					throw new Error('VCS adapter does not support updating index for hunk discard');
				}
				const wtDiff = await repo.getFileDiff(change.filepath, { staged: false });
				const wtContent = wtDiff?.modifiedContent;

				const indexRange = mapRange(hunk.fromB, hunk.toB, modText, stagedText);
				const newIndexContent = splicePreservingEndings(
					stagedText,
					indexRange.from,
					indexRange.to,
					origHunkSlice,
					stagedContent
				);

				if (typeof wtContent !== 'string') {
					// Worktree text unavailable: revert the index only. The
					// discarded hunk resurfaces as an unstaged change instead of
					// guessing at worktree bytes that were never read.
					await repo.adapter.updateIndexContent(change.filepath, newIndexContent);
				} else {
					const wtText = Text.of(wtContent.split(/\r?\n/));
					const unstagedChunks = Chunk.build(stagedText, wtText, DEFAULT_DIFF_CONFIG);
					const wtRange = mapRange(hunk.fromB, hunk.toB, stagedText, wtText);
					const wtStartLine = wtText.lineAt(Math.min(wtRange.from, wtText.length)).number;
					const wtEndLine = wtText.lineAt(Math.min(wtRange.to, wtText.length)).number;
					// Unstaged edits inside the hunk's region cannot be reverted
					// without destroying them; leave the worktree untouched so
					// they survive as an unstaged change.
					const overlapsUnstaged = unstagedChunks.some((uc: Chunk) => {
						const ucStartLine = wtText.lineAt(Math.min(uc.fromB, wtText.length)).number;
						const ucEndLine = wtText.lineAt(Math.min(uc.toB, wtText.length)).number;
						return wtStartLine <= ucEndLine && wtEndLine >= ucStartLine;
					});

					await repo.adapter.updateIndexContent(change.filepath, newIndexContent);

					if (!overlapsUnstaged) {
						const newWorktreeContent = splicePreservingEndings(
							wtText,
							wtRange.from,
							wtRange.to,
							origHunkSlice,
							wtContent
						);
						await updateFileWithIndexRollback(
							repo,
							change.filepath,
							newWorktreeContent,
							stagedText,
							stagedContent
						);
					}
				}
			} else {
				const unstagedChunks = Chunk.build(stagedText, modText, DEFAULT_DIFF_CONFIG);
				const lineStartB = modText.lineAt(Math.min(hunk.fromB, modText.length)).number;
				const lineEndB = modText.lineAt(Math.min(hunk.toB, modText.length)).number;
				const isUnstaged = unstagedChunks.some((uc: Chunk) => {
					const ucStartB = modText.lineAt(Math.min(uc.fromB, modText.length)).number;
					const ucEndB = modText.lineAt(Math.min(uc.toB, modText.length)).number;
					return lineStartB <= ucEndB && lineEndB >= ucStartB;
				});

				if (isUnstaged) {
					const indexRange = mapRange(hunk.fromA, hunk.toA, origText, stagedText);
					const newWorktreeContent = splicePreservingEndings(
						modText,
						hunk.fromB,
						hunk.toB,
						stagedText.sliceString(indexRange.from, indexRange.to),
						modContent
					);

					await repo.adapter.updateFileContent!(change.filepath, newWorktreeContent);
				} else {
					if (!repo.adapter.updateIndexContent) {
						throw new Error('VCS adapter does not support updating index for hunk discard');
					}
					const indexRange = mapRange(hunk.fromB, hunk.toB, modText, stagedText);
					const newIndexContent = splicePreservingEndings(
						stagedText,
						indexRange.from,
						indexRange.to,
						origHunkSlice,
						stagedContent
					);
					const newWorktreeContent = splicePreservingEndings(
						modText,
						hunk.fromB,
						hunk.toB,
						origHunkSlice,
						modContent
					);

					await repo.adapter.updateIndexContent(change.filepath, newIndexContent);
					if (repo.adapter.updateFileContent) {
						await updateFileWithIndexRollback(
							repo,
							change.filepath,
							newWorktreeContent,
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
