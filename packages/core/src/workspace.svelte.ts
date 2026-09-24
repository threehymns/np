import { PluginHost } from './plugins/host.svelte';
import type { PluginHostInterface } from './plugins/types';
import { untrack } from 'svelte';
import { DocumentSession } from './document.svelte';
import { type Storage, type FileOrigin, toURI, toSuggestedSaveName } from './storage';
import { isNotFoundError } from './utils';
import { ProjectTree } from './project/tree.svelte';
import { Repository, type RepositorySafetyReport } from './project/repository.svelte';
import { type SessionPersistence, type SerializedDocument } from './persistence';
import type { SwitchResult, VCSAdapter } from './project/vcs';

export interface WorkspaceTab {
	id: string;
	type: 'document' | 'diff';
}

export class Workspace {
	documents = $state<DocumentSession[]>([]);
	tabs = $state<WorkspaceTab[]>([]);
	activeTabId = $state<string>('');
	pendingCloseId = $state<string | null>(null);
	rootOrigin = $state<FileOrigin | null>(null);
	repository = $state<Repository | null>(null);
	recentFolders = $state<FileOrigin[]>([]);
	projectTree = new ProjectTree(this);
	hasRootPermission = $state(false);
	pluginHost: PluginHostInterface;
	lastSaveCancellationReason = $state<string | null>(null);
	
	storage: Storage;
	vcsFactory: (rootOrigin: FileOrigin) => VCSAdapter;
	persistence: SessionPersistence;
	private untitledCounter = 0;
	private isRestoring = $state(true);
	private restorePromise: Promise<void> | null = null;
	private latestRestoreId = 0;

	private saveOpenFilesTimeout: any = null;

	/**
	 * Is this origin covered by the granted workspace root? Synchronous and
	 * side-effect free: the Workspace owns the root, so Documents never check
	 * this themselves — coverage travels to them as plain call-time data.
	 */
	coversOrigin(origin: FileOrigin): boolean {
		return this.relativePath(origin) !== null;
	}

	/**
	 * Path of `origin` relative to the granted workspace root, or null when
	 * not covered. Returns '' for the root itself. Single owner of the
	 * scheme + path-prefix rule so callers never re-implement it.
	 */
	relativePath(origin: FileOrigin): string | null {
		const rootOrigin = this.rootOrigin;
		if (!rootOrigin || !this.hasRootPermission) {
			return null;
		}
		if (origin.scheme !== rootOrigin.scheme) {
			return null;
		}
		if (origin.path === rootOrigin.path) {
			return '';
		}
		const normalizedRoot = rootOrigin.path.replace(/\/+$/, '');
		if (origin.path.startsWith(normalizedRoot + '/')) {
			return origin.path.slice(normalizedRoot.length + 1);
		}
		return null;
	}

	/**
	 * The keystroke path: set in-memory content and schedule a session flush.
	 * This is the only typing path — `Editor`, commands, and tests simulating
	 * keystrokes go through here. Direct `doc.content =` is passive (no flush)
	 * and reserved for state restores and isolated Document tests.
	 */
	updateDocumentContent(doc: DocumentSession, content: string): void {
		if (doc.content === content) return;
		doc.content = content;
		this.debouncedSaveOpenFiles();
	}

	/** Root fast-path first, storage verify second. Used by the permission overlay. */
	requestFilePermission(doc: DocumentSession): Promise<boolean> {
		if (!doc.origin) return Promise.resolve(true);
		return doc.requestPermission(this.coversOrigin(doc.origin));
	}

	/**
	 * The save path: run the Document's storage save with fresh root coverage,
	 * then refresh the repo and schedule a session flush on success. Prefer
	 * this over `doc.save` — a direct save leaves persistence holding a stale
	 * `draftContent` until some unrelated flush happens to clear it.
	 */
	private registerRepositoryRefreshHook() {
		this.pluginHost.registerAfterSaveHook('core:repository-refresh', async (context) => {
			if (context.success) {
				await this.repository?.refresh().catch((e) => console.error('Auto-refresh after save failed', e));
			}
		});
	}

	setPluginHost(host: PluginHostInterface) {
		this.pluginHost = host;
		this.registerRepositoryRefreshHook();
	}

