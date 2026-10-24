import { PluginHost } from './plugins/host.svelte';
import type { PluginHostInterface } from './plugins/types';
import { WORKSPACE_SERVICE_KEY } from './plugins/services';
import { untrack } from 'svelte';
import { DocumentSession } from './document.svelte';
import { type Storage, type FileOrigin, toURI, toSuggestedSaveName } from './storage';
import { isNotFoundError } from './utils';
import { Project } from './project/project.svelte';
import type { WorktreeSnapshotStrategy } from './project/worktree.svelte';
import type { Repository, RepositorySafetyReport } from './project/repository.svelte';
import { type SessionPersistence, type SerializedDocument, type SerializedWorkspace } from './persistence';
import type { SwitchResult, VCSAdapter } from './project/vcs';
import { SearchTabSession } from './search';
import { SEARCH_TAB_ID } from './tab-ids';
import {
	DIAGNOSTICS_TAB_ID,
	DIAGNOSTICS_TAB_TITLE,
	DiagnosticsSession
} from './diagnostics-tab.svelte';

import {
	Pane,
	Axis,
	type LayoutNode,
	type SplitDirection,
	type SplitMode,
	type WorkspaceTab,
	getAllPanes,
	findPane,
	findPaneWithTab,
	splitPane,
	removePane,
	findPaneInDirection,
	canSplitTab,
	type Rect,
	WORKSPACE_PERSISTENCE_VERSION
} from './split-tree.svelte';

export type { WorkspaceTab } from './split-tree.svelte';

export interface ProjectIdentity {
	uri: string;
	repository: Repository | null;
	generation: number;
}

export class Workspace {
	documents = $state<DocumentSession[]>([]);
	layout = $state<LayoutNode>(new Pane());
	activePaneId = $state<string>('');
	pendingCloseId = $state<string | null>(null);
	pendingCloseQueue = $state<{ tabId: string; paneId?: string }[]>([]);
	/**
	 * Closed tabs awaiting reopen, most recent last, paired with the pane
	 * that held them so `reopenClosedTab` puts a tab back where it was.
	 * Session-scoped: the top of the stack answers the reopen command, and
	 * a restart forgets the history.
	 */
	closedTabs = $state<{ tab: WorkspaceTab; paneId: string; doc?: DocumentSession }[]>([]);

	get otherPendingCloseCount(): number {
		return this.pendingCloseQueue.length;
	}

	cancelPendingClose(): void {
		this.pendingCloseId = null;
		this.pendingCloseQueue = [];
	}
	/**
	 * Upper bound on the closed-tab history; an unbounded stack of closed
	 * tabs would keep their tab records alive for the whole session.
	 */
	private static readonly MAX_CLOSED_TABS = 100;
	project: Project;
	// NOTE (#254): recent-folders history reads window-scoped but is
	// per-folder-ambiguous; correct with one Project, revisitable when a
	// second Project exists. Stays on Workspace by design.
	recentFolders = $state<FileOrigin[]>([]);
	onRootOriginChange?: (origin: FileOrigin | null) => Promise<void> | void;
	pluginHost: PluginHostInterface;
	lastSaveCancellationReason = $state<string | null>(null);
	searchTabFocusNonce = $state<number>(0);

	/**
	 * A Root switch is in flight. Workspace-level, not Project-level: the
	 * open rewrites the window (documents, tabs, panes) as well as the Root
	 * the Project is opened on, and the flag has to cover both, because the
	 * window state is part of what a failed open has to roll back.
	 */
	projectOpening = $state(false);
	/**
	 * The last Root-open failure, or null. Workspace-level for the same
	 * reason as `projectOpening`: the failure belongs to the operation, not
	 * to the Project that was open before it.
	 */
	projectError = $state<string | null>(null);
	/**
	 * A branch switch is in flight.
	 */
	private branchSwitching = $state(false);
	/**
	 * How many times the Root the current Project is opened on has been
	 * replaced.
	 *
	 * Workspace-level on purpose. The counter guards work that outlives the
	 * Project it guards. The Project survives a Root change, so a counter
	 * stored on it would not reset; and a Project is a store that never
	 * observes its Root being replaced, so it could not count the opens
	 * either. The Workspace is what runs the open, so it is the only object
	 * that can count them.
	 */
	private projectGeneration = $state(0);
	/**
	 * Commit message drafts, keyed by project URI.
	 *
	 * Workspace-level because the draft has to outlive the project it was
	 * written in: switching away and back must find the draft again, and a
	 * draft written for one project must never show up under another.
	 */
	commitDrafts = $state<Record<string, string>>({});

	/**
	 * URI of the Root the current Project is opened on, or '' when no Root
	 * is open.
	 */
	get projectUri(): string {
		return this.project.rootOrigin ? toURI(this.project.rootOrigin) : '';
	}

	/**
	 * True while a project or repository mutation is running. Callers use it
	 * to refuse concurrent mutations: two Root opens, or a Root open and a
	 * branch switch, must not interleave.
	 */
	get projectMutationBusy(): boolean {
		return this.projectOpening || this.branchSwitching || !!this.project.repository?.isBusy;
	}

	/**
	 * Snapshot of the project that is current right now. Held across an
	 * await and compared with `isCurrentProject` afterwards, so a result
	 * that arrives after the user opened a different Root is discarded
	 * instead of being applied to the wrong project.
	 */
	captureProject(): ProjectIdentity {
		return {
			uri: this.projectUri,
			repository: this.project.repository,
			generation: this.projectGeneration
		};
	}

	/**
	 * Is the captured identity still the current project? False once the
	 * Root changed, once the Repository was replaced, or once the Root was
	 * replaced a second time.
	 */
	isCurrentProject(target: ProjectIdentity): boolean {
		return (
			target.uri === this.projectUri &&
			target.repository === this.project.repository &&
			target.generation === this.projectGeneration
		);
	}

	private untitledCounter = 0;
	private isRestoring = $state(true);
	private restorePromise: Promise<void> | null = null;
	private latestRestoreId = 0;

	private saveOpenFilesTimeout: any = null;

	/**
	 * The keystroke path: set in-memory content and schedule a session flush.
	 * This is the only typing path — `Editor`, commands, and tests simulating
	 * keystrokes go through here. Direct `doc.content =` is passive (no flush)
	 * and reserved for state restores and isolated Document tests.
	 */
	updateDocumentContent(doc: DocumentSession, content: string): void {
		if (doc.content === content) return;
		doc.content = content;
		// Document lifecycle is observable by plugins (ADR 0013), the same way a
		// save is. A consumer that mirrors the open document somewhere else — a
		// language server, for one — needs the new text, and the keystroke path is
		// the only place it exists. Observers, so the emit cannot veto the edit.
		this.pluginHost?.emit('document:changed', { document: doc, origin: doc.origin, content });
		this.debouncedSaveOpenFiles();
	}

	/** Root fast-path first, storage verify second. Used by the permission overlay. */
	requestFilePermission(doc: DocumentSession): Promise<boolean> {
		if (!doc.origin) return Promise.resolve(true);
		return doc.requestPermission(this.project.coversOrigin(doc.origin));
	}

	/**
	 * The save path: run the Document's storage save with fresh root coverage,
	 * then refresh the repo and schedule a session flush on success. Prefer
	 * this over `doc.save` — a direct save leaves persistence holding a stale
	 * `draftContent` until some unrelated flush happens to clear it.
	 */
	setPluginHost(host: PluginHostInterface) {
		this.pluginHost = host;
		// Re-publish under the generic workspace service key so feature
		// plugins resolving the workspace lazily keep working after a host
		// swap. The key is generic; the host never names features.
		this.pluginHost.provideService(WORKSPACE_SERVICE_KEY, this);
	}

	async saveDocument(doc: DocumentSession, options: { forceNewOrigin?: boolean } = {}): Promise<boolean> {
		return this.pluginHost.runSaveExclusive(async () => this.saveDocumentInner(doc, options));
	}

