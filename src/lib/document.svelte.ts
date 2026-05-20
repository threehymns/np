import { type Storage, type FileOrigin } from './storage';

export type PermissionState = 'granted' | 'prompt' | 'denied';

export class DocumentSession {
	id = crypto.randomUUID();
	content = $state('');
	origin = $state<FileOrigin | null>(null);
	untitledTitle = $state('Untitled');
	permissionState = $state<PermissionState>('granted');
	
	private savedContent = $state('');
	private storage: Storage;

	constructor(storage: Storage, initialContent = '', origin: FileOrigin | null = null, untitledTitle = 'Untitled') {
		this.storage = storage;
		this.content = initialContent;
		this.savedContent = initialContent;
		this.origin = origin;
		this.untitledTitle = untitledTitle;

		if (origin) {
			// Check initial permission state
			origin.handle.queryPermission().then(state => {
				this.permissionState = state === 'granted' ? 'granted' : 'prompt';
			});
		}
	}

	get fileName() {
		return this.origin?.name ?? this.untitledTitle;
	}

	get isModified() {
		return this.content !== this.savedContent;
	}

	charCount = $derived(this.content.length);

	wordCount = $derived(
		this.content.trim().split(/\s+/).filter(Boolean).length
	);

	async loadContent() {
		if (!this.origin) return;
		try {
			this.content = await this.storage.readFile(this.origin);
			this.savedContent = this.content;
		} catch (e) {
			console.error(`Failed to load content for ${this.origin.name}`, e);
		}
	}

	async requestPermission() {
		if (!this.origin) return true;
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
			return true;
		}
		return false;
	}
}