	async saveDocument(doc: DocumentSession, options: { forceNewOrigin?: boolean } = {}): Promise<boolean> {
		this.pluginHost?.checkSaveReentry('saveDocument', 'beforeSave hook');

		if (this.pluginHost) {
			const beforeResult = await this.pluginHost.runBeforeSave({ document: doc, options });
			if (beforeResult.cancel) {
				this.lastSaveCancellationReason = beforeResult.reason ?? 'Save cancelled by plugin';
				return false;
			}
		}

		this.lastSaveCancellationReason = null;
		const covered = doc.origin ? this.coversOrigin(doc.origin) : false;
		const needsPicker = !doc.origin || options.forceNewOrigin;
		const ok = await doc.save({
			...options,
			coveredByRoot: covered,
			// Untitled (or Save As) opens the picker: root it at the workspace
			// folder and prefill the draft title. Falls back to a safe
			// filename with no directory when no folder is open.
			suggestedName: needsPicker ? toSuggestedSaveName(doc.fileName) : undefined,
			startDirectory: needsPicker ? this.rootOrigin : undefined
		});

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

	private applyPendingDiffRestore() {
		const repo = this.repository;
		if (!repo || this.pendingDiffRestore.size === 0) return;

		for (const [tabId, pending] of [...this.pendingDiffRestore]) {
			// The persisted tab is gone; drop its queued selection.
			if (!this.tabs.some(t => t.id === tabId)) {
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

	private serializeTabs(): SerializedDocument[] {
		return this.tabs.map(tab => {
			if (tab.type === 'diff') {
				const serialized: SerializedDocument = {
					id: tab.id,
					origin: null,
					virtualTabType: 'diff'
				};
				const active = this.repository?.activeDiffFile;
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
				return serialized;
			}
			const doc = this.documents.find(d => d.id === tab.id);
			if (!doc) return null;
			const serialized: SerializedDocument = {
				id: doc.id,
				origin: doc.origin ? $state.snapshot(doc.origin) : null,
				untitledTitle: doc.untitledTitle,
				deletedOnDisk: doc.deletedOnDisk ? true : undefined
			};
			if (doc.isModified || !doc.origin || doc.deletedOnDisk) {
				serialized.draftContent = doc.content;
			}
			return serialized;
		}).filter(Boolean) as SerializedDocument[];
	}

  async flushSaveOpenFiles(): Promise<void> {
		if (this.isRestoring) return;

		if (this.saveOpenFilesTimeout) {
			clearTimeout(this.saveOpenFilesTimeout);
			this.saveOpenFilesTimeout = null;
		}

		const folderUri = this.rootOrigin ? toURI(this.rootOrigin) : '';
		const serializedDocs = this.serializeTabs();

		await this.persistence.saveOpenFiles(serializedDocs, folderUri);
	}

	constructor(
		storage: Storage,
		vcsFactory: (rootOrigin: FileOrigin) => VCSAdapter,
		persistence: SessionPersistence,
		pluginHost?: PluginHostInterface
	) {
		this.storage = storage;
		this.vcsFactory = vcsFactory;
		this.persistence = persistence;
		this.pluginHost = pluginHost ?? new PluginHost();
		this.registerRepositoryRefreshHook();

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
				
				const _folderUri = this.rootOrigin ? toURI(this.rootOrigin) : '';
				const _tabs = this.tabs.map(t => t.id).join(',');
				const _docs = this.documents.map(d => `${d.id}:${d.origin ? toURI(d.origin) : d.untitledTitle}`).join(',');
				
				this.debouncedSaveOpenFiles();
			});

			$effect(() => {
				if (this.isRestoring) return;
				const folderUri = this.rootOrigin ? toURI(this.rootOrigin) : '';
				this.persistence.saveActiveDocumentId(this.activeTabId, folderUri);
				untrack(() => {
					void this.flushSaveOpenFiles().catch((e) => console.error('[Workspace] flushSaveOpenFiles failed', e));
				});
			});

			$effect(() => {
				if (this.isRestoring) return;
				// Persist root folder
				this.persistence.saveRootFolder(this.rootOrigin ? $state.snapshot(this.rootOrigin) : null);
			});

			$effect(() => {
				if (this.isRestoring) return;
				// Persist recent folders
				this.persistence.saveRecentFolders($state.snapshot(this.recentFolders));
			});
		});
	}

	get activeTab() {
		return this.tabs.find(t => t.id === this.activeTabId);
	}

