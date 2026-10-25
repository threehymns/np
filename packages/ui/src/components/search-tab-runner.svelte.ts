import { SvelteMap } from 'svelte/reactivity';
import type { FileOrigin, FileSearchResult, SearchBackend, Worktree } from '@np/core';
import type { SearchTabSession } from '@np/core';
import { shouldRerunSearchOnSnapshotChange, type TruncationReason } from './search-tab-behavior';

/**
 * The search tab's model: it runs the search, keeps what the run found, and
 * answers for the state the tab renders.
 *
 * The tab itself only renders what the runner holds. The query and the
 * options that go with it live in the session, so every run — the one the
 * user asked for and the one a change of the file snapshot asks for —
 * searches for the same thing.
 */

/**
 * How long a burst of snapshot changes may settle before the search runs
 * again. A save storm publishes a snapshot per file; the search should run
 * once for the storm, not once per file.
 */
export const SNAPSHOT_RERUN_DEBOUNCE_MS = 150;

/** A view that mirrors one file's search result. */
export interface SearchExcerptView {
	/** Rebuild the view so its offsets describe the content the search found. */
	rebuild: () => void;
}

export interface SearchTabRunnerOptions {
	/** The backend that runs the search. */
	getBackend: () => SearchBackend;
	/** The session that holds the query and the options that go with it. */
	getSession: () => SearchTabSession;
	/**
	 * The live text of a file, when a Document holds it.
	 *
	 * The results are an editor for the files they show, so a file changed
	 * there is unsaved and its text lives in a Document. The search reads
	 * that text, not the disk, so the results describe what the user sees.
	 */
	getLiveContent?: (origin: FileOrigin) => string | undefined;
	/** How long to wait for a burst of snapshot changes to settle. */
	debounceMs?: number;
}

export class SearchTabRunner<V extends SearchExcerptView = SearchExcerptView> {
	/** The results of the run in flight, or of the last one that finished. */
	results = $state<FileSearchResult[]>([]);
	/** True while a run is in flight. */
	isSearching = $state(false);
	/** True when the last run hit a cap. */
	isTruncated = $state(false);
	/** The cap the last run hit. */
	truncationReason = $state<TruncationReason>(undefined);
	/** The views that mirror the results, keyed by file path. */
	readonly excerptViews = new SvelteMap<string, V>();

	private readonly getBackend: () => SearchBackend;
	private readonly getSession: () => SearchTabSession;
	private readonly getLiveContent: ((origin: FileOrigin) => string | undefined) | undefined;
	private readonly debounceMs: number;
	private abortController: AbortController | null = null;
	private worktree: Worktree | null = null;
	private worktreeUnsubscribe: (() => void) | null = null;
	/** The file-set version of the snapshot the tab last saw. */
	private lastSnapshotVersion = -1;
	/** The content-invalidation generation the tab last saw. */
	private lastContentVersion = -1;
	private rerunTimer: ReturnType<typeof setTimeout> | null = null;
	private idleWaiters: Array<() => void> = [];

	constructor(options: SearchTabRunnerOptions) {
		this.getBackend = options.getBackend;
		this.getSession = options.getSession;
		this.getLiveContent = options.getLiveContent;
		this.debounceMs = options.debounceMs ?? SNAPSHOT_RERUN_DEBOUNCE_MS;
	}

	/**
	 * Follows the worktree's file snapshot and re-runs the search when the
	 * snapshot moves on.
	 *
	 * The results describe the files as they were when the search ran, so a
	 * file edited outside the editor — in a terminal, by a branch switch —
	 * leaves the results describing content the project no longer has.
	 */
	attachToWorktree(worktree: Worktree | null): void {
		if (this.worktree === worktree) return;
		this.worktreeUnsubscribe?.();
		this.worktreeUnsubscribe = null;
		this.worktree = worktree;
		this.lastSnapshotVersion = -1;
		this.lastContentVersion = -1;
		if (!worktree) return;
		this.worktreeUnsubscribe = worktree.subscribe((snapshot) => {
			this.onSnapshot(snapshot.version, snapshot.contentVersion);
		});
	}

	/** Registers the view that mirrors a file's result. */
	registerExcerptView(filepath: string, view: V): void {
		this.excerptViews.set(filepath, view);
	}

