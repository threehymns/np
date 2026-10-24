/**
 * Git directory watcher for History tab refresh (ADR 0027).
 *
 * Subscribes to `.git/refs/heads`, `.git/HEAD`, and `.git/packed-refs` through
 * the shared `@parcel/watcher` desktop backend, debounced, refetching history
 * commits on change. Commits made in the terminal appear with no polling.
 */

import type { FileOrigin } from '../../storage';
import type { Repository } from '../../project/repository.svelte';
import type { WorkspaceGitState } from './lifecycle';

/**
 * Checks whether a watcher event path corresponds to one of the git refs or
 * metadata files that indicate a history change:
 * - `HEAD` (or `.git/HEAD`)
 * - `packed-refs` (or `.git/packed-refs`)
 * - `refs/heads` / `refs/heads/*` (or `.git/refs/heads/*`)
 * - `refs/remotes/*` (or `.git/refs/remotes/*`)
 *
 * Push and fetch only move remote-tracking refs, so those are watched too —
 * otherwise the unpushed indicator would stay stale after a terminal push.
 * A tag created in the terminal writes only `refs/tags/<name>`, and the
 * History tab shows a tag chip on the tagged commit, so loose tag refs are
 * watched for the same reason.
 * Staging churn (`index`), commit message drafts (`COMMIT_EDITMSG`), and
 * object store writes are deliberately ignored.
 */
function toRelativePath(eventPath: string, dir?: string): string {
	const normEvent = eventPath.replace(/\\/g, '/').replace(/\/+$/, '');
	if (!dir) return normEvent;
	const normDir = dir.replace(/\\/g, '/').replace(/\/+$/, '');
	if (normEvent.startsWith(normDir + '/')) {
		return normEvent.slice(normDir.length + 1);
	}
	return normEvent;
}

/** Worktree-private history signal: the symbolic HEAD. */
function isWorktreeHistoryPath(relPath: string): boolean {
	return relPath === 'HEAD';
}

/** Shared-ref history signals: branch refs, packed refs, remote-tracking refs, tags. */
function isSharedRefHistoryPath(relPath: string): boolean {
	return (
		relPath === 'packed-refs' ||
		relPath === 'refs/heads' ||
		relPath.startsWith('refs/heads/') ||
		relPath.startsWith('refs/remotes/') ||
		relPath.startsWith('refs/tags/')
	);
}

export function isGitHistoryWatchedPath(eventPath: string, gitDir?: string): boolean {
	const relPath = toRelativePath(eventPath, gitDir);
	return isWorktreeHistoryPath(relPath) || isSharedRefHistoryPath(relPath);
}

function isAbsolutePath(p: string): boolean {
	return p.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(p) || p.startsWith('\\\\');
}

function normalizePath(p: string): string {
	const isWindowsDrive = /^[a-zA-Z]:/.test(p);
	const prefix = isWindowsDrive ? p.slice(0, 2) : '';
	const remainder = isWindowsDrive ? p.slice(2) : p;
	const slashNorm = remainder.replace(/\\/g, '/');
	const isRooted = slashNorm.startsWith('/');

	const segments = slashNorm.split('/');
	const stack: string[] = [];
	for (const seg of segments) {
		if (seg === '' || seg === '.') continue;
		if (seg === '..') {
			if (stack.length > 0 && stack[stack.length - 1] !== '..') {
				stack.pop();
			} else if (!isRooted) {
				stack.push('..');
			}
		} else {
			stack.push(seg);
		}
	}

	const joined = (isRooted ? '/' : '') + stack.join('/');
	return (prefix + joined) || (isRooted ? '/' : '.');
}

/**
 * Resolves the real git directory from `git rev-parse --git-dir` output.
 * In a linked worktree, `.git` is a pointer file and git outputs the real
 * directory (often absolute or relative to the worktree).
 */
export function resolveGitDir(workingDir: string, rawGitDir: string): string | null {
	const trimmed = rawGitDir.trim();
	if (!trimmed) return null;

	if (isAbsolutePath(trimmed)) {
		return normalizePath(trimmed);
	}

	const normalizedWorkingDir = workingDir.replace(/\\/g, '/').replace(/\/+$/, '');
	return normalizePath(`${normalizedWorkingDir}/${trimmed}`);
}