	get activeDocument() {
		if (this.activeTab?.type === 'document') {
			return this.documents.find((doc) => doc.id === this.activeTabId);
		}
		return undefined;
	}

	get activeDocumentId() {
		return this.activeTabId;
	}

	set activeDocumentId(value: string) {
		this.activeTabId = value;
	}

	get currentBranch() {
		return this.repository?.currentBranch ?? null;
	}

	get branches() {
		return this.repository?.branches ?? [];
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
		const newDoc = new DocumentSession(this.storage, '', null, `Untitled ${this.untitledCounter}`);
		this.documents.push(newDoc);
		this.tabs.push({ id: newDoc.id, type: 'document' });
		this.activeTabId = newDoc.id;
		return newDoc;
	}

	async openFile(specificOrigin?: FileOrigin) {
		let origin: FileOrigin | null = null;

		if (specificOrigin) {
			origin = specificOrigin;
		} else {
			origin = await this.storage.pickFile();
		}

		if (!origin) return;

		// Check if already open
		const targetUri = toURI(origin);
		const existing = this.documents.find(d => d.origin && toURI(d.origin) === targetUri);
		if (existing) {
			this.activeTabId = existing.id;
			return existing;
		}

		const content = await this.storage.readFile(origin);
		const newDoc = new DocumentSession(this.storage, content, origin);
		newDoc.refreshPermissionState(this.coversOrigin(origin));
		this.documents.push(newDoc);
		this.tabs.push({ id: newDoc.id, type: 'document' });
		this.activeTabId = newDoc.id;
		return newDoc;
	}

	async openDirectory(specificOrigin?: FileOrigin) {
		let origin: FileOrigin | null = null;

		if (specificOrigin) {
			origin = specificOrigin;
		} else {
			origin = await this.storage.pickDirectory();
		}

		if (!origin) return;
		
		// Verify permission
		const granted = await this.storage.verifyPermission(origin, true);
		if (!granted) return;

		// Save old state
		await this.flushSaveOpenFiles();
		const oldFolderUri = this.rootOrigin ? toURI(this.rootOrigin) : '';
		await this.saveFolderState(oldFolderUri);

		this.isRestoring = true;

		try {
			this.rootOrigin = origin;
			this.hasRootPermission = true;

			// Drop the previous folder's repository before the async VCS probe so
			// the UI never shows stale branch/changes for the new folder.
			this.repository = null;
			const repo = new Repository(origin, this.vcsFactory);
			const detected = await repo.adapter.detect(origin.path);
			if (detected) {
				this.repository = repo;
				await repo.refresh();
			} else {
				// Not a git repository: keep repository null so the Git panel shows
				// its "No Git Repository" empty state instead of a dead panel.
				this.repository = null;
			}

			// Add to recent folders
			const newRecent = this.recentFolders.filter(f => toURI(f) !== toURI(origin!));
			this.recentFolders = [origin, ...newRecent].slice(0, 10);

			// Reset project tree expansion state
			this.projectTree.resetExpansionState();

			await this.projectTree.scan(origin);

			// Load new folder state
			const folderUri = toURI(origin);
			await this.loadFolderState(folderUri);
		} finally {
			this.isRestoring = false;
		}

		// Refresh permissions for already open files
		for (const doc of this.documents) {
			if (doc.origin && this.coversOrigin(doc.origin)) {
				doc.markPermissionGranted();
			}
		}
	}

	async requestRootPermission() {
		if (!this.rootOrigin) return false;
		const granted = await this.storage.verifyPermission(this.rootOrigin, true);
		if (granted) {
			this.hasRootPermission = true;

			// Drop any stale repository before the async VCS probe so the UI
			// never shows the previous folder's state while detecting.
			this.repository = null;
			const repo = new Repository(this.rootOrigin, this.vcsFactory);

			// Fresh start for the adapter
			const adapter = (repo as any).adapter;
			if (adapter && typeof adapter.reset === 'function') {
				adapter.reset();
			}

			const detected = await adapter.detect(this.rootOrigin.path);
			if (detected) {
				this.repository = repo;
				await repo.refresh();
				this.applyPendingDiffRestore();
			} else {
				this.repository = null;
			}

			await this.projectTree.scan(this.rootOrigin);

			// Refresh permissions for already open files
			for (const doc of this.documents) {
				if (doc.origin && this.coversOrigin(doc.origin)) {
					doc.markPermissionGranted();
				}
			}
		}
		return granted;
	}

