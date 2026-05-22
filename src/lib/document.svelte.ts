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

		if (origin) {
			// Check initial permission state
			this.hasRootPermissionForFile().then(hasRoot => {
				if (hasRoot) {
					this.permissionState = 'granted';
				} else {
					origin.handle.queryPermission().then(state => {
						this.permissionState = state === 'granted' ? 'granted' : 'prompt';
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

	wordCount = $derived(
		this.content.trim().split(/\s+/).filter(Boolean).length
	);

	async loadContent() {
		if (!this.origin) return;
		try {
			this.content = await this.storage.readFile(this.origin);
			this.savedContent = this.content;
			this.deletedOnDisk = false;
		} catch (e: any) {
			console.error(`Failed to load content for ${this.origin.name}`, e);
			if (e.name === 'NotFoundError') {
				this.deletedOnDisk = true;
			}
			throw e;
		}
	}

	async hasRootPermissionForFile(): Promise<boolean> {
		if (!this.workspace || !this.workspace.rootHandle || !this.workspace.hasRootPermission || !this.origin) {
			return false;
		}
		try {
			const relativePath = await this.workspace.rootHandle.resolve(this.origin.handle);
			return relativePath !== null;
		} catch (e) {
			return false;
		}
	}

	async requestPermission() {
		if (!this.origin) return true;
		if (await this.hasRootPermissionForFile()) {
			this.permissionState = 'granted';
			return true;
		}
		const granted = await this.storage.verifyPermission(this.origin.handle, true);
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