	private async saveDocumentInner(
		doc: DocumentSession,
		options: { forceNewOrigin?: boolean } = {}
	): Promise<boolean> {
		this.pluginHost?.checkSaveReentry('saveDocument', 'beforeSave hook');

		if (this.pluginHost) {
			const beforeResult = await this.pluginHost.runBeforeSave({ document: doc, options });
			if (beforeResult.cancel) {
				this.lastSaveCancellationReason = beforeResult.reason ?? 'Save cancelled by plugin';
				return false;
			}
		}

		this.lastSaveCancellationReason = null;
		const covered = doc.origin ? this.project.coversOrigin(doc.origin) : false;
		const needsPicker = !doc.origin || options.forceNewOrigin;

		// A save that throws still has to reach the after-save consumers: they
		// are the ones holding state derived from the write (Git's save-driven
		// refresh, for one), and skipping them would leave that state silently
		// stale. The failure is reported to them as an unsuccessful save and
		// then rethrown, so the caller still sees it (ADR 0013).
		let ok: boolean;
		try {
			ok = await doc.save({
				...options,
				coveredByRoot: covered,
				// Untitled (or Save As) opens the picker: root it at the workspace
				// folder and prefill the draft title. Falls back to a safe
				// filename with no directory when no folder is open.
				suggestedName: needsPicker ? toSuggestedSaveName(doc.fileName) : undefined,
				startDirectory: needsPicker ? this.project.rootOrigin : undefined
			});
		} catch (error) {
			await this.pluginHost?.runAfterSave({ document: doc, options, success: false });
			throw error;
		}

		if (this.pluginHost) {
			await this.pluginHost.runAfterSave({ document: doc, options, success: ok });
		}

		if (ok) {
			this.pluginHost?.emit('document:saved', { document: doc, origin: doc.origin });
			this.debouncedSaveOpenFiles();
		}
		return ok;
	}

	/**
	 * Diff-tab selections read back from persisted session state, keyed by tab
	 * id, awaiting a repository that has refreshed its change list to be
	 * applied to. Keyed per tab so multiple persisted diff tabs resolve
	 * independently instead of overwriting a shared slot — a later tab's stale
	 * selection must not destroy an earlier tab's still-valid one.
	 */
	private pendingDiffRestore = new Map<string, { filepath: string; staged?: boolean }>();

	/**
	 * Diff-filepath -> bound Document id for Working-copy pane bindings
	 * (#269). Written by the mounted Diff Viewer alongside its own binding
	 * effect and read by the Git Hunk Actions choke point through the same
	 * shared lookup, so both sides stay bound to the same Document across a
	 * Save As (which moves the Document's origin without changing the diff
	 * filepath). Stale ids are pruned on lookup, never persisted.
	 */
	readonly diffBoundDocIds = new Map<string, string>();

	/**
	 * The diagnostics session per diagnostics tab (#309): the severity filter
	 * and the sort order the reader chose.
	 *
	 * Kept on the workspace rather than in the tab's view, because the tab's
	 * controls and the tab's list are two different things: the filter has to
	 * survive the tab being switched away from and back to, and a view that is
	 * unmounted and mounted again starts empty. Keyed by tab id, so two
	 * diagnostics tabs in two panes are two readers.
	 */
	private readonly diagnosticsSessions = new Map<string, DiagnosticsSession>();

	private applyPendingDiffRestore() {
		if (!this.isRepositoryActive) return;
		const repo = this.project.repository;
		if (!repo || this.pendingDiffRestore.size === 0) return;

		for (const [tabId, pending] of [...this.pendingDiffRestore]) {
			// The persisted tab is gone; drop its queued selection.
			if (!this.getAllTabs().some(t => t.id === tabId)) {
				this.pendingDiffRestore.delete(tabId);
				continue;
			}

			let match = repo.changes.find(c => c.filepath === pending.filepath && (pending.staged === undefined || c.staged === pending.staged));
			if (!match) {
				match = repo.changes.find(c => c.filepath === pending.filepath);
			}
			// During session restore this can run while the repository's initial
			// refresh is still in flight; an empty change list then means "not
			// loaded yet", not "no match". Keep this entry queued for the
			// post-refresh retry instead of discarding it.
			if (!match && !repo.changesLoaded) continue;
			this.pendingDiffRestore.delete(tabId);

			// `activeDiffFile` is a single workspace-global slot, so entries
			// applied in iteration order and the last resolvable one wins.
			if (match) {
				repo.activeDiffFile = match;
			}
		}
	}

	debouncedSaveOpenFiles() {
		if (this.saveOpenFilesTimeout) {
			clearTimeout(this.saveOpenFilesTimeout);
		}
		this.saveOpenFilesTimeout = setTimeout(() => {
			this.flushSaveOpenFiles().catch((e) => console.error('[Workspace] flushSaveOpenFiles failed', e));
		}, 500);
	}

	/**
	 * The persisted shape of the workspace's open files: the version key and
	 * one entry per open document, in tab order across the panes.
	 *
	 * The tabs themselves are not persisted. A document that is open in more
	 * than one pane is written once, so the layout is not part of the saved
	 * state and a session always comes back in a single pane.
	 */
	serializeWorkspace(): SerializedWorkspace {
		const serializedMap = new Map<string, SerializedDocument>();
		for (const pane of this.getAllPanes()) {
			for (const tab of pane.tabs) {
				if (serializedMap.has(tab.id)) continue;
				if (tab.type === 'search') {
					// The query and its options live in the tab's session, so
					// they are persisted with the tab and restored with it.
					const session = tab.searchSession ?? this.searchSessions.get(tab.id);
					serializedMap.set(tab.id, {
						id: tab.id,
						origin: null,
						virtualTabType: 'search',
						...(session
							? {
									searchQuery: session.query,
									searchIsRegex: session.isRegex,
									searchCaseSensitive: session.caseSensitive,
									searchWholeWord: session.wholeWord,
									searchIncludePattern: session.includePattern,
									searchExcludePattern: session.excludePattern
								}
							: {})
					});
				} else if (tab.type === 'diff') {
					const serialized: SerializedDocument = {
						id: tab.id,
						origin: null,
						virtualTabType: 'diff',
						...(tab.pluginId ? { pluginId: tab.pluginId } : {})
					};
					const active = this.project.repository?.activeDiffFile;
					if (active) {
						serialized.diffFilepath = active.filepath;
						serialized.diffStaged = active.staged;
					} else {
						// Session restore can finish before the repository's refresh
						// applies the persisted selection; serialize the queued one so a
						// save in that window doesn't drop it.
						const pending = this.pendingDiffRestore.get(tab.id);
						if (pending) {
							serialized.diffFilepath = pending.filepath;
							serialized.diffStaged = pending.staged;
						}
					}
					serializedMap.set(tab.id, serialized);
				} else {
					const docId = tab.docId ?? tab.id;
					const doc = this.documents.find(d => d.id === docId);
					if (!doc) continue;
					const serialized: SerializedDocument = {
						id: doc.id,
						origin: doc.origin ? $state.snapshot(doc.origin) : null,
						untitledTitle: doc.untitledTitle,
						deletedOnDisk: doc.deletedOnDisk ? true : undefined
					};
					if (doc.isModified || !doc.origin || doc.deletedOnDisk) {
						serialized.draftContent = doc.content;
					}
					serializedMap.set(tab.id, serialized);
				}
			}
}

		// Tab-less bound Documents (Diff Viewer Working-copy pane bindings for
		// files with no open tab, issue #272) hold user text no tab serializes.
		// Persist dirty ones as tab-less entries under the same draft rules so
		// pane edits survive a restart; clean ones are re-derivable from the
		// next loaded diff snapshot and need no entry.
		//
		// A document can be open in more than one pane, so "has a tab" means
		// "has a tab in some pane".
		const tabbedDocIds = new Set<string>();
		for (const pane of this.getAllPanes()) {
			for (const tab of pane.tabs) {
				if (tab.type === 'document') tabbedDocIds.add(tab.docId ?? tab.id);
			}
		}
		const tablessDocs: SerializedDocument[] = [];
		for (const doc of this.documents) {
			if (tabbedDocIds.has(doc.id)) continue;
			if (!doc.isModified && doc.origin && !doc.deletedOnDisk) continue;
			tablessDocs.push({
				id: doc.id,
				origin: doc.origin ? $state.snapshot(doc.origin) : null,
				untitledTitle: doc.untitledTitle,
				deletedOnDisk: doc.deletedOnDisk ? true : undefined,
				...(doc.isModified || !doc.origin || doc.deletedOnDisk
					? { draftContent: doc.content }
					: {}),
				tabless: true
			});
		}
		const docs = [...Array.from(serializedMap.values()), ...tablessDocs];
		return { version: WORKSPACE_PERSISTENCE_VERSION, docs };
	}

  async flushSaveOpenFiles(): Promise<void> {
		if (this.isRestoring) return;

		if (this.saveOpenFilesTimeout) {
			clearTimeout(this.saveOpenFilesTimeout);
			this.saveOpenFilesTimeout = null;
		}

		const folderUri = this.project.rootOrigin ? toURI(this.project.rootOrigin) : '';
		const serializedDocs = this.serializeWorkspace();

		await this.project.saveOpenFiles(serializedDocs, folderUri);
	}

