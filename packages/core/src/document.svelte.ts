import { type Storage, type FileOrigin, toURI } from './storage';
import { LanguageSupport, allLanguages } from './editor/language.svelte';

export type PermissionState = 'granted' | 'prompt' | 'denied';

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

	private savedBaseline = $state('');
	private baselinePending = $state(false);
	private storage: Storage;
	private saveEpoch = 0;
	private permissionSeq = 0;
	private baselineSeq = 0;

	constructor(storage: Storage, initialContent = '', origin: FileOrigin | null = null, untitledTitle = 'Untitled') {
		this.storage = storage;
		this._content = initialContent;
		this.savedBaseline = initialContent;
		this.origin = origin;
		this.untitledTitle = untitledTitle;
		this.isLoaded = initialContent !== '' || origin === null;
		// Safe default: a file-backed Document starts untrusted until the
		// Workspace upgrades it via refreshPermissionState(). Untitled docs
		// have no origin to guard, so they stay granted.
		if (origin) {
			this.permissionState = 'prompt';
		}
	}

	get content() {
		return this._content;
	}

	/**
	 * Passive content write: updates in-memory state only and never schedules
	 * persistence. The keystroke path must go via
	 * `Workspace.updateDocumentContent`, which sets this and schedules a
	 * session flush in one place. Direct assignment is for state restores and
	 * isolated Document tests only.
	 */
	set content(value: string) {
		if (this._content === value) return;
		this._content = value;
	}

	get fileName() {
		return this.origin?.name ?? this.untitledTitle;
	}

	get isModified() {
		return this.baselinePending || this._content !== this.savedBaseline;
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
		const readOrigin = this.origin;
		const readURI = toURI(readOrigin);
		const readSaveEpoch = this.saveEpoch;
		try {
			const fileContent = await this.storage.readFile(readOrigin);
			// Drop stale reads: a concurrent save (or save-as origin change)
			// makes the in-flight content obsolete. Origins are plain data
			// and may be re-created with equal values, so compare by value
			// (URI), not reference. Edits alone still use the keepEdits path
			// below, so concurrent keystrokes are preserved while a
			// concurrent save never gets clobbered.
			if (!this.origin || toURI(this.origin) !== readURI) return;
			if (this.saveEpoch !== readSaveEpoch) return;
			// Don't clobber keystrokes typed while the async read was in
			// flight: rebase the saved baseline and keep in-memory edits.
			const keepEdits = this.isModified;
			const current = this._content;
			this.savedBaseline = fileContent;
			this._content = keepEdits ? current : fileContent;
			this.deletedOnDisk = false;
			this.isLoaded = true;
		} catch (e: any) {
			if (!this.origin || toURI(this.origin) !== readURI) throw e;
			if (this.saveEpoch !== readSaveEpoch) throw e;
			console.error(`Failed to load content for ${readOrigin.name}`, e);
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
		const readOrigin = this.origin;
		const readURI = toURI(readOrigin);
		const readSaveEpoch = this.saveEpoch;
		try {
			const diskContent = await this.storage.readFile(readOrigin);
			// Same stale-read guard as loadContent: a concurrent save
			// established a fresher baseline while this read was in flight,
			// so applying it would resurrect a phantom modification.
			if (!this.origin || toURI(this.origin) !== readURI) return;
			if (this.saveEpoch !== readSaveEpoch) return;
			this.savedBaseline = diskContent;
			this.deletedOnDisk = false;
			this.isLoaded = true;
		} catch (e: any) {
			if (!this.origin || toURI(this.origin) !== readURI) throw e;
			if (this.saveEpoch !== readSaveEpoch) throw e;
			if (e.name === 'NotFoundError' || e.code === 'ENOENT') {
				// Expected when the file was removed on the checked-out branch;
				// not an error worth logging.
				this.deletedOnDisk = true;
			} else {
				console.error(`Failed to rebase saved baseline for ${readOrigin.name}`, e);
			}
			throw e;
		}
	}

	/**
	 * Passive permission probe: adopt root coverage when given, otherwise ask
	 * storage. The Workspace computes coverage (it owns the root) and passes
	 * it as plain data, so this module never reaches for its owner.
	 */
	markPermissionGranted(): void {
		this.permissionSeq++;
		this.permissionState = 'granted';
	}

	refreshPermissionState(coveredByRoot: boolean): void {
		if (!this.origin) return;
		if (coveredByRoot) {
			this.markPermissionGranted();
			return;
		}
		const seq = ++this.permissionSeq;
		this.storage.queryPermission(this.origin, true).then(
			(state) => {
				if (this.permissionSeq !== seq) return;
				this.permissionState = state;
			},
			(err) => {
				console.error(`Failed to query permission for ${this.origin?.name}`, err);
			}
		);
	}

	/**
	 * `coveredByRoot` has no default on purpose: callers must pass fresh
	 * Workspace coverage explicitly. Prefer `Workspace.requestFilePermission`
	 * over calling this directly.
	 */
	async requestPermission(coveredByRoot: boolean) {
		if (!this.origin) return true;
		if (coveredByRoot) {
			this.markPermissionGranted();
			return true;
		}
		const seq = this.permissionSeq;
		const granted = await this.storage.verifyPermission(this.origin, true);
		if (this.permissionSeq !== seq) {
			return this.permissionState === 'granted';
		}
		if (granted) {
			this.markPermissionGranted();
		} else {
			// Fresh verify result wins over older in-flight queries.
			this.permissionSeq++;
			this.permissionState = 'denied';
		}
		if (granted && !this._content && this.savedBaseline === '') {
			await this.loadContent();
		}
		return granted;
	}

	/**
	 * Storage-level save: writes content and moves the saved baseline, but
	 * performs no repo refresh and schedules no session flush. Prefer
	 * `Workspace.saveDocument`, which runs this with fresh root coverage and
	 * then refreshes the repo and flushes persistence — calling this directly
	 * can leave a stale `draftContent` behind in persistence.
	 */
	async save(options: { forceNewOrigin?: boolean; coveredByRoot: boolean }) {
		if (this.origin && !options.forceNewOrigin) {
			const hasPermission = await this.requestPermission(options.coveredByRoot);
			if (!hasPermission) return false;
		}

		const targetOrigin = options.forceNewOrigin ? undefined : (this.origin ?? undefined);
		const contentToSave = this._content;
		const newOrigin = await this.storage.saveFile(contentToSave, targetOrigin);
		if (newOrigin) {
			this.origin = newOrigin;
			this.savedBaseline = contentToSave;
			this.markPermissionGranted();
			this.deletedOnDisk = false;
			this.saveEpoch++;
			// A successful save establishes the baseline, invalidating any
			// restoreDraft baseline read still in flight (see restoreDraft).
			this.baselineSeq++;
			this.baselinePending = false;
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
			this.baselinePending = true;
			const readOrigin = this.origin;
			// Newest restore/save wins: a concurrent save establishes a
			// fresh baseline (bumping baselineSeq), and a newer restoreDraft
			// re-arms the flag — so a stale read must neither overwrite the
			// baseline nor clear a newer restore's pending flag.
			const seq = ++this.baselineSeq;
			this.storage.readFile(readOrigin).then(
				(saved) => {
					if (this.baselineSeq !== seq) return;
					this.savedBaseline = saved;
					this.baselinePending = false;
				},
				(err) => {
					if (this.baselineSeq !== seq) return;
					console.error(`Failed to load saved content for draft: ${this.origin?.name}`, err);
				}
			);
		}
	}
}
