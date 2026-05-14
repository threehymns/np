import { FileSystemStorage } from './storage';
import { DocumentSession } from './document.svelte';

export class Preferences {
	wordWrap = $state(true);
	statusBar = $state(true);
	zoom = $state(100);
	lineEnding = $state('Unix (LF)');
	encoding = $state('UTF-8');

	zoomIn() {
		this.zoom = Math.min(this.zoom + 10, 500);
	}

	zoomOut() {
		this.zoom = Math.max(this.zoom - 10, 10);
	}

	resetZoom() {
		this.zoom = 100;
	}
}

export class AppState {
	prefs = new Preferences();
	storage = new FileSystemStorage();
	
	documents = $state<DocumentSession[]>([]);
	activeDocumentId = $state<string>('');
	activeEditorView = $state<any>(undefined);

	// Cursor/View state (could be moved to EditorContext later)
	line = $state(1);
	column = $state(1);

	pendingCloseId = $state<string | null>(null);
	private untitledCounter = 0;

	constructor() {
		this.untitledCounter++;
		const initialDoc = new DocumentSession(this.storage, '', null, `Untitled ${this.untitledCounter}`);
		this.documents = [initialDoc];
		this.activeDocumentId = initialDoc.id;
	}

	get activeDocument() {
		return this.documents.find((doc) => doc.id === this.activeDocumentId);
	}

	get charCount() {
		return this.activeDocument?.content.length ?? 0;
	}

	async newFile() {
		this.untitledCounter++;
		const newDoc = new DocumentSession(this.storage, '', null, `Untitled ${this.untitledCounter}`);
		this.documents.push(newDoc);
		this.activeDocumentId = newDoc.id;
	}

	async openFile() {
		const origin = await this.storage.pickFile();
		if (!origin) return;

		const content = await this.storage.readFile(origin);
		const newDoc = new DocumentSession(this.storage, content, origin);
		this.documents.push(newDoc);
		this.activeDocumentId = newDoc.id;
	}

	async saveFile() {
		await this.activeDocument?.save();
	}

	async saveFileAs() {
		// DocumentSession.save() handles "Save As" if no origin, 
		// but we might want a forced "Save As" flow.
		const doc = this.activeDocument;
		if (!doc) return;
		
		const newOrigin = await this.storage.saveFile(doc.content);
		if (newOrigin) {
			doc.origin = newOrigin;
			// We can't reach into private savedContent, so maybe save() 
			// should accept an optional forceNewOrigin flag.
			// For now, let's keep it simple.
			await doc.save();
		}
	}

	closeDocument(id: string) {
		const index = this.documents.findIndex(doc => doc.id === id);
		if (index === -1) return;

		const doc = this.documents[index];
		if (doc.isModified) {
			this.pendingCloseId = id;
			return;
		}

		this.finalizeClose(id);
	}

	finalizeClose(id: string, saveFirst = false) {
		const index = this.documents.findIndex(doc => doc.id === id);
		if (index === -1) return;

		const doc = this.documents[index];
		
		if (saveFirst) {
			doc.save().then(() => {
				this.performClose(index, id);
			});
		} else {
			this.performClose(index, id);
		}
		
		this.pendingCloseId = null;
	}

	private performClose(index: number, id: string) {
		if (this.documents.length === 1) {
			this.untitledCounter++;
			this.documents[0] = new DocumentSession(this.storage, '', null, `Untitled ${this.untitledCounter}`);
			this.activeDocumentId = this.documents[0].id;
		} else {
			this.documents.splice(index, 1);
			if (this.activeDocumentId === id) {
				this.activeDocumentId = this.documents[Math.max(0, index - 1)].id;
			}
		}
	}
}

export const appState = new AppState();