	async initializeRepository(): Promise<boolean> {
		if (!this.rootOrigin || !this.hasRootPermission) {
			return false;
		}

		const targetOrigin = this.rootOrigin;
		const targetUri = toURI(targetOrigin);

		// Clear stale repository state before async initialization
		this.repository = null;

		let repo: Repository | null = null;
		try {
			repo = new Repository(targetOrigin, this.vcsFactory);
			const adapter = repo.adapter;

			if (!adapter.init || typeof adapter.init !== 'function') {
				throw new Error('VCS adapter does not support repository initialization');
			}

			await adapter.init(targetOrigin.path);

			// The folder may have switched while init was deferred; do not
			// publish results for an outdated folder.
			if (!this.rootOrigin || toURI(this.rootOrigin) !== targetUri) {
				return false;
			}

			this.repository = repo;
			const refreshed = await repo.refresh();
			if (!refreshed) {
				if (this.repository === repo) {
					this.repository = null;
				}
				return false;
			}
			if (!this.rootOrigin || toURI(this.rootOrigin) !== targetUri) {
				if (this.repository === repo) {
					this.repository = null;
				}
				return false;
			}
			await this.projectTree.scan(targetOrigin);
			if (!this.rootOrigin || toURI(this.rootOrigin) !== targetUri) {
				if (this.repository === repo) {
					this.repository = null;
				}
				return false;
			}
			return true;
		} catch (e) {
			if (!repo || this.repository === repo) {
				this.repository = null;
			}
			throw e;
		}
	}

	closeDocument(id: string) {
		this.closeTab(id);
	}

	closeTab(id: string) {
		const tab = this.tabs.find(t => t.id === id);
		if (!tab) return;

		if (tab.type === 'document') {
			const index = this.documents.findIndex(doc => doc.id === id);
			if (index !== -1) {
				const doc = this.documents[index];
				if (doc.isModified) {
					this.pendingCloseId = id;
					return;
				}
			}
		}

		this.finalizeClose(id);
	}

	finalizeClose(id: string, saveFirst = false) {
		const tab = this.tabs.find(t => t.id === id);
		if (!tab) return;

		if (tab.type === 'document') {
			const index = this.documents.findIndex(doc => doc.id === id);
			if (index !== -1) {
				const doc = this.documents[index];
				if (saveFirst) {
					this.saveDocument(doc).then(
						(saved) => {
							if (saved) {
								this.performClose(id);
							}
							this.pendingCloseId = null;
						},
						(err) => {
							console.error('[Workspace] Save before close failed', err);
							this.pendingCloseId = null;
						}
					);
					return;
				} else {
					this.performClose(id);
					this.pendingCloseId = null;
					return;
				}
			}
		}

		this.performClose(id);
		this.pendingCloseId = null;
	}

	private async performClose(id: string) {
		const tabIndex = this.tabs.findIndex(t => t.id === id);
		if (tabIndex === -1) return;

		const tab = this.tabs[tabIndex];

		if (tab.type === 'document') {
			const docIndex = this.documents.findIndex(doc => doc.id === id);
			if (docIndex !== -1) {
				this.documents.splice(docIndex, 1);
			}
		}

		this.tabs.splice(tabIndex, 1);

		if (this.tabs.length === 0) {
			await this.newFile();
		} else if (this.activeTabId === id) {
			this.activeTabId = this.tabs[Math.max(0, tabIndex - 1)].id;
		}
	}

	async getBranchSafetyReport(targetBranch: string): Promise<RepositorySafetyReport | null> {
		if (!this.repository) return null;
		
		const modifiedFiles = await Promise.all(
			this.documents
				.filter(doc => doc.isModified)
				.map(async doc => {
					if (doc.origin) {
						const rel = this.relativePath(doc.origin);
						if (rel !== null) return rel;
					}
					return doc.fileName;
				})
		);
			
		return await this.repository.getSafetyReport(modifiedFiles, targetBranch);
	}

