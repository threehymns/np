import { type Storage, type FileOrigin } from './storage';
import { DocumentDraft } from './draft.svelte';
import { LanguageSupport, allLanguages } from './editor/language.svelte';

export type PermissionState = 'granted' | 'prompt' | 'denied';

/**
 * Dependencies a Document accepts instead of reaching for its owner.
 * Each is a live probe or notification — never a snapshot — so Documents
 * constructed before a folder switch keep seeing current Workspace state.
 */
export interface DocumentDeps {
	/** Called when in-memory content changes (persistence scheduling). */
	onDirty?: () => void;
	/** Live probe: is this origin covered by the granted workspace root? */
	isUnderRoot?: (origin: FileOrigin) => boolean;
	/** Called after a successful save (post-save refresh lives here). */
	onSaved?: () => void;
}

export class DocumentSession {
	id = crypto.randomUUID();
	private _content = $state('');
	origin = $state.raw<FileOrigin | null>(null);
	untitledTitle = $state('Untitled');
	permissionState = $state<PermissionState>('granted');
	deletedOnDisk = $state(false);
	isLoaded = $state(false);
	pendingLineToScroll = $state<number | null>(null);
	editorState = $state.raw<any>(null);
	scrollPosition = $state.raw<{ top: number; left: number } | null>(null);
	
	private draft: DocumentDraft;
	private storage: Storage;
	private deps: DocumentDeps;

	constructor(storage: Storage, initialContent = '', origin: FileOrigin | null = null, untitledTitle = 'Untitled', deps: DocumentDeps = {}) {
		this.storage = storage;
		this._content = initialContent;
		this.origin = origin;
		this.untitledTitle = untitledTitle;
		this.deps = deps;
		this.draft = new DocumentDraft(initialContent, deps.onDirty ?? null);
		this.isLoaded = initialContent !== '' || origin === null;

		if (origin) {
			// Check initial permission state
			this.hasRootPermissionForFile().then(async hasRoot => {
				if (hasRoot) {
					this.permissionState = 'granted';
				} else {
					this.storage.queryPermission(origin, true).then(state => {
						this.permissionState = state;
					});
				}
			});
		}
	}

	get content() {
		return this._content;
	}

	set content(value: string) {
		if (this._content === value) return;
		this._content = value;
		this.draft.notifyEdited();
	}

	get fileName() {
		return this.origin?.name ?? this.untitledTitle;
	}

	get isModified() {
		return this.draft.isModified(this._content);
	}

	userLanguageOverride = $state<string | null>(null);

	language = $derived.by(() => {
		if (this.userLanguageOverride && this.userLanguageOverride !== "auto") {
			const found = allLanguages.find(l => l.name === this.userLanguageOverride);
			if (found) return found;
			if (this.userLanguageOverride === "Plain Text") return null;
		}
		return LanguageSupport.getLanguageForFile(this.fileName);
	});

	charCount = $derived(this._content.length);

	wordCount = $derived.by(() => {
		const text = this._content;
		let count = 0;
		let inWord = false;
		for (let i = 0; i < text.length; i++) {
			const char = text[i];
			// Using a simple check for whitespace characters
			if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
				if (inWord) {
					count++;
					inWord = false;
				}
			} else {
				inWord = true;
			}
		}
		if (inWord) count++;
		return count;
	});

	async loadContent() {
		if (!this.origin) return;
		try {
			const fileContent = await this.storage.readFile(this.origin);
			// Don't clobber keystrokes typed while the async read was in
			// flight: rebase the saved baseline and keep in-memory edits.
			this._content = this.draft.applyLoaded(fileContent, this._content);
			this.deletedOnDisk = false;
			this.isLoaded = true;
		} catch (e: any) {
			console.error(`Failed to load content for ${this.origin.name}`, e);
			if (e.name === 'NotFoundError' || e.code === 'ENOENT') {
				this.deletedOnDisk = true;
			}
			throw e;
		}
	}

	/**
	 * Rebase the saved baseline onto the current on-disk content without
	 * discarding in-memory edits. `content` (and therefore `isModified`) is left
	 * untouched; only the saved baseline, `deletedOnDisk`, and `isLoaded` reflect the
	 * new baseline. Used after an operation that changes files on disk (e.g. a
	 * branch switch) so unsaved in-memory edits survive and are re-diffed against
	 * the checked-out content instead of being silently overwritten.
	 */
	async rebaseSavedBaseline(): Promise<void> {
		if (!this.origin) return;
		try {
			this.draft.applyRebased(await this.storage.readFile(this.origin));
			this.deletedOnDisk = false;
			this.isLoaded = true;
		} catch (e: any) {
			if (e.name === 'NotFoundError' || e.code === 'ENOENT') {
				// Expected when the file was removed on the checked-out branch;
				// not an error worth logging.
				this.deletedOnDisk = true;
			} else {
				console.error(`Failed to rebase saved baseline for ${this.origin.name}`, e);
			}
			throw e;
		}
	}

	async hasRootPermissionForFile(): Promise<boolean> {
		if (!this.origin) {
			return false;
		}
		return this.deps.isUnderRoot?.(this.origin) ?? false;
	}

	async requestPermission() {
		if (!this.origin) return true;
		if (await this.hasRootPermissionForFile()) {
			this.permissionState = 'granted';
			return true;
		}
		const granted = await this.storage.verifyPermission(this.origin, true);
		this.permissionState = granted ? 'granted' : 'denied';
		if (granted && !this._content && this.draft.baselineIsEmpty) {
			await this.loadContent();
		}
		return granted;
	}

	async save(options: { forceNewOrigin?: boolean } = {}) {
		if (this.origin && !options.forceNewOrigin) {
			const hasPermission = await this.requestPermission();
			if (!hasPermission) return false;
		}

		const targetOrigin = options.forceNewOrigin ? undefined : (this.origin ?? undefined);
		const contentToSave = this._content;
		const newOrigin = await this.storage.saveFile(contentToSave, targetOrigin);
		if (newOrigin) {
			this.origin = newOrigin;
			this.draft.markSaved(contentToSave);
			this.permissionState = 'granted';
			this.deletedOnDisk = false;
			this.deps.onSaved?.();
			return true;
		}
		return false;
	}

	restoreDraft(draftContent: string) {
		this._content = draftContent;
		this.isLoaded = true;
		if (this.origin) {
			// An empty draft matches the fresh saved baseline while the
			// disk read is pending, which would read as unmodified and let an
			// immediate workspace flush omit the deletion draft. Stay dirty
			// until the baseline loads; keep dirty if the read fails.
			this.draft.beginBaselineWait();
			this.storage.readFile(this.origin).then(
				(saved) => {
					this.draft.resolveBaseline(saved);
				},
				(err) => {
					console.error(`Failed to load saved content for draft: ${this.origin?.name}`, err);
				}
			);
		}
	}
}
