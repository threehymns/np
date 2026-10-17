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
 *
 * Staging churn (`index`), commit message drafts (`COMMIT_EDITMSG`), tags,
 * remote tracking refs, and object store writes are deliberately ignored.
 */
export function isGitHistoryWatchedPath(eventPath: string, gitDir?: string): boolean {
	const normEvent = eventPath.replace(/\\/g, '/').replace(/\/+$/, '');
	let relPath = normEvent;

	if (gitDir) {
		const normGitDir = gitDir.replace(/\\/g, '/').replace(/\/+$/, '');
		if (normEvent.startsWith(normGitDir + '/')) {
			relPath = normEvent.slice(normGitDir.length + 1);
		}
	}

	if (relPath === 'HEAD') return true;
	if (relPath === 'packed-refs') return true;
	if (relPath === 'refs/heads' || relPath.startsWith('refs/heads/')) return true;
	return false;
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
 * watch the right directory. Filters events to `HEAD`, `refs/heads/*`, and `packed-refs`,
 * coalescing bursts through debouncing and invoking `onHistoryChange`.
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

		const resolvedGitDir = resolveGitDir(options.workingDir, res.stdout);
		if (!resolvedGitDir) {
			return null;
		}

		const debounceMs = options.debounceMs ?? 100;
		let debounceTimer: ReturnType<typeof setTimeout> | null = null;
		let closed = false;

		const handleEvents = (events: Array<{ path: string; type: 'create' | 'update' | 'delete' }>) => {
			if (closed) return;
			const matching = events.some((e) => isGitHistoryWatchedPath(e.path, resolvedGitDir));
			if (!matching) return;

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

		const sub = await watchDirectory(resolvedGitDir, handleEvents);

		return async () => {
			closed = true;
			if (debounceTimer) {
				clearTimeout(debounceTimer);
				debounceTimer = null;
			}
			if (typeof sub === 'function') {
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

		if (state.disposed || !state.isActive() || state.repository !== repo) {
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