	constructor(
		storage: Storage,
		vcsFactory: (rootOrigin: FileOrigin) => VCSAdapter,
		persistence: SessionPersistence,
		pluginHost?: PluginHostInterface,
		snapshotStrategyFactory?: (rootOrigin: FileOrigin, storage: Storage) => WorktreeSnapshotStrategy
	) {
		this.project = new Project(storage, vcsFactory, persistence, snapshotStrategyFactory);
		this.activePaneId = (this.layout as Pane).id;
		this.project.projectTree.setWindowHooks({
			markDocumentsDeleted: (origin) => this.markDocumentsDeleted(origin),
			reconcileExternalDeletions: () => this.reconcileExternalDeletions(),
			updateDocumentOrigin: (oldUri, newOrigin) => {
				for (const doc of this.documents) {
					if (doc.origin && toURI(doc.origin) === oldUri) {
						doc.origin = newOrigin;
					}
				}
			}
		});
		this.pluginHost = pluginHost ?? new PluginHost();
		// Publish under the generic workspace service key (#202): feature
		// plugins (e.g. Git) resolve the workspace lazily through the host
		// instead of the core hardwiring feature lifecycles.
		this.pluginHost.provideService(WORKSPACE_SERVICE_KEY, this);

		$effect.root(() => {
			$effect(() => {
				const activeDoc = this.activeDocument;
				// Skip when already modified so a restore + fast-typing window
				// doesn't schedule a load that would clobber keystrokes;
				// loadContent itself also rebases instead of overwriting.
				if (activeDoc && activeDoc.origin && !activeDoc.isLoaded && !activeDoc.isModified && !activeDoc.deletedOnDisk) {
					activeDoc.loadContent().catch(() => {});
				}
			});

			$effect(() => {
				if (this.isRestoring) return;
				
				const _folderUri = this.project.rootOrigin ? toURI(this.project.rootOrigin) : '';
				const _tabs = this.getAllTabs().map(t => t.id).join(',');
				const _docs = this.documents.map(d => `${d.id}:${d.origin ? toURI(d.origin) : d.untitledTitle}`).join(',');
				// Read the search-session fields (query + five options) for every
				// search tab so option changes schedule a persistence flush.
				// Mirrors serializeTabs(): read-only lookup, no session creation.
				const _search = this.tabs
					.filter(t => t.type === 'search')
					.map(t => {
						const session = t.searchSession ?? this.searchSessions.get(t.id);
						return session
							? [session.query, session.isRegex, session.caseSensitive, session.wholeWord, session.includePattern, session.excludePattern].join('|')
							: '';
					})
					.join(',');
				
				this.debouncedSaveOpenFiles();
			});

			$effect(() => {
				if (this.isRestoring) return;
				const folderUri = this.project.rootOrigin ? toURI(this.project.rootOrigin) : '';
				this.project.saveActiveDocumentId(this.activeTabId, folderUri);
				untrack(() => {
					void this.flushSaveOpenFiles().catch((e) => console.error('[Workspace] flushSaveOpenFiles failed', e));
				});
			});

			$effect(() => {
				if (this.isRestoring) return;
				// NOTE (#254): root-folder save reads window-scoped but is
				// per-folder-ambiguous; correct with one Project, revisitable
				// when a second Project exists. Left in place by design.
				this.project.persistence.saveRootFolder(this.project.rootOrigin ? $state.snapshot(this.project.rootOrigin) : null);
			});

			$effect(() => {
				if (this.isRestoring) return;
				// NOTE (#254): recent-folders history reads window-scoped but is
				// per-folder-ambiguous; correct with one Project, revisitable
				// when a second Project exists. Left in place by design.
				this.project.persistence.saveRecentFolders($state.snapshot(this.recentFolders));
			});
		});
	}

	get activePane(): Pane {
		if (this.activePaneId) {
			const pane = findPane(this.layout, this.activePaneId);
			if (pane) return pane;
		}
		const all = getAllPanes(this.layout);
		if (all.length > 0) {
			this.activePaneId = all[0].id;
			return all[0];
		}
		const fresh = new Pane();
		this.layout = fresh;
		this.activePaneId = fresh.id;
		return fresh;
	}

	get rootPane(): Pane {
		const all = getAllPanes(this.layout);
		return all[0] ?? (this.layout as Pane);
	}

	get tabs(): WorkspaceTab[] {
		return this.activePane.tabs;
	}

	set tabs(value: WorkspaceTab[]) {
		this.activePane.tabs = value;
	}

	get activeTabId(): string {
		return this.activePane.activeTabId;
	}

	set activeTabId(value: string) {
		this.activePane.activeTabId = value;
	}

	get activeTab() {
		return this.activePane.activeTab;
	}

	get activeDocument() {
		if (this.activeTab?.type === 'document') {
			const docId = this.activeTab.docId ?? this.activeTab.id;
			return this.documents.find((doc) => doc.id === docId);
		}
		return undefined;
	}

	get activeDocumentId() {
		return this.activeTabId;
	}

	set activeDocumentId(value: string) {
		this.activeTabId = value;
	}

	findPane(id: string): Pane | null {
		return findPane(this.layout, id);
	}

	getAllPanes(): Pane[] {
		return getAllPanes(this.layout);
	}

	getAllTabs(): WorkspaceTab[] {
		return getAllPanes(this.layout).flatMap((p) => p.tabs);
	}

	findPaneWithTab(tabId: string): Pane | null {
		return findPaneWithTab(this.layout, tabId);
	}

	countTabsForDocument(docId: string): number {
		let count = 0;
		for (const pane of this.getAllPanes()) {
			for (const tab of pane.tabs) {
				if ((tab.docId ?? tab.id) === docId) {
					count++;
				}
			}
		}
		return count;
	}

	splitActivePane(direction: SplitDirection, mode: SplitMode = 'clone'): Pane {
		const sourcePane = this.activePane;
		const activeTab = sourcePane.activeTab;
		const newPane = new Pane();

		if (mode === 'move') {
			if (activeTab) {
				const idx = sourcePane.tabs.findIndex((t) => t.id === activeTab.id);
				if (idx !== -1) {
					sourcePane.tabs.splice(idx, 1);
					sourcePane.activeTabId = sourcePane.tabs[Math.max(0, idx - 1)]?.id ?? '';
				}
				newPane.tabs = [{ ...activeTab }];
				newPane.activeTabId = activeTab.id;
			}
		} else if (mode === 'clone') {
			if (activeTab && canSplitTab(activeTab)) {
				newPane.tabs = [{ ...activeTab }];
				newPane.activeTabId = activeTab.id;
			}
		}

		this.layout = splitPane(this.layout, sourcePane.id, direction, newPane);
		this.activePaneId = newPane.id;
		this.debouncedSaveOpenFiles();
		return newPane;
	}

	focusPaneInDirection(direction: SplitDirection, rectsMap?: Map<string, Rect>): boolean {
		const targetId = findPaneInDirection(this.activePane.id, direction, rectsMap);
		if (targetId) {
			this.activePaneId = targetId;
			return true;
		}
		return false;
	}

	/**
	 * Generic off-state gate (AC1): the published repository is exposed
	 * only while its owning contributor is active. A slot left behind by a
	 * bounded-cleanup timeout (ADR 0009) therefore stays inert: branch UI
	 * hides and refresh/switch paths no-op instead of driving Git activity.
	 * No feature names here; the owner id is opaque data set by the
	 * publisher.
	 */
	get isRepositoryActive(): boolean {
		if (!this.project.repository || !this.project.repositoryOwnerId) return false;
		try {
			return this.pluginHost?.isPluginActive(this.project.repositoryOwnerId) ?? false;
		} catch {
			return false;
		}
	}

	get currentBranch() {
		if (!this.isRepositoryActive) return null;
		return this.project.repository?.currentBranch ?? null;
	}

	get branches() {
		if (!this.isRepositoryActive) return [];
		return this.project.repository?.branches ?? [];
	}

	setTabs(tabs: WorkspaceTab[]) {
		this.tabs = tabs;
		this.debouncedSaveOpenFiles();
	}

	reorderDocuments(newDocs: DocumentSession[]) {
		this.documents = newDocs;
		// Tabs are the persisted ordering authority, so a document reorder
		// must permute tabs too or the next session restores stale order.
		// Non-document tabs sort after all document tabs, keeping their own
		// relative order (stable sort).
		const rank = new Map<string, number>();
		newDocs.forEach((d, i) => rank.set(d.id, i));
		this.tabs = [...this.tabs].sort((x, y) => {
			const rx = rank.get(x.id);
			const ry = rank.get(y.id);
			if (rx !== undefined && ry !== undefined) return rx - ry;
			if (rx !== undefined) return -1;
			if (ry !== undefined) return 1;
			return 0;
		});
		this.debouncedSaveOpenFiles();
	}

