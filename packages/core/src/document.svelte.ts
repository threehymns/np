import { type Storage, type FileOrigin } from './storage';
import { LanguageSupport, allLanguages } from './editor/language.svelte';
import type { Workspace } from './workspace.svelte';

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
	
	private savedContent = $state('');
	private storage: Storage;
	workspace?: Workspace;

	constructor(storage: Storage, initialContent = '', origin: FileOrigin | null = null, untitledTitle = 'Untitled', workspace?: Workspace) {
		this.storage = storage;
		this._content = initialContent;
		this.savedContent = initialContent;
		this.origin = origin;
		this.untitledTitle = untitledTitle;
		this.workspace = workspace;
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
		if (this.workspace) {
			this.workspace.debouncedSaveOpenFiles();
		}
	}

	get fileName() {
		return this.origin?.name ?? this.untitledTitle;
	}

	get isModified() {
		return this._content !== this.savedContent;
	}

	userLanguageOverride = $state<string | null>(null);

	get language() {
		if (this.userLanguageOverride && this.userLanguageOverride !== "auto") {
			const found = allLanguages.find(l => l.name === this.userLanguageOverride);
			if (found) return found;
			if (this.userLanguageOverride === "Plain Text") return null;
		}
		return LanguageSupport.getLanguageForFile(this.fileName);
	}

	get charCount() {
		return this._content.length;
	}

	get wordCount() {
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
	}

	async loadContent() {
		if (!this.origin) return;
		try {
			const fileContent = await this.storage.readFile(this.origin);
			this._content = fileContent;
			this.savedContent = fileContent;
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
	 * untouched; only `savedContent`, `deletedOnDisk`, and `isLoaded` reflect the
	 * new baseline. Used after an operation that changes files on disk (e.g. a
	 * branch switch) so unsaved in-memory edits survive and are re-diffed against
	 * the checked-out content instead of being silently overwritten.
	 */
	async rebaseSavedBaseline(): Promise<void> {
		if (!this.origin) return;
		try {
			this.savedContent = await this.storage.readFile(this.origin);
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
		if (!this.workspace || !this.workspace.rootOrigin || !this.workspace.hasRootPermission || !this.origin) {
			return false;
		}
		const rootOrigin = this.workspace.rootOrigin;
		if (this.origin.scheme !== rootOrigin.scheme) {
			return false;
		}
		return this.origin.path === rootOrigin.path || this.origin.path.startsWith(rootOrigin.path + '/');
	}

	async requestPermission() {
		if (!this.origin) return true;
		if (await this.hasRootPermissionForFile()) {
			this.permissionState = 'granted';
			return true;
		}
		const granted = await this.storage.verifyPermission(this.origin, true);
		this.permissionState = granted ? 'granted' : 'denied';
		if (granted && !this._content && this.savedContent === '') {
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
		const newOrigin = await this.storage.saveFile(this._content, targetOrigin);
		if (newOrigin) {
			this.origin = newOrigin;
			this.savedContent = this._content;
			this.permissionState = 'granted';
			this.deletedOnDisk = false;
			if (this.workspace?.repository) {
				this.workspace.repository.refresh().catch(e => console.error('Auto-refresh after save failed', e));
			}
			if (this.workspace) {
				this.workspace.debouncedSaveOpenFiles();
			}
			return true;
		}
		return false;
	}

	restoreDraft(draftContent: string) {
		this._content = draftContent;
		this.isLoaded = true;
		if (this.origin) {
			this.storage.readFile(this.origin).then(
				(saved) => {
					this.savedContent = saved;
				},
				(err) => {
					console.error(`Failed to load saved content for draft: ${this.origin?.name}`, err);
				}
			);
		}
	}
}