	/** Forgets the view that mirrored a file's result. */
	unregisterExcerptView(filepath: string): void {
		this.excerptViews.delete(filepath);
	}

	/**
	 * Runs the search with the session's query and its options.
	 *
	 * A run with nothing to search for clears the results: a query that was
	 * emptied has no matches to show.
	 */
	async run(): Promise<void> {
		// A run replaces the one before it. The search in flight is given
		// up, so two searches never write into the same results.
		this.abortController?.abort();

		const session = this.getSession();
		const query = session.toQuery();
		if (session.regexError || !query.pattern) {
			this.results = [];
			this.isSearching = false;
			this.isTruncated = false;
			this.truncationReason = undefined;
			this.settleIdle();
			return;
		}

		this.abortController = new AbortController();
		const signal = this.abortController.signal;

		// The views that mirror the results as they are now. A view's
		// offsets describe the content the search found, so a view that
		// survives this run is rebuilt from what this run found.
		const views = [...this.excerptViews.entries()];

		this.results = [];
		this.isSearching = true;
		this.isTruncated = false;
		this.truncationReason = undefined;

		try {
			const stream = this.getBackend().search(query, {
				signal,
				liveContent: this.getLiveContent
			});

			for await (const result of stream) {
				if (signal.aborted) break;
				this.results = [...this.results, result];
				if (stream.progress.truncated) {
					this.isTruncated = true;
					this.truncationReason = stream.progress.truncationReason;
				}
			}

			if (!signal.aborted) {
				this.isTruncated = stream.progress.truncated;
				this.truncationReason = stream.progress.truncationReason;
			}
		} catch (e) {
			if (!signal.aborted) {
				console.error('[SearchTab] Search failed:', e);
			}
		} finally {
			if (this.abortController?.signal === signal) {
				this.isSearching = false;
			}
			if (!signal.aborted) {
				this.rebuildExcerptViews(views);
			}
			this.settleIdle();
		}
	}

	/**
	 * Resolves when no run is in flight and no re-run is pending.
	 */
	async idle(): Promise<void> {
		if (!this.isSearching && !this.rerunTimer) return;
		await new Promise<void>((resolve) => {
			this.idleWaiters.push(resolve);
		});
	}

	/** Stops following the snapshot and gives up the run in flight. */
	dispose(): void {
		this.attachToWorktree(null);
		if (this.rerunTimer) {
			clearTimeout(this.rerunTimer);
			this.rerunTimer = null;
		}
		this.abortController?.abort();
		this.settleIdle();
	}

	/**
	 * Rebuilds the views that were showing the results the run replaced.
	 *
	 * A view that was replaced while the run was in flight already shows the
	 * content the run found: it was built from it.
	 */
	private rebuildExcerptViews(views: Array<[string, V]>): void {
		for (const [filepath, view] of views) {
			if (this.excerptViews.get(filepath) !== view) continue;
			view.rebuild();
		}
	}

	private onSnapshot(version: number, contentVersion: number): void {
		const previousVersion = this.lastSnapshotVersion;
		const previousContentVersion = this.lastContentVersion;
		this.lastSnapshotVersion = version;
		this.lastContentVersion = contentVersion;
		// The first snapshot the tab hears is the state it starts from, not a
		// change of it: there is nothing to re-run for.
		if (previousVersion === -1 && previousContentVersion === -1) return;
		if (
			!shouldRerunSearchOnSnapshotChange({
				lastSnapshotVersion: previousVersion,
				snapshotVersion: version,
				lastContentVersion: previousContentVersion,
				contentVersion,
				query: this.getSession().query
			})
		) {
			return;
		}
		this.scheduleRerun();
	}

	private scheduleRerun(): void {
		if (this.rerunTimer) clearTimeout(this.rerunTimer);
		this.rerunTimer = setTimeout(() => {
			this.rerunTimer = null;
			void this.run();
		}, this.debounceMs);
	}

	private settleIdle(): void {
		if (this.isSearching || this.rerunTimer) return;
		const waiters = this.idleWaiters;
		this.idleWaiters = [];
		for (const resolve of waiters) resolve();
	}
}
