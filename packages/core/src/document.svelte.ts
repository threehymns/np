import { type Storage, type FileOrigin } from './storage';
import { LanguageSupport, allLanguages } from './editor/language.svelte';
import type { Workspace } from './workspace.svelte';

export type PermissionState = 'granted' | 'prompt' | 'denied';

export class DocumentSession {
	id = crypto.randomUUID();
	content = $state('');
	origin = $state.raw<FileOrigin | null>(null);
	untitledTitle = $state('Untitled');
	permissionState = $state<PermissionState>('granted');
	deletedOnDisk = $state(false);
	isLoaded = $state(false);
	
	private savedContent = $state('');
	private storage: Storage;
	private workspace?: Workspace;

	constructor(storage: Storage, initialContent = '', origin: FileOrigin | null = null, untitledTitle = 'Untitled', workspace?: Workspace) {
		this.storage = storage;
		this.content = initialContent;
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

	get fileName() {
		return this.origin?.name ?? this.untitledTitle;
	}

	get isModified() {
		return this.content !== this.savedContent;
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

	charCount = $derived(this.content.length);

	wordCount = $derived.by(() => {
		const text = this.content;
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
			this.content = await this.storage.readFile(this.origin);
			this.savedContent = this.content;
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
		if (granted && !this.content && this.savedContent === '') {
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
		const newOrigin = await this.storage.saveFile(this.content, targetOrigin);
		if (newOrigin) {
			this.origin = newOrigin;
			this.savedContent = this.content;
			this.permissionState = 'granted';
			this.deletedOnDisk = false;
			return true;
		}
		return false;
	}
}
