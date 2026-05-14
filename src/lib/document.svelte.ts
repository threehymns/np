import { type Storage, type FileOrigin } from './storage';

export class DocumentSession {
	id = crypto.randomUUID();
	content = $state('');
	origin = $state<FileOrigin | null>(null);
	untitledTitle = $state('Untitled');
	
	private savedContent = $state('');
	private storage: Storage;

	constructor(storage: Storage, initialContent = '', origin: FileOrigin | null = null, untitledTitle = 'Untitled') {
		this.storage = storage;
		this.content = initialContent;
		this.savedContent = initialContent;
		this.origin = origin;
		this.untitledTitle = untitledTitle;
	}

	get fileName() {
		return this.origin?.name ?? this.untitledTitle;
	}

	get isModified() {
		return this.content !== this.savedContent;
	}

	async save() {
		const newOrigin = await this.storage.saveFile(this.content, this.origin ?? undefined);
		if (newOrigin) {
			this.origin = newOrigin;
			this.savedContent = this.content;
			return true;
		}
		return false;
	}
}