	moveTab(fromIdx: number, toIdx: number) {
		if (fromIdx < 0 || fromIdx >= this.tabs.length || toIdx < 0 || toIdx >= this.tabs.length || fromIdx === toIdx) {
			return;
		}
		const [movedTab] = this.tabs.splice(fromIdx, 1);
		this.tabs.splice(toIdx, 0, movedTab);
		if (movedTab.type === 'document') {
			const docFrom = this.documents.findIndex(d => d.id === movedTab.id);
			if (docFrom !== -1) {
				const [movedDoc] = this.documents.splice(docFrom, 1);
				// The tab strip and the documents array hold different item
				// kinds, so derive the insertion slot from how many document
				// tabs precede the target position.
				const docTabsBefore = this.tabs.slice(0, toIdx).filter(t => t.type === 'document').length;
				this.documents.splice(Math.min(docTabsBefore, this.documents.length), 0, movedDoc);
			}
		}
		this.debouncedSaveOpenFiles();
	}

	async newFile() {
		this.untitledCounter++;
		const newDoc = new DocumentSession(this.project.storage, '', null, `Untitled ${this.untitledCounter}`);
		this.documents.push(newDoc);
		this.tabs.push({ id: newDoc.id, type: 'document' });
		this.activeTabId = newDoc.id;
		// A document becoming open is observable by plugins (ADR 0013), the same
		// way a save is. It is a generic lifecycle fact, not an invitation to name
		// a feature: consumers decide whether an untitled, origin-less document is
		// of any interest to them.
		this.pluginHost?.emit('document:opened', { document: newDoc, origin: newDoc.origin });
		return newDoc;
	}

	/**
	 * The diagnostics session for one tab (#309): the severity filter and the
	 * sort order the reader chose.
	 *
	 * Created on first ask, so a tab that is opened and never touched still has
	 * a session to read: the tab's controls bind to it, and a control with
	 * nothing to bind to is a control that cannot be written to.
	 */
	getDiagnosticsSession(tabId: string): DiagnosticsSession {
		let session = this.diagnosticsSessions.get(tabId);
		if (!session) {
			session = new DiagnosticsSession();
			this.diagnosticsSessions.set(tabId, session);
		}
		return session;
	}

	/**
	 * Opens the project-wide diagnostics tab, or focuses it when it is already
	 * open.
	 *
	 * Idempotent, because the tab is reachable from the command palette and
	 * from a keybinding, and asking twice for the same tab must not stack two
	 * of them. The diagnostics are not read here: the tab is a view over the
	 * merged store the LSP plugin publishes, and the store is the only source
	 * of what it shows.
	 */
	openDiagnosticsTab(): string {
		const id = DIAGNOSTICS_TAB_ID;
		const existing = this.getAllTabs().find((tab) => tab.id === id);
		if (existing) {
			const pane = findPaneWithTab(this.layout, existing.id);
			if (pane) {
				this.activePaneId = pane.id;
				pane.activeTabId = existing.id;
			} else {
				this.activeTabId = id;
			}
		} else {
			// A closed diagnostics tab leaves its record in the closed-tabs
			// history. The replacement below reuses the same id, so the stale
			// entry has to go: otherwise reopenClosedTab would later stack a
			// second tab with that id.
			this.closedTabs = this.closedTabs.filter((entry) => entry.tab.id !== id);
			this.tabs.push({ id, type: 'diagnostics', title: DIAGNOSTICS_TAB_TITLE });
			this.activeTabId = id;
		}
		this.getDiagnosticsSession(id);
		return id;
	}

	async openFile(specificOrigin?: FileOrigin) {
		let origin: FileOrigin | null = null;

		if (specificOrigin) {
			origin = specificOrigin;
		} else {
			origin = await this.project.storage.pickFile();
		}

		if (!origin) return;

		// Check if already open
		const targetUri = toURI(origin);
		const existing = this.documents.find(d => d.origin && toURI(d.origin) === targetUri);
		if (existing) {
			// A tab-less bound Document (Diff Viewer Working-copy pane, issue
			// #272) holds the file's live text but no tab. Opening the file
			// must show a tab, so adopt the bound Document instead of
			// creating a second truth.
			const existingTab = this.activePane.tabs.find(t => (t.docId ?? t.id) === existing.id);
			if (existingTab) {
				this.activePane.activeTabId = existingTab.id;
			} else {
				this.activePane.tabs.push({ id: existing.id, type: 'document' });
				this.activePane.activeTabId = existing.id;
			}
			return existing;
		}

		const content = await this.project.storage.readFile(origin);
		const newDoc = new DocumentSession(this.project.storage, content, origin);
		newDoc.refreshPermissionState(this.project.coversOrigin(origin));
		this.documents.push(newDoc);
		this.tabs.push({ id: newDoc.id, type: 'document' });
		this.activeTabId = newDoc.id;
		// Content is read before the emit, so an observer sees the document as it
		// is on disk rather than as an empty shell it has to wait on.
		this.pluginHost?.emit('document:opened', { document: newDoc, origin: newDoc.origin });
		return newDoc;
	}

	/**
	 * The document for a file, whether or not the file has a tab.
	 *
	 * The results are an editor for the files they show, so an edit made
	 * there needs a Document even when the file is not open. The Document
	 * is created without a tab — the same bound Document a Diff Viewer's
	 * working-copy pane uses (issue #272) — and `openFile` adopts it when
	 * the file is opened later. A replace operation never opens a tab.
	 *
	 * `content` seeds a new Document with the text the caller is editing,
	 * so the caller's offsets keep their meaning even when the file has
	 * changed on disk since the caller read it.
	 */
	async getOrCreateBoundDocument(
		origin: FileOrigin,
		content?: string
	): Promise<DocumentSession | null> {
		const targetUri = toURI(origin);
		const existing = this.documents.find(d => d.origin && toURI(d.origin) === targetUri);
		if (existing) return existing;

		let initialContent = content;
		if (initialContent === undefined) {
			try {
				initialContent = await this.project.storage.readFile(origin);
			} catch {
				return null;
			}
		}

		const doc = new DocumentSession(this.project.storage, initialContent, origin);
		doc.refreshPermissionState(this.project.coversOrigin(origin));
		this.documents.push(doc);
		this.pluginHost?.emit('document:opened', { document: doc, origin: doc.origin });
		return doc;
	}

private searchSessions = new Map<string, SearchTabSession>();

	/**
	 * The query session of a search tab.
	 *
	 * The query and its options live in the session rather than in the
	 * component, so they survive a tab switch, a tab close and reopen, and
	 * a restart. A tab that already carries a session keeps it.
	 */
	getSearchSession(tabId: string): SearchTabSession {
		let session = this.searchSessions.get(tabId);
		if (!session) {
			// The tab may live in another pane, so every pane is searched.
			const tab = this.getAllTabs().find(t => t.id === tabId);
			if (tab?.searchSession) {
				session = tab.searchSession;
			} else {
				session = new SearchTabSession();
			}
			this.searchSessions.set(tabId, session);
			if (tab) {
				tab.searchSession = session;
			}
		}
		return session;
	}

	/**
	 * Open the project-wide search tab.
	 *
	 * The search tab is a singleton: the project has one search surface, so
	 * asking for it again focuses the existing tab instead of stacking a
	 * second one. It is a virtual tab, so it lives in a pane like any other
	 * tab but carries no document behind it.
	 *
	 * A query seeds the tab's session, so opening the search tab with a
	 * query shows that query.
	 */
	openSearchTab(query?: string): string {
		this.searchTabFocusNonce++;
		const existing = this.getAllTabs().find(t => t.id === SEARCH_TAB_ID || t.type === 'search');
		if (existing) {
			// The tab may live in another pane, so focus that pane rather than
			// pointing the active pane at a tab it does not hold.
			const pane = findPaneWithTab(this.layout, existing.id);
			if (pane) {
				this.activePaneId = pane.id;
				pane.activeTabId = existing.id;
			}
			if (query !== undefined) {
				const session = this.getSearchSession(existing.id);
				session.query = query;
			}
			return existing.id;
		}
		const session = new SearchTabSession({ query: query ?? '' });
		this.searchSessions.set(SEARCH_TAB_ID, session);
		this.tabs.push({ id: SEARCH_TAB_ID, type: 'search', searchSession: session });
		this.activeTabId = SEARCH_TAB_ID;
		return SEARCH_TAB_ID;
	}