export interface GitWatchClient {
	gitRun?: (workingDir: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
	watchDirectory?: (
		dirPath: string,
		callback: (events: Array<{ path: string; type: 'create' | 'update' | 'delete' }>) => void
	) => Promise<(() => Promise<void>) | (() => void)> | (() => Promise<void>) | (() => void);
	debounceMs?: number;
}

export interface StartGitWatcherOptions extends GitWatchClient {
	workingDir: string;
	onHistoryChange: () => Promise<unknown> | unknown;
}

/**
 * Starts watching the git directory for commits, branch switches, and ref updates.
 *
 * Resolves the real git dir via `git rev-parse --git-dir` so linked worktrees
 * watch the right directory, and additionally resolves `--git-common-dir`:
 * in a linked worktree the branch refs live in the common dir, not the
 * per-worktree dir, so both are subscribed when they differ. Filters events
 * to `HEAD`, `refs/heads/*`, `packed-refs`, `refs/remotes/*`, and
 * `refs/tags/*`, coalescing bursts through debouncing and invoking
 * `onHistoryChange`.
 *
 * Guarded for desktop only: on web (where `window.electronAPI` is absent) this is
 * a safe no-op that returns null.
 */
export async function startGitWatcher(options: StartGitWatcherOptions): Promise<(() => Promise<void>) | null> {
	const gitRun =
		options.gitRun ??
		(typeof window !== 'undefined' && (window as any).electronAPI?.gitRun
			? (w: string, a: string[]) => (window as any).electronAPI.gitRun(w, a)
			: undefined);

	const watchDirectory =
		options.watchDirectory ??
		(typeof window !== 'undefined' && (window as any).electronAPI?.watchDirectory
			? (d: string, cb: any) => (window as any).electronAPI.watchDirectory(d, cb)
			: undefined);

	if (!gitRun || !watchDirectory) {
		return null;
	}

	try {
		const res = await gitRun(options.workingDir, ['rev-parse', '--git-dir']);
		if (res.code !== 0 || !res.stdout.trim()) {
			return null;
		}

		const gitDir = resolveGitDir(options.workingDir, res.stdout);
		if (!gitDir) {
			return null;
		}

		// In a linked worktree, --git-dir points at the per-worktree directory
		// (<main>/.git/worktrees/<name>), which holds HEAD but not the branch
		// refs — those live in the common dir. Subscribe to both when they
		// differ; otherwise a terminal commit in a linked worktree is missed.
		let commonDir: string | null = null;
		try {
			const commonRes = await gitRun(options.workingDir, ['rev-parse', '--git-common-dir']);
			if (commonRes.code === 0 && commonRes.stdout.trim()) {
				const resolved = resolveGitDir(options.workingDir, commonRes.stdout);
				if (resolved && resolved !== gitDir) {
					commonDir = resolved;
				}
			}
		} catch {
			// Fall through to watching the git dir alone.
		}

		const targets: Array<{ dir: string; matches: (relPath: string) => boolean }> = commonDir
			? [
					{ dir: gitDir, matches: isWorktreeHistoryPath },
					{ dir: commonDir, matches: isSharedRefHistoryPath }
				]
			: [{ dir: gitDir, matches: (rel) => isWorktreeHistoryPath(rel) || isSharedRefHistoryPath(rel) }];

		const debounceMs = options.debounceMs ?? 100;
		let debounceTimer: ReturnType<typeof setTimeout> | null = null;
		let closed = false;

		const triggerRefresh = () => {
			if (closed) return;
			if (debounceTimer) {
				clearTimeout(debounceTimer);
			}

			debounceTimer = setTimeout(async () => {
				debounceTimer = null;
				if (closed) return;
				try {
					await options.onHistoryChange();
				} catch (e) {
					console.error('[GitWatcher] Error during history refresh on change:', e);
				}
			}, debounceMs);
		};

		const subs: Array<() => unknown> = [];
		try {
			for (const target of targets) {
				const sub = await watchDirectory(target.dir, (events) => {
					if (closed) return;
					const matching = events.some((e) => target.matches(toRelativePath(e.path, target.dir)));
					if (!matching) return;
					triggerRefresh();
				});
				if (typeof sub === 'function') {
					subs.push(sub);
				}
			}
		} catch (e) {
			// A later target failed after earlier ones subscribed: close the
			// ones already started so the native watcher doesn't leak.
			for (const sub of subs) {
				try {
					await sub();
				} catch {
					// Best effort; the original error is logged by the outer catch.
				}
			}
			throw e;
		}

		return async () => {
			closed = true;
			if (debounceTimer) {
				clearTimeout(debounceTimer);
				debounceTimer = null;
			}
			for (const sub of subs) {
				try {
					await sub();
				} catch (e) {
					console.error('[GitWatcher] Error closing watcher:', e);
				}
			}
		};
	} catch (e) {
		console.error('[GitWatcher] Failed to start git watcher:', e);
		return null;
	}
}

/**
 * Stops any active git directory watcher attached to the workspace state.
 */
export function stopWorkspaceGitWatcher(state: WorkspaceGitState): void {
	// Invalidate any watcher start that is still awaiting installation: the
	// stale start will stop and discard its own subscription instead of
	// overwriting state.watcherStop.
	state.watcherGeneration = (state.watcherGeneration ?? 0) + 1;
	if (state.watcherStop) {
		const stop = state.watcherStop;
		state.watcherStop = null;
		const idx = state.disposables.indexOf(stop as () => void);
		if (idx !== -1) {
			state.disposables.splice(idx, 1);
		}
		try {
			const res = stop();
			if (res && typeof (res as any).then === 'function') {
				(res as Promise<void>).catch((e) => {
					console.error('[GitPlugin] Error stopping git watcher:', e);
				});
			}
		} catch (e) {
			console.error('[GitPlugin] Error stopping git watcher:', e);
		}
	}
}

/**
 * Starts watching the git directory for the given workspace repository.
 *
 * Stops any previous watcher on the state, resolves the real git directory,
 * filters events to history refs/HEAD, and triggers `repo.refreshHistory()` on change.
 */
export async function startWorkspaceGitWatcher(
	state: WorkspaceGitState,
	origin: FileOrigin,
	repo: Repository,
	clientOptions?: GitWatchClient
): Promise<void> {
	stopWorkspaceGitWatcher(state);
	const watcherGeneration = state.watcherGeneration;
	if (state.disposed || !state.isActive() || origin.scheme !== 'file') return;

	try {
		const stop = await startGitWatcher({
			workingDir: origin.path,
			onHistoryChange: () => {
				if (state.disposed || !state.isActive() || state.repository !== repo) return;
				return repo.refreshHistory();
			},
			...clientOptions
		});

		if (
			state.disposed ||
			!state.isActive() ||
			state.repository !== repo ||
			state.watcherGeneration !== watcherGeneration
		) {
			if (stop) await stop();
			return;
		}

		if (stop) {
			state.watcherStop = stop;
			state.disposables.push(stop);
		}
	} catch (e) {
		console.error('[GitPlugin] Failed to start repository git watcher:', e);
	}
}
