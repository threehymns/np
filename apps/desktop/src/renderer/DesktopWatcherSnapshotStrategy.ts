import type { Worktree, WorktreeSnapshotStrategy } from '@np/core';
import type { WatcherEvent } from './electron';

export type DirectoryWatcherClient = (
	dirPath: string,
	onChange: (events: WatcherEvent[]) => void
) => Promise<(() => Promise<void>) | (() => void)> | (() => Promise<void>) | (() => void);

export interface DesktopWatcherSnapshotStrategyOptions {
	watcherClient?: DirectoryWatcherClient;
	debounceMs?: number;
}

export class DesktopWatcherSnapshotStrategy implements WorktreeSnapshotStrategy {
	readonly name = 'desktop-watcher';
	private worktree: Worktree | null = null;
	private stopWatcher: (() => Promise<void> | void) | null = null;
	private startPromise: Promise<void> | null = null;
	private watcherClient: DirectoryWatcherClient;
	private debounceMs: number;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private pendingEvents: WatcherEvent[] = [];
	private isScanning = false;
	private needsRescan = false;
	private closed = false;

	constructor(options: DesktopWatcherSnapshotStrategyOptions = {}) {
		this.watcherClient =
			options.watcherClient ??
			((dirPath, onChange) => {
				if (typeof window !== 'undefined' && window.electronAPI?.watchDirectory) {
					return window.electronAPI.watchDirectory(dirPath, onChange);
				}
				return () => {};
			});
		this.debounceMs = options.debounceMs ?? 50;
	}

	start(worktree: Worktree): void | Promise<void> {
		this.worktree = worktree;
		this.closed = false;

		if (worktree.root.scheme !== 'file') return;
		const dirPath = worktree.root.path;
		if (!dirPath) return;

		try {
			const res = this.watcherClient(dirPath, (events) => {
				this.handleEvents(events);
			});

			if (typeof res === 'function') {
				this.stopWatcher = res;
			} else if (res && typeof (res as any).then === 'function') {
				this.startPromise = Promise.resolve(res).then((stop) => {
					if (this.closed) {
						if (typeof stop === 'function') {
							stop();
						}
					} else {
						this.stopWatcher = stop;
					}
				}).catch((e) => {
					console.error('[DesktopWatcherSnapshotStrategy] Failed to start watcher client:', e);
				});
				return this.startPromise;
			}
		} catch (e) {
			console.error('[DesktopWatcherSnapshotStrategy] Failed to start watcher client:', e);
		}
	}

	handleEvents(events: WatcherEvent[]): void {
		if (this.closed || !this.worktree) return;
		this.pendingEvents.push(...events);

		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}

		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			this.flushChanges();
		}, this.debounceMs);
	}

	private async flushChanges(): Promise<void> {
		if (this.closed || !this.worktree) return;

		if (this.isScanning) {
			this.needsRescan = true;
			return;
		}

		this.isScanning = true;
		this.pendingEvents = [];

		try {
			await this.worktree.scan();
		} catch (e) {
			console.error('[DesktopWatcherSnapshotStrategy] Error scanning on change:', e);
		} finally {
			this.isScanning = false;
			if (this.needsRescan && !this.closed) {
				this.needsRescan = false;
				this.flushChanges();
			}
		}
	}

	async refresh(worktree: Worktree): Promise<void> {
		await worktree.scan();
	}

	async stop(): Promise<void> {
		this.closed = true;

		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}

		this.pendingEvents = [];
		this.needsRescan = false;

		if (this.startPromise) {
			try {
				await this.startPromise;
			} catch {}
			this.startPromise = null;
		}

		if (this.stopWatcher) {
			const stop = this.stopWatcher;
			this.stopWatcher = null;
			try {
				await stop();
			} catch (e) {
				console.error('[DesktopWatcherSnapshotStrategy] Error stopping watcher:', e);
			}
		}

		this.worktree = null;
	}
}