	/**
	 * Open a Root as the current project.
	 *
	 * Returns whether the project changed. A cancelled picker, a denied
	 * permission and a failed destination load all leave the current project
	 * exactly as it was and report false; the failure reason, when there is
	 * one, lands in `projectError`.
	 *
	 * "Exactly as it was" covers the state that names the project: the
	 * settings attachment follows the Root, and the recent folders list
	 * names the Roots that were opened, so a failed open puts both back
	 * rather than leaving either pointing at a project that was never
	 * opened.
	 *
	 * Only one project mutation runs at a time: a second request while one
	 * is in flight is refused rather than interleaved.
	 */
	async openDirectory(specificOrigin?: FileOrigin): Promise<boolean> {
		if (this.projectMutationBusy) return false;
		this.projectOpening = true;
		this.projectError = null;
		if (this.restorePromise) {
			try {
				await this.restorePromise;
			} catch {
				// A failed session restore must not block opening a folder.
			}
		}
		const previous = {
			root: this.project.rootOrigin,
			repository: this.project.repository,
			repositoryOwnerId: this.project.repositoryOwnerId,
			permission: this.project.hasRootPermission,
			documents: this.documents,
			layout: this.layout,
			activePaneId: this.activePaneId,
			nodes: this.project.projectTree.nodes,
			searchQuery: this.project.projectTree.searchQuery,
			recentFolders: $state.snapshot(this.recentFolders)
		};
		let changed = false;
		// Whether the settings attachment has moved to the destination. The
		// attachment follows the Root, so a failed open has to move it back.
		let attachmentMoved = false;
		try {
			const origin = specificOrigin ?? await this.project.storage.pickDirectory();
			if (!origin) return false;
			if (!await this.project.storage.verifyPermission(origin, true)) {
				this.projectError = 'Permission denied. The current project is unchanged.';
				return false;
			}

			// Save the outgoing session before the project is replaced, so
			// switching back finds it.
			await this.flushSaveOpenFiles();
			await this.saveFolderState(this.projectUri);

			this.isRestoring = true;
			// The generation moves before anything asynchronous starts, so a
			// result that arrives for the outgoing project can tell that it
			// is stale.
			this.projectGeneration++;
			changed = true;

			this.project.rootOrigin = origin;
			this.project.hasRootPermission = true;
			// The settings attachment moves with the Root. It is marked as
			// moved before the call, so a failure inside the callback still
			// leaves the rollback able to move it back.
			attachmentMoved = true;
			await this.onRootOriginChange?.(origin);

			// Repository lifecycle is owned by feature plugins (#202)
			// through the generic workspace-opened hook: with the Git plugin
			// enabled this detects and refreshes; with it disabled the slot
			// stays null. The slot is cleared unconditionally so the UI never
			// shows stale branch/changes for the new folder. Explicit failure
			// decision (ADR 0013): a throwing hook is contained by the host
			// with plugin attribution, so when the owning hook fails the slot
			// stays in this safe empty state and open proceeds (tree scan,
			// session restore) instead of aborting or showing stale state.
			this.project.repository = null;
			this.project.repositoryOwnerId = null;
			await this.pluginHost.runWorkspaceOpened({ origin, workspace: this });

			// The outgoing project's documents and panes do not belong to the
			// incoming project; they are replaced by the destination's
			// session below.
			this.documents = [];
			const freshPane = new Pane();
			this.layout = freshPane;
			this.activePaneId = freshPane.id;

			// Add to recent folders
			this.recentFolders = [origin, ...this.recentFolders.filter(f => toURI(f) !== toURI(origin))].slice(0, 10);

			// Reset project tree expansion state
			this.project.projectTree.resetExpansionState();
			this.project.projectTree.searchQuery = '';

			await this.project.projectTree.scan(origin);

			// Load new folder state
			await this.loadFolderState(toURI(origin), true);
			this.cancelPendingClose();
			// The outgoing layout's tabs were replaced, not closed, so the
			// diagnostics session outlives them. Drop it now that the folder
			// change has succeeded: a filter the reader set in the old
			// folder must not hide diagnostics in the new one. A failed
			// open restores the old layout from `previous`, so the session
			// is only dropped on the success path.
			this.diagnosticsSessions.delete(DIAGNOSTICS_TAB_ID);
			return true;
		} catch (error) {
			if (changed) {
				this.project.rootOrigin = previous.root;
				this.project.repository = previous.repository;
				this.project.repositoryOwnerId = previous.repositoryOwnerId;
				this.project.hasRootPermission = previous.permission;
				// The restored root gets a fresh Worktree, and a fresh
				// Worktree publishes an empty snapshot. Rescan the restored
				// root so the project that is still open publishes its files
				// again instead of an empty set. The scan runs before the
				// tree's own state is put back, so the tree keeps the
				// content the open started from.
				if (previous.root && previous.permission) {
					try {
						await this.project.projectTree.scan(previous.root);
					} catch {
						// The open failure is the reason to report. A failure
						// to rescan the restored root does not change it.
					}
				}
				this.documents = previous.documents;
				this.layout = previous.layout;
				this.activePaneId = previous.activePaneId;
				this.project.projectTree.nodes = previous.nodes;
				this.project.projectTree.searchQuery = previous.searchQuery;
				this.project.projectTree.resetExpansionState();
				// The recent folders list names the Roots that were opened.
				// The destination was never opened, so it does not belong in
				// the list, and the list the open started from is the list
				// the window goes back to.
				this.recentFolders = previous.recentFolders;
				// The settings attachment followed the Root to the
				// destination, so it follows the Root back. The permission
				// is restored first, because the host reads it to decide
				// whether the settings of a Root can be attached at all.
				if (attachmentMoved) {
					try {
						await this.onRootOriginChange?.(previous.root);
					} catch {
						// The open failure is the reason to report. A failure
						// to put the settings back does not change it.
					}
				}
			}
			if (!(error instanceof Error && error.name === 'AbortError')) {
				this.projectError = `Failed to open folder: ${error instanceof Error ? error.message : String(error)}`;
			}
			return false;
		} finally {
			if (changed) this.isRestoring = false;
			this.projectOpening = false;
		}
	}

	async requestRootPermission() {
		if (!this.project.rootOrigin) return false;
		const granted = await this.project.storage.verifyPermission(this.project.rootOrigin, true);
		if (granted) {
			this.project.hasRootPermission = true;
			await this.onRootOriginChange?.(this.project.rootOrigin);

			// Repository lifecycle is plugin-owned (#202, see openDirectory):
			// clear unconditionally, then let the workspace-opened hook
			// detect and refresh when the owning plugin is enabled. A fresh
			// adapter is created per open, so no adapter reset is needed.
			this.project.repository = null;
			this.project.repositoryOwnerId = null;
			await this.pluginHost.runWorkspaceOpened({ origin: this.project.rootOrigin, workspace: this });
			this.applyPendingDiffRestore();

			await this.project.projectTree.scan(this.project.rootOrigin);

			// Refresh permissions for already open files
			for (const doc of this.documents) {
				if (doc.origin && this.project.coversOrigin(doc.origin)) {
					doc.markPermissionGranted();
				}
			}
		}
		return granted;
	}

	closeDocument(id: string) {
		this.closeTab(id);
	}

	async closeTab(id: string, paneId?: string) {
		const targetPane = paneId
			? this.findPane(paneId)
			: (this.activePane.tabs.some(t => t.id === id) ? this.activePane : this.findPaneWithTab(id));
		if (!targetPane) return;

		const tab = targetPane.tabs.find(t => t.id === id);
		if (!tab) return;

		const docId = tab.docId ?? tab.id;
		const totalDocTabs = this.countTabsForDocument(docId);

		// The save/discard prompt fires only when the last tab referencing a session closes.
		// Closing a cloned tab while the session lives on elsewhere closes silently.
	if (totalDocTabs <= 1 && tab.type === 'document') {
			const doc = this.documents.find(d => d.id === docId);
			if (doc && doc.isModified) {
				this.pendingCloseQueue = [];
				this.pendingCloseId = id;
				return;
			}
		}

		await this.finalizeClose(id, false, targetPane.id).catch((err) => {
			console.error('[Workspace] Failed to close tab', err);
		});
	}