	async switchBranch(branchName: string): Promise<SwitchResult> {
		if (!this.repository || !this.rootOrigin) {
			return { status: 'error', message: 'No repository' };
		}

		try {
			const result = await this.repository.switchBranch(branchName);
			
			if (result.status === 'switched' || result.status === 'noop') {
				// Full reload after branch switch
				await this.projectTree.scan(this.rootOrigin);
				
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
		const serializedDocs = this.serializeTabs();

		await this.persistence.saveOpenFiles(serializedDocs, folderUri);
		await this.persistence.saveActiveDocumentId(this.activeTabId, folderUri);
	}

	async loadFolderState(folderUri: string) {
		this.pendingDiffRestore.clear();
		try {
			const origins = await this.persistence.loadOpenFiles(folderUri);
			const activeId = await this.persistence.loadActiveDocumentId(folderUri);

			if (origins && origins.length > 0) {
				const restoredDocs: DocumentSession[] = [];
				const restoredTabs: WorkspaceTab[] = [];
				for (const serialized of origins) {
					const isNewSchema = serialized && typeof serialized === 'object' && ('id' in serialized);

					let doc: DocumentSession | null = null;
					if (isNewSchema) {
						if (serialized.virtualTabType === 'diff') {
							restoredTabs.push({
								id: serialized.id,
								type: 'diff'
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
							this.storage,
							'',
							serialized.origin,
							serialized.untitledTitle || 'Untitled'
						);
						doc.id = serialized.id as any;
						if (serialized.deletedOnDisk) {
							// Restores a previously persisted flag verbatim; this is
							// not a fresh delete, so no baseline seq bump. A
							// restoreDraft read that follows re-checks the disk and
							// clears it if the file is back.
							doc.deletedOnDisk = true;
						}
						if (serialized.origin) {
							doc.refreshPermissionState(this.coversOrigin(serialized.origin));
						}
						if (serialized.draftContent !== undefined) {
							doc.restoreDraft(serialized.draftContent);
						}
					} else {
						// Old schema compatibility
						const origin = serialized as unknown as FileOrigin;
						doc = new DocumentSession(this.storage, '', origin);
						doc.refreshPermissionState(this.coversOrigin(origin));
					}
					restoredDocs.push(doc);
					restoredTabs.push({
						id: doc.id,
						type: 'document'
					});
				}

				this.documents = restoredDocs;
				this.tabs = restoredTabs;
				if (activeId && restoredTabs.some(t => t.id === activeId)) {
					this.activeTabId = activeId;
				} else {
					this.activeTabId = restoredTabs[0]?.id || '';
				}
				// Repository already refreshed (folder-open path): apply now.
				this.applyPendingDiffRestore();
			} else {
				this.documents = [];
				this.tabs = [];
				await this.newFile();
			}
		} catch (e) {
			console.error('[Workspace] Failed to load folder state', e);
			this.pendingDiffRestore.clear();
			this.documents = [];
			this.tabs = [];
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
				const all = await this.persistence.loadAll();
				
				const rootOrigin: FileOrigin | null = all.rootFolder || null;
				const recentFolders: FileOrigin[] = all.recentFolders || [];
				
				this.recentFolders = recentFolders;

				if (rootOrigin) {
					this.rootOrigin = rootOrigin;

					const permission = await this.storage.queryPermission(rootOrigin, true);
					
					if (permission === 'granted') {
						this.hasRootPermission = true;
						// Initialize repo and tree in background
						(async () => {
							try {
								// Drop the previous session's repository before the async
								// VCS probe so the UI never shows stale state.
								this.repository = null;
								const repo = new Repository(rootOrigin!, this.vcsFactory);
								const detected = await repo.adapter.detect(rootOrigin!.path);
								if (detected) {
									this.repository = repo;
									await repo.refresh();
									// Session restore loads tabs before the repo exists;
									// re-apply the persisted diff selection once changes are in.
									this.applyPendingDiffRestore();
								} else {
									this.repository = null;
								}
								await this.projectTree.scan(rootOrigin!);
							} catch (e: any) {
								console.error('[Workspace] Failed to initialize repo/tree during restore:', e);
							}
						})();
					} else {
						this.hasRootPermission = false;
					}
				}

				// Load namespaced state for the restored folder URI
				const folderUri = rootOrigin ? toURI(rootOrigin) : '';
				await this.loadFolderState(folderUri);

			} catch (e) {
				console.error('[Workspace] Failed to restore session', e);
				this.documents = [];
				this.tabs = [];
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
}
