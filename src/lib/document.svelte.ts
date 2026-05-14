import { type Storage, type FileOrigin } from './storage';

export class DocumentSession {
	id = crypto.randomUUID();
	content = $state('');
	origin = $state<FileOrigin | null>(null);
	untitledTitle = $state('Untitled');
	
	private savedContent = $state('');
	private history = $state<string[]>(['']);
	private historyIndex = $state(0);
	private storage: Storage;

	constructor(storage: Storage, initialContent = '', origin: FileOrigin | null = null, untitledTitle = 'Untitled') {
		this.storage = storage;
		this.content = initialContent;
		this.savedContent = initialContent;
		this.origin = origin;
		this.history = [initialContent];
		this.untitledTitle = untitledTitle;
	}

	get fileName() {
		return this.origin?.name ?? this.untitledTitle;
	}

	get isModified() {
		return this.content !== this.savedContent;
	}

	get canUndo() {
		return this.historyIndex > 0;
	}

	get canRedo() {
		return this.historyIndex < this.history.length - 1;
	}

	updateContent(newContent: string, recordHistory = true) {
		if (newContent === this.content) return;
		
		this.content = newContent;
		
		if (recordHistory) {
			// Basic debounced history would be better, but for now:
			this.history = this.history.slice(0, this.historyIndex + 1);
			this.history.push(newContent);
			if (this.history.length > 100) this.history.shift();
			else this.historyIndex++;
		}
	}

	undo() {
		if (this.canUndo) {
			this.historyIndex--;
			this.content = this.history[this.historyIndex];
		}
	}

	redo() {
		if (this.canRedo) {
			this.historyIndex++;
			this.content = this.history[this.historyIndex];
		}
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
