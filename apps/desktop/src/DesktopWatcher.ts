import watcher, { type AsyncSubscription } from '@parcel/watcher';

export interface WatcherEvent {
	path: string;
	type: 'create' | 'update' | 'delete';
}

export interface DesktopWatcherOptions {
	dirPath: string;
	onEvents: (events: WatcherEvent[]) => void;
	debounceMs?: number;
	ignore?: string[];
}

/**
 * The directories the watcher must not report.
 *
 * Each pattern ends with a slash and a globstar on purpose.
 * `@parcel/watcher` compiles a glob into a regular expression and matches
 * the whole path against it, so a pattern that names only the directory
 * matches the directory itself but not the files inside it, and a nested
 * install still floods the watcher with events. The trailing globstar
 * ignores the directory and everything under it, at any depth.
 */
export const DEFAULT_IGNORE_PATTERNS = [
	'**/node_modules/**',
	'**/.git/**',
	'**/.svelte-kit/**'
];

export class DesktopWatcher {
	private dirPath: string;
	private onEvents: (events: WatcherEvent[]) => void;
	private debounceMs: number;
	private ignore: string[];
	private subscription: AsyncSubscription | null = null;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private pendingEvents: WatcherEvent[] = [];
	private closed = false;

	constructor(options: DesktopWatcherOptions) {
		this.dirPath = options.dirPath;
		this.onEvents = options.onEvents;
		this.debounceMs = options.debounceMs ?? 50;
		this.ignore = options.ignore ?? DEFAULT_IGNORE_PATTERNS;
	}

	async start(): Promise<void> {
		if (this.subscription || this.closed) return;

		this.subscription = await watcher.subscribe(
			this.dirPath,
			(err, events) => {
				if (err || this.closed) return;
				this.handleEvents(events);
			},
			{ ignore: this.ignore }
		);
	}

	private handleEvents(events: WatcherEvent[]): void {
		if (this.closed) return;
		this.pendingEvents.push(...events);

		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}

		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			this.flush();
		}, this.debounceMs);
	}

	private flush(): void {
		if (this.closed || this.pendingEvents.length === 0) return;
		const eventsToEmit = this.pendingEvents;
		this.pendingEvents = [];
		this.onEvents(eventsToEmit);
	}

	async close(): Promise<void> {
		this.closed = true;
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		this.pendingEvents = [];

		if (this.subscription) {
			const sub = this.subscription;
			this.subscription = null;
			try {
				await sub.unsubscribe();
			} catch (e) {
				console.error('[DesktopWatcher] Error during unsubscribe:', e);
			}
		}
	}
}