	async finalizeClose(
		id: string,
		saveFirst = false,
		paneId?: string,
		applyToRemaining = false
	): Promise<boolean> {
		const targetPane = paneId
			? this.findPane(paneId)
			: (this.activePane.tabs.some(t => t.id === id) ? this.activePane : this.findPaneWithTab(id));
		if (!targetPane) return false;

		const tab = targetPane.tabs.find(t => t.id === id);
		if (!tab) return false;

		const docId = tab.docId ?? tab.id;
		const totalDocTabs = this.countTabsForDocument(docId);

		if (applyToRemaining) {
			const queue = [...this.pendingCloseQueue];
			this.pendingCloseQueue = [];
			this.pendingCloseId = null;

			const allClosing = [{ tabId: id, paneId: targetPane.id }, ...queue];

			if (saveFirst) {
				const docsToSave = new Set<DocumentSession>();
				for (const item of allClosing) {
					const itemPane = item.paneId ? this.findPane(item.paneId) : this.findPaneWithTab(item.tabId);
					const itemTab = itemPane?.tabs.find(t => t.id === item.tabId);
					if (itemTab && itemTab.type === 'document') {
						const itemDocId = itemTab.docId ?? itemTab.id;
						const itemDoc = this.documents.find(d => d.id === itemDocId);
						if (itemDoc && itemDoc.isModified) {
							docsToSave.add(itemDoc);
						}
					}
				}
				for (const doc of docsToSave) {
					try {
						await this.saveDocument(doc);
					} catch (err) {
						console.error('[Workspace] Save before close failed for queued tab', err);
					}
				}
			}

			await this.performCloseBatch(allClosing);
			return true;
		}

		let saved = true;
		if (totalDocTabs <= 1 && tab.type === 'document') {
			const doc = this.documents.find(d => d.id === docId);
			if (doc && saveFirst) {
				try {
					saved = await this.saveDocument(doc);
					if (!saved) {
						this.cancelPendingClose();
						return false;
					}
				} catch (err) {
					console.error('[Workspace] Save before close failed', err);
					this.cancelPendingClose();
					return false;
				}
			}
		}

		await this.performClose(id, targetPane.id);

		if (this.pendingCloseQueue.length > 0) {
			const next = this.pendingCloseQueue.shift()!;
			this.pendingCloseId = next.tabId;
		} else {
			this.pendingCloseId = null;
		}

		return true;
	}

	/**
	 * Close multiple tabs across panes in a single batch update.
	 *
	 * Avoids intermediate activeTabId churn and per-tab reactive updates
	 * by filtering closed tabs and documents in bulk and setting activeTabId
	 * only once per affected pane.
	 */
	async performCloseBatch(items: { tabId: string; paneId?: string }[]) {
		if (items.length === 0) return;

		const itemsByPane = new Map<Pane, string[]>();
		for (const item of items) {
			const targetPane = item.paneId
				? this.findPane(item.paneId)
				: (this.activePane.tabs.some(t => t.id === item.tabId) ? this.activePane : this.findPaneWithTab(item.tabId));
			if (!targetPane) continue;
			let list = itemsByPane.get(targetPane);
			if (!list) {
				list = [];
				itemsByPane.set(targetPane, list);
			}
			list.push(item.tabId);
		}

		if (itemsByPane.size === 0) return;

		for (const [pane, tabIds] of itemsByPane) {
			const idSet = new Set(tabIds);
			for (const tab of pane.tabs) {
				if (!idSet.has(tab.id)) continue;
				const docId = tab.docId ?? tab.id;
				const doc = tab.type === 'document' ? this.documents.find(d => d.id === docId) : undefined;
				this.closedTabs.push({ tab, paneId: pane.id, doc });
				if (tab.type === 'search') {
					this.searchSessions.delete(tab.id);
				}
				// A closed diagnostics tab takes its session with it: the filter belongs
				// to the tab that is open, and a reopened tab is a new tab.
				if (tab.type === 'diagnostics') {
					this.diagnosticsSessions.delete(tab.id);
				}
			}
		}

		if (this.closedTabs.length > Workspace.MAX_CLOSED_TABS) {
			this.closedTabs.splice(0, this.closedTabs.length - Workspace.MAX_CLOSED_TABS);
		}

		const deadPanes: Pane[] = [];
		for (const [pane, tabIds] of itemsByPane) {
			const idSet = new Set(tabIds);
			const activeIndex = pane.tabs.findIndex(t => t.id === pane.activeTabId);
			const activeIsClosed = idSet.has(pane.activeTabId);

			pane.tabs = pane.tabs.filter(t => !idSet.has(t.id));

			if (pane.tabs.length > 0) {
				if (activeIsClosed || !pane.activeTabId) {
					const newIndex = Math.min(pane.tabs.length - 1, Math.max(0, activeIndex - 1));
					pane.activeTabId = pane.tabs[newIndex]?.id ?? '';
				}
			} else {
				deadPanes.push(pane);
			}
		}

		const remainingDocIds = new Set<string>();
		for (const p of this.getAllPanes()) {
			for (const t of p.tabs) {
				remainingDocIds.add(t.docId ?? t.id);
			}
		}
		this.documents = this.documents.filter(d => remainingDocIds.has(d.id));

		for (const targetPane of deadPanes) {
			const allPanes = this.getAllPanes();
			if (allPanes.length > 1) {
				const result = removePane(this.layout, targetPane.id);
				if (result) {
					this.layout = result.newRoot;
					if (this.activePaneId === targetPane.id) {
						this.activePaneId = result.neighborId ?? this.getAllPanes()[0]?.id ?? '';
					}
				}
			} else {
				targetPane.activeTabId = '';
			}
		}

		this.debouncedSaveOpenFiles();
	}

	/**
	 * Close a tab without asking, in the pane that holds it.
	 */
	async performClose(id: string, paneId?: string) {
		await this.performCloseBatch([{ tabId: id, paneId }]);
	}

	/**
	 * The tabs of one pane, in tab-strip order. Defaults to the active
	 * pane, so the pane-scoped tab commands need no caller-side pane
	 * resolution. The returned array is a copy: closing mutates the pane.
	 */
	getPaneTabs(paneId?: string): WorkspaceTab[] {
		const pane = paneId ? this.findPane(paneId) ?? this.activePane : this.activePane;
		return pane ? [...pane.tabs] : [];
	}

	/**
	 * True when closing a tab loses nothing: the Document behind it is not
	 * modified, and a search tab holds no unsaved work while none of the
	 * files its results show is modified.
	 */
	isTabClean(tab: WorkspaceTab): boolean {
		if (tab.type === 'search') {
			const session = tab.searchSession;
			if (!session) return true;
			const dirtyUris = new Set(
				this.documents
					.filter((d) => d.isModified)
					.map((d) => (d.origin ? toURI(d.origin) : null))
					.filter((uri): uri is string => !!uri)
			);
			return !session.resultUris.some((uri) => dirtyUris.has(uri));
		}
		const docId = tab.docId ?? tab.id;
		const doc = this.documents.find((d) => d.id === docId);
		return !doc?.isModified;
	}

	private async closeTabsBatch(tabs: WorkspaceTab[], paneId?: string): Promise<void> {
		const pane = paneId ? this.findPane(paneId) : this.activePane;
		if (!pane) return;

		const cleanTabs: WorkspaceTab[] = [];
		const dirtyTabs: WorkspaceTab[] = [];

		for (const tab of tabs) {
			if (this.isTabClean(tab)) {
				cleanTabs.push(tab);
			} else {
				dirtyTabs.push(tab);
			}
		}

		if (cleanTabs.length > 0) {
			await this.performCloseBatch(cleanTabs.map(t => ({ tabId: t.id, paneId: pane.id })));
		}

		const uniqueDirtyTabs: WorkspaceTab[] = [];
		const duplicateTabs: { tabId: string; paneId: string }[] = [];
		const seenDocIds = new Set<string>();

		for (const tab of dirtyTabs) {
			const docId = tab.docId ?? tab.id;
			if (seenDocIds.has(docId)) {
				duplicateTabs.push({ tabId: tab.id, paneId: pane.id });
			} else {
				seenDocIds.add(docId);
				uniqueDirtyTabs.push(tab);
			}
		}

		if (duplicateTabs.length > 0) {
			await this.performCloseBatch(duplicateTabs);
		}

		if (uniqueDirtyTabs.length === 0) {
			return;
		}

		this.pendingCloseId = uniqueDirtyTabs[0].id;
		this.pendingCloseQueue = uniqueDirtyTabs.slice(1).map((t) => ({ tabId: t.id, paneId: pane.id }));
	}

	/**
	 * Close every tab of a pane (default: the active pane). Each tab goes
	 * through the normal ask/close path, so a dirty Document that is the last
	 * tab referencing its session still asks before discarding.
	 */
	async closeAllTabs(paneId?: string): Promise<void> {
		const pane = paneId ? this.findPane(paneId) : this.activePane;
		if (!pane) return;
		await this.closeTabsBatch(pane.tabs, pane.id);
	}

