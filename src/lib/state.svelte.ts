import { FileStorage } from './storage';
import { saveHandles, loadHandles, saveActiveId, loadActiveId } from './persistence';
import { DocumentSession } from './document.svelte';

export type Theme = 
	| 'default' 
	| 'gruvbox-dark-hard' | 'gruvbox-dark-medium' | 'gruvbox-dark-soft'
	| 'gruvbox-light-hard' | 'gruvbox-light-medium' | 'gruvbox-light-soft'
	| 'catppuccin-latte' | 'catppuccin-frappe' | 'catppuccin-macchiato' | 'catppuccin-mocha';
export type AppearanceMode = 'light' | 'dark' | 'system';

export class Preferences {
	wordWrap = $state(true);
	statusBar = $state(true);
	zoom = $state(100);
	lineEnding = $state('Unix (LF)');
	encoding = $state('UTF-8');
	theme = $state<Theme>('default');
	appearanceMode = $state<AppearanceMode>('system');
	accentColor = $state<string>('default');

	constructor() {
		this.load();
		
		// Set up persistence
		if (typeof window !== 'undefined') {
			$effect.root(() => {
				$effect(() => {
					this.save();
				});
			});
		}
	}

	load() {
		try {
			if (typeof window === 'undefined' || !window.localStorage || typeof window.localStorage.getItem !== 'function') return;
			const saved = window.localStorage.getItem('np-prefs-v2');
		if (saved) {
			try {
				const prefs = JSON.parse(saved);
				if (prefs.wordWrap !== undefined) this.wordWrap = prefs.wordWrap;
				if (prefs.statusBar !== undefined) this.statusBar = prefs.statusBar;
				if (prefs.zoom !== undefined) this.zoom = prefs.zoom;
				if (prefs.lineEnding !== undefined) this.lineEnding = prefs.lineEnding;
				if (prefs.encoding !== undefined) this.encoding = prefs.encoding;
				if (prefs.theme !== undefined) this.theme = prefs.theme;
				if (prefs.appearanceMode !== undefined) this.appearanceMode = prefs.appearanceMode;
				if (prefs.accentColor !== undefined) this.accentColor = prefs.accentColor;
			} catch (e) {
				console.error('Failed to load preferences', e);
			}
		}
		} catch (e) {
			console.error('Failed to load preferences from localStorage', e);
		}
	}

	save() {
		try {
			if (typeof window === 'undefined' || !window.localStorage || typeof window.localStorage.setItem !== 'function') return;
		const prefs = {
			wordWrap: this.wordWrap,
			statusBar: this.statusBar,
			zoom: this.zoom,
			lineEnding: this.lineEnding,
			encoding: this.encoding,
			theme: this.theme,
			appearanceMode: this.appearanceMode,
			accentColor: this.accentColor
		};
		window.localStorage.setItem('np-prefs-v2', JSON.stringify(prefs));
		} catch (e) {
			console.error('Failed to save preferences', e);
		}
	}

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
	storage = new FileStorage();
	
	documents = $state<DocumentSession[]>([]);
	activeDocumentId = $state<string>('');
	activeEditorView = $state<any>(undefined);

	// Cursor/View state (could be moved to EditorContext later)
	line = $state(1);
	column = $state(1);
	selectionCharCount = $state(0);
	selectionWordCount = $state(0);

	pendingCloseId = $state<string | null>(null);
	private untitledCounter = 0;

	constructor() {
		this.untitledCounter++;
		const initialDoc = new DocumentSession(this.storage, '', null, `Untitled ${this.untitledCounter}`);
		this.documents = [initialDoc];
		this.activeDocumentId = initialDoc.id;

		if (typeof window !== 'undefined') {
			this.restoreSession();

			$effect.root(() => {
				$effect(() => {
					// Persist open files (handles)
					const handles = this.documents
						.map(doc => doc.origin?.handle)
						.filter((h): h is FileSystemFileHandle => !!h);
					saveHandles(handles);
				});

				$effect(() => {
					// Persist active document ID
					saveActiveId(this.activeDocumentId);
				});
			});
		}
	}

	async restoreSession() {
		try {
			const handles = await loadHandles();
			const activeId = await loadActiveId();

			if (handles.length > 0) {
				const restoredDocs: DocumentSession[] = [];
				for (const handle of handles) {
					const origin = { handle, name: handle.name };
					let content = '';
					
					// Try to read content if permission is already granted
					if (await handle.queryPermission() === 'granted') {
						try {
							content = await this.storage.readFile(origin);
						} catch (e) {
							console.error(`Failed to read restored file ${handle.name}`, e);
						}
					}
					
					const doc = new DocumentSession(this.storage, content, origin);
					restoredDocs.push(doc);
				}

				if (restoredDocs.length > 0) {
					this.documents = restoredDocs;
					if (activeId && restoredDocs.some(d => d.id === activeId)) {
						this.activeDocumentId = activeId;
					} else {
						this.activeDocumentId = restoredDocs[0].id;
					}
				}
			}
		} catch (e) {
			console.error('Failed to restore session', e);
		}
	}

	get activeDocument() {
		return this.documents.find((doc) => doc.id === this.activeDocumentId);
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
		await this.activeDocument?.save({ forceNewOrigin: true });
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
