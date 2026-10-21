/**
 * Ownership bookkeeping for desktop file watchers (used by main.ts).
 *
 * Tracks which renderer (WebContents) owns each watcher so watchers left
 * behind by a renderer reload or navigation can be cleaned up, and tracks
 * in-flight watcher starts so a renderer that goes away mid-start doesn't
 * leave an orphaned native subscription behind.
 *
 * Two invariants this module upholds:
 * 1. Exactly one `did-start-navigation` listener per owner, removed when the
 *    owner's last watcher closes — repeated watch/unwatch cycles must not
 *    accumulate listeners on the WebContents.
 * 2. A watcher start that loses its owner while the native subscribe is
 *    pending reports as cancelled on settle, so the caller closes the fresh
 *    subscription instead of registering it with no owner.
 *
 * Electron-free: the owner surface is declared structurally so this module
 * is unit-testable under bun.
 */

/**
 * The navigation event Electron emits for 'did-start-navigation'. The event
 * object carries the navigation details: `isSameDocument` is true for an
 * in-page navigation (a hash change, a same-document pushState) and
 * `isMainFrame` is true when the navigation happens in the renderer's own
 * page rather than in a subframe.
 */
export interface WatcherNavigationEvent {
	/** True for a navigation that does not replace the document. */
	isSameDocument: boolean;
	/** True when the navigation happened in the main frame. */
	isMainFrame: boolean;
}

export interface WatcherOwnerEvents {
	readonly id: number;
	once(event: 'destroyed', listener: () => void): void;
	on(event: 'did-start-navigation', listener: (event: WatcherNavigationEvent) => void): void;
	removeListener(event: 'did-start-navigation', listener: (event: WatcherNavigationEvent) => void): void;
	isDestroyed(): boolean;
}

export interface WatcherOwnershipHooks {
	/** Called when an owner's renderer is destroyed or starts navigating. */
	onOwnerGone: (senderId: number) => void;
	/** Resolve a live owner by id; used to detach navigation listeners. */
	getOwner: (senderId: number) => WatcherOwnerEvents | undefined;
}

export class WatcherOwnership {
	private watcherOwners = new Map<string, number>();
	private ownerWatchIds = new Map<number, Set<string>>();
	private ownerNavListeners = new Map<number, (event: WatcherNavigationEvent) => void>();
	private pendingStarts = new Map<string, { senderId: number; token: symbol }>();

	constructor(private hooks: WatcherOwnershipHooks) {}

	/** Register watchId as owned by sender, wiring cleanup listeners on first watch. */
	track(watchId: string, sender: WatcherOwnerEvents): void {
		const senderId = sender.id;
		this.watcherOwners.set(watchId, senderId);
		let ids = this.ownerWatchIds.get(senderId);
		if (!ids) {
			ids = new Set();
			this.ownerWatchIds.set(senderId, ids);
			sender.once('destroyed', () => this.hooks.onOwnerGone(senderId));
			const navListener = (event: WatcherNavigationEvent) => {
				// An in-page navigation (a hash change) and a subframe
				// navigation leave the owner's document in place, so the
				// owner is not gone. Only a main-frame navigation that
				// replaces the document means the renderer went away.
				if (event.isSameDocument === true) return;
				if (event.isMainFrame === false) return;
				this.hooks.onOwnerGone(senderId);
			};
			this.ownerNavListeners.set(senderId, navListener);
			sender.on('did-start-navigation', navListener);
		}
		ids.add(watchId);
	}

	/**
	 * Drop bookkeeping for a closed watcher. Detaches the owner's navigation
	 * listener once its last watcher closes.
	 */
	release(watchId: string): void {
		const senderId = this.watcherOwners.get(watchId);
		this.watcherOwners.delete(watchId);
		if (senderId === undefined) return;
		const ids = this.ownerWatchIds.get(senderId);
		if (!ids) return;
		ids.delete(watchId);
		if (ids.size > 0) return;
		this.ownerWatchIds.delete(senderId);
		const navListener = this.ownerNavListeners.get(senderId);
		this.ownerNavListeners.delete(senderId);
		if (!navListener) return;
		const owner = this.hooks.getOwner(senderId);
		if (owner && !owner.isDestroyed()) {
			owner.removeListener('did-start-navigation', navListener);
		}
	}

	/** WatchIds currently owned by senderId. */
	idsFor(senderId: number): string[] {
		return [...(this.ownerWatchIds.get(senderId) ?? [])];
	}

	/**
	 * Mark the start of an async watcher subscription. Registers ownership
	 * first so a renderer navigating mid-start is observed, and returns a
	 * token for finishStart. Supersedes any earlier in-flight start for the
	 * same watchId.
	 */
	beginStart(watchId: string, sender: WatcherOwnerEvents): symbol {
		this.pendingStarts.delete(watchId);
		this.track(watchId, sender);
		const token = Symbol('watcher-start');
		this.pendingStarts.set(watchId, { senderId: sender.id, token });
		return token;
	}

	/**
	 * Settle an async watcher start. Returns true when the start was
	 * cancelled (owner navigated/was destroyed mid-start) or superseded by a
	 * newer start — the caller must then shut the subscription down instead
	 * of registering it.
	 */
	finishStart(watchId: string, token: symbol): boolean {
		const pending = this.pendingStarts.get(watchId);
		if (pending?.token === token) {
			this.pendingStarts.delete(watchId);
			return false;
		}
		return true;
	}

	/** Cancel one in-flight start; its finishStart will report cancelled. */
	cancelStart(watchId: string): void {
		this.pendingStarts.delete(watchId);
	}

	/** Cancel all in-flight starts belonging to senderId. */
	cancelStartsFor(senderId: number): void {
		for (const [watchId, pending] of [...this.pendingStarts]) {
			if (pending.senderId === senderId) this.pendingStarts.delete(watchId);
		}
	}
}