	/**
	 * Close every tab of a pane except the active one (default: the active
	 * pane). The active tab is the one the caller keeps, so it survives even
	 * while dirty.
	 */
	async closeOtherTabs(paneId?: string): Promise<void> {
		const pane = paneId ? this.findPane(paneId) : this.activePane;
		if (!pane) return;
		const tabs = pane.tabs.filter((t) => t.id !== pane.activeTabId);
		await this.closeTabsBatch(tabs, pane.id);
	}

	/**
	 * Close the clean tabs of a pane (default: the active pane) and keep the
	 * dirty ones: closing is never a reason to lose unsaved work.
	 */
	async closeCleanTabs(paneId?: string): Promise<void> {
		const pane = paneId ? this.findPane(paneId) : this.activePane;
		if (!pane) return;
		const clean = pane.tabs.filter((t) => this.isTabClean(t));
		await this.performCloseBatch(clean.map((t) => ({ tabId: t.id, paneId: pane.id })));
	}

	/**
	 * Close the tabs that host a multi-file surface — search results, diffs,
	 * diagnostics, and the LSP log view — in a pane (default: the active pane).
	 */
	async closeMultibufferTabs(paneId?: string): Promise<void> {
		const pane = paneId ? this.findPane(paneId) : this.activePane;
		if (!pane) return;
		const multi = pane.tabs.filter((t) => t.type === 'diff' || t.type === 'search' || t.type === 'diagnostics');
		await this.performCloseBatch(multi.map((t) => ({ tabId: t.id, paneId: pane.id })));
	}

	/**
	 * Close the tabs to the left of the pane's active tab (default: the
	 * active pane). Left means the earlier half of the tab strip, right the
	 * later half.
	 */
	async closeTabsToLeft(paneId?: string): Promise<void> {
		const pane = paneId ? this.findPane(paneId) : this.activePane;
		if (!pane) return;
		const activeIndex = pane.tabs.findIndex((t) => t.id === pane.activeTabId);
		if (activeIndex === -1) return;
		const tabs = pane.tabs.slice(0, activeIndex);
		await this.closeTabsBatch(tabs, pane.id);
	}

	/**
	 * Close the tabs to the right of the pane's active tab (default: the
	 * active pane).
	 */
	async closeTabsToRight(paneId?: string): Promise<void> {
		const pane = paneId ? this.findPane(paneId) : this.activePane;
		if (!pane) return;
		const activeIndex = pane.tabs.findIndex((t) => t.id === pane.activeTabId);
		if (activeIndex === -1) return;
		const tabs = pane.tabs.slice(activeIndex + 1);
		await this.closeTabsBatch(tabs, pane.id);
	}

	/**
	 * Reopen the most recently closed tab, returning it to the pane that
	 * held it. No-op when there is nothing left to reopen.
	 */
	reopenClosedTab(): boolean {
		const entry = this.closedTabs.pop();
		if (!entry) return false;
		const pane = this.findPane(entry.paneId) ?? this.activePane;
		if (!pane) return false;

		if (entry.doc && !this.documents.some((d) => d.id === entry.doc!.id)) {
			this.documents.push(entry.doc);
			this.pluginHost?.emit('document:opened', { document: entry.doc, origin: entry.doc.origin });
		}
		if (entry.tab.type === 'search' && entry.tab.searchSession) {
			this.searchSessions.set(entry.tab.id, entry.tab.searchSession);
		}

		pane.tabs.push(entry.tab);
		pane.activeTabId = entry.tab.id;
		this.debouncedSaveOpenFiles();
		return true;
	}

	/**
	 * Preflight for a branch switch: what would be lost by switching now.
	 *
	 * The report is computed against the captured project identity and is
	 * discarded when the project changed while the preflight was running:
	 * a report about the previous project must not gate the next one.
	 */
	async getBranchSafetyReport(targetBranch: string, target = this.captureProject()): Promise<RepositorySafetyReport | null> {
		if (!target.repository || !this.isCurrentProject(target) || this.projectMutationBusy) return null;
		if (!this.isRepositoryActive) return null;

		const modifiedFiles = await Promise.all(
			this.documents
				.filter(doc => doc.isModified)
				.map(async doc => {
					if (doc.origin) {
						const rel = this.project.relativePath(doc.origin);
						if (rel !== null) return rel;
					}
					return doc.fileName;
				})
		);

		if (!this.isCurrentProject(target) || this.projectMutationBusy) return null;
		const report = await target.repository.getSafetyReport(modifiedFiles, targetBranch);
		return this.isCurrentProject(target) && !this.projectMutationBusy ? report : null;
	}

	/**
	 * Switch the current project's repository to another branch.
	 *
	 * The captured project identity is checked before and after the switch:
	 * a switch requested for one project and landing after the user moved to
	 * another is refused rather than applied to the wrong project.
	 */
	async switchBranch(branchName: string, target = this.captureProject()): Promise<SwitchResult> {
		if (!this.isCurrentProject(target)) {
			return { status: 'error', message: 'Project changed. Select the branch again.' };
		}
		if (!target.repository || !this.project.rootOrigin || !this.isRepositoryActive) {
			return { status: 'error', message: 'No repository' };
		}
		if (this.projectMutationBusy) return { status: 'error', message: 'Another project or repository operation is running.' };
		this.branchSwitching = true;
		try {
			const result = await target.repository.switchBranch(branchName);
			if (!this.isCurrentProject(target)) return { status: 'error', message: 'Project changed.' };

			
			if (result.status === 'switched' || result.status === 'noop') {
				// Full reload after branch switch
				await this.project.projectTree.scan(this.project.rootOrigin);
				
				for (const doc of this.documents) {
					if (doc.origin) {
						try {
							if (doc.isModified) {
								// Preserve unsaved in-memory edits: rebase the saved
								// baseline onto the checked-out content instead of
								// silently discarding it via loadContent().
								await doc.rebaseSavedBaseline();
							} else {
								await doc.loadContent();
							}
						} catch (e) {
							// Ignored here; loadContent/rebaseSavedBaseline handle setting deletedOnDisk to true
						}
					}
				}
			}
			return result;
		} catch (e: any) {
			console.error('Failed to switch branch', e);
			return { status: 'error', message: e.message || 'Failed to switch branch' };
		} finally {
			this.branchSwitching = false;
		}
	}

	/**
	 * Shared marking path for deleted-on-disk tabs. Sets `deletedOnDisk`
	 * without touching content, baselines, or tab membership, so in-memory
	 * edits survive and nothing auto-closes. Directory deletes cover
	 * descendants too (path-prefix match). Used by in-app deletes (#173)
	 * and external-delete reconciliation (#175). Bumping the document's
	 * baseline seq (via `markDeletedOnDisk`) also drops a stale restore read,
	 * so a delete that lands mid-restore cannot have its flag cleared.
	 * Schedules one debounced session flush when any flag transitions
	 * false→true, so persistence captures the deletion draft; no-ops
	 * schedule nothing.
	 */
	markDocumentsDeleted(deletedOrigin: FileOrigin): void {
		const deletedPath = deletedOrigin.path;
		const deletedScheme = deletedOrigin.scheme;
		let changed = false;
		for (const doc of this.documents) {
			const origin = doc.origin;
			if (!origin || origin.scheme !== deletedScheme) continue;
			if (origin.path === deletedPath || origin.path.startsWith(deletedPath + '/')) {
				if (!doc.deletedOnDisk) {
					changed = true;
				}
				// Always bump the baseline seq (even when already deleted)
				// so a delete landing mid-restore drops the stale read;
				// flush scheduling below stays transition-only.
				doc.markDeletedOnDisk();
			}
		}
		if (changed) {
			this.debouncedSaveOpenFiles();
		}
	}

	/**
	 * Surface externally deleted open files as deleted-on-disk tabs, on the
	 * next refresh/focus/scan. Probes each open document against storage: a
	 * NotFound read reuses the in-app marking path; a successful read on a
	 * stale flag restores via the guarded `loadContent` baseline operation,
	 * which refreshes the saved baseline, replaces content only when clean,
	 * and drops reads made stale by a concurrent delete or save. Dirty
	 * in-memory edits are preserved. Other read errors (permissions, etc.)
	 * leave state alone. Each flag transition schedules one debounced
	 * session flush.
	 */
	async reconcileExternalDeletions(): Promise<void> {
		for (const doc of [...this.documents]) {
			const origin = doc.origin;
			if (!origin) continue;
			if (doc.deletedOnDisk) {
				try {
					await doc.loadContent();
				} catch (e: any) {
					if (isNotFoundError(e)) {
						// Still missing: flag stays set (loadContent re-marks
						// on NotFound). No transition, so no flush.
						continue;
					}
					// Other read errors leave state alone.
					continue;
				}
				if (!doc.deletedOnDisk) {
					this.debouncedSaveOpenFiles();
				}
				continue;
			}
			const before = doc.deletedOnDisk;
			await doc.probeDeletedOnDisk();
			if (!before && doc.deletedOnDisk) {
				this.debouncedSaveOpenFiles();
			}
		}
	}



	async saveFolderState(folderUri: string) {
		const serializedDocs = this.serializeWorkspace();

		await this.project.saveOpenFiles(serializedDocs, folderUri);
		await this.project.saveActiveDocumentId(this.activeTabId, folderUri);
	}

	async loadFolderState(folderUri: string, strict = false) {
		this.pendingDiffRestore.clear();
		try {
			const origins = await this.project.loadOpenFiles(folderUri);
			const activeId = await this.project.loadActiveDocumentId(folderUri);

			// Version-key check: on version mismatch, start fresh (empty). No migration code.
			// Old state was a bare array with no version; it loads as before.
			const workspace: SerializedWorkspace = ('docs' in (origins as any) && Array.isArray((origins as SerializedWorkspace).docs))
				? (origins as SerializedWorkspace)
				: { version: WORKSPACE_PERSISTENCE_VERSION, docs: origins as SerializedDocument[] };
			if (workspace.version !== WORKSPACE_PERSISTENCE_VERSION) {
				this.documents = [];
				const freshPane = new Pane();
				this.layout = freshPane;
				this.activePaneId = freshPane.id;
				return;
			}

			const docs = workspace.docs;
			if (docs && docs.length > 0) {
				const restoredDocs: DocumentSession[] = [];
				const restoredTabs: WorkspaceTab[] = [];
				for (const serialized of docs) {
					const isNewSchema = serialized && typeof serialized === 'object' && ('id' in serialized);
					if (!isNewSchema) {
						// Stale / old shape mismatch: skip (no migration code)
						continue;
					}
					if (serialized.version !== undefined && serialized.version !== WORKSPACE_PERSISTENCE_VERSION) {
						continue;
					}

					let doc: DocumentSession | null = null;
					if (serialized.virtualTabType === 'search') {
						// The query and its options are restored with the tab, so a
						// restart brings back the search the user left.
						const session = new SearchTabSession({
							query: serialized.searchQuery ?? '',
							isRegex: serialized.searchIsRegex ?? false,
							caseSensitive: serialized.searchCaseSensitive ?? false,
							wholeWord: serialized.searchWholeWord ?? false,
							includePattern: serialized.searchIncludePattern ?? '',
							excludePattern: serialized.searchExcludePattern ?? ''
						});
						this.searchSessions.set(serialized.id, session);
						restoredTabs.push({
							id: serialized.id,
							type: 'search',
							searchSession: session
						});
						continue;
					}
					if (serialized.virtualTabType === 'diff') {
						if (!serialized.pluginId || !this.pluginHost.isPluginActive(serialized.pluginId)) {
							continue;
						}
						restoredTabs.push({
							id: serialized.id,
							type: 'diff',
							canSplit: false,
							...(serialized.pluginId ? { pluginId: serialized.pluginId } : {})
						});
						if (serialized.diffFilepath) {
							this.pendingDiffRestore.set(serialized.id, {
								filepath: serialized.diffFilepath,
								staged: serialized.diffStaged
							});
						}
						continue;
					}

					doc = new DocumentSession(
						this.project.storage,
						'',
						serialized.origin,
						serialized.untitledTitle || 'Untitled'
					);
					doc.id = serialized.id as any;
					if (serialized.deletedOnDisk) {
						doc.deletedOnDisk = true;
					}
					if (serialized.origin) {
						doc.refreshPermissionState(this.project.coversOrigin(serialized.origin));
					}
					if (serialized.draftContent !== undefined) {
						doc.restoreDraft(serialized.draftContent);
					}
					restoredDocs.push(doc);
					// Tab-less bound Documents (issue #272) restore their draft
					// text without opening a tab; the Diff Viewer rebinds them
					// by URI when its diff loads.
					if (serialized.tabless) continue;
					restoredTabs.push({
						id: doc.id,
						type: 'document'
					});
				}

				this.documents = restoredDocs;
				const rootPane = new Pane(
					restoredTabs,
					activeId && restoredTabs.some(t => t.id === activeId) ? activeId : (restoredTabs[0]?.id || '')
				);
				this.layout = rootPane;
				this.activePaneId = rootPane.id;

				for (const restored of restoredDocs) {
					this.pluginHost?.emit('document:opened', {
						document: restored,
						origin: restored.origin
					});
				}
				if (restoredTabs.length === 0) {
					await this.newFile();
				}
				this.applyPendingDiffRestore();
			} else {
				this.documents = [];
				const freshPane = new Pane();
				this.layout = freshPane;
				this.activePaneId = freshPane.id;
				await this.newFile();
			}
		} catch (e) {
			if (strict) throw e;
			console.error('[Workspace] Failed to load folder state', e);
			this.pendingDiffRestore.clear();
			this.documents = [];
			const freshPane = new Pane();
			this.layout = freshPane;
			this.activePaneId = freshPane.id;
			await this.newFile();
		}
	}

	restoreSession(force = false): Promise<void> {
		if (!force && this.restorePromise) {
			return this.restorePromise;
		}

		const previousPromise = this.restorePromise;
		this.isRestoring = true;
		const currentRestoreId = ++this.latestRestoreId;

		const currentPromise = (async () => {
			if (previousPromise) {
				try {
					await previousPromise;
				} catch {
					// Ignore failures from previous restore attempts
				}
			}

			try {
				// NOTE (#254): root-folder + recent-folders load reads
				// window-scoped but is per-folder-ambiguous; correct with one
				// Project, revisitable when a second Project exists. Left in
				// place by design — no key change.
				const all = await this.project.persistence.loadAll();
				
				const rootOrigin: FileOrigin | null = all.rootFolder || null;
				const recentFolders: FileOrigin[] = all.recentFolders || [];
				
				this.recentFolders = recentFolders;

				if (rootOrigin) {
					this.project.rootOrigin = rootOrigin;
					const restoreUri = toURI(rootOrigin);
					const restoreGeneration = this.projectGeneration;

					const permission = await this.project.storage.queryPermission(rootOrigin, true);

					if (permission === 'granted') {
						this.project.hasRootPermission = true;
						await this.onRootOriginChange?.(rootOrigin);
						// Initialize repo and tree in background
						(async () => {
							try {
								// The folder may have changed while the restore was
								// waiting: a repository or a tree published for the
								// restored folder would be stale state for a project
								// that is no longer current.
								if (this.projectGeneration !== restoreGeneration || this.projectUri !== restoreUri) return;
								// Drop the previous session's repository before the
								// plugin-owned probe so the UI never shows stale
								// state. Detection/refresh run through the generic
								// workspace-opened hook (#202).
								this.project.repository = null;
								this.project.repositoryOwnerId = null;
								await this.pluginHost.runWorkspaceOpened({
									origin: rootOrigin!,
									workspace: this
								});
								if (this.projectGeneration !== restoreGeneration || this.projectUri !== restoreUri) return;
								// Session restore loads tabs before the repo exists;
								// re-apply the persisted diff selection once changes are in.
								this.applyPendingDiffRestore();
								await this.project.projectTree.scan(rootOrigin!);
								if (this.projectGeneration !== restoreGeneration || this.projectUri !== restoreUri) {
									const current = this.project.rootOrigin;
									if (current && this.project.hasRootPermission) {
										await this.project.projectTree.scan(current);
									}
								}

							} catch (e: any) {
								console.error('[Workspace] Failed to initialize repo/tree during restore:', e);
							}
						})();
					} else {
						this.project.hasRootPermission = false;
					}
				}

				// Load namespaced state for the restored folder URI
				const folderUri = rootOrigin ? toURI(rootOrigin) : '';
				await this.loadFolderState(folderUri);

			} catch (e) {
				console.error('[Workspace] Failed to restore session', e);
				this.documents = [];
				const freshPane = new Pane();
				this.layout = freshPane;
				this.activePaneId = freshPane.id;
				await this.newFile();
			} finally {
				if (this.latestRestoreId === currentRestoreId) {
					this.isRestoring = false;
				}
			}
		})();

		this.restorePromise = currentPromise;
		return currentPromise;
	}

	dispose(): void {
		this.project.dispose();
	}
}
