import { FileStorage } from './storage';
import { Workspace } from './workspace.svelte';
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
	workspace = new Workspace(this.storage);
	
	activeEditorView = $state<any>(undefined);

	// Cursor/View state (could be moved to EditorContext later)
	line = $state(1);
	column = $state(1);
	selectionCharCount = $state(0);
	selectionWordCount = $state(0);

	constructor() {}

	// Convenience accessors
	get documents() { return this.workspace.documents; }
	get activeDocument() { return this.workspace.activeDocument; }
	get activeDocumentId() { return this.workspace.activeDocumentId; }
	set activeDocumentId(value: string) { this.workspace.activeDocumentId = value; }

	async newFile() { return await this.workspace.newFile(); }
	async openFile() { return await this.workspace.openFile(); }
	async saveFile() { await this.activeDocument?.save(); }
	async saveFileAs() { await this.activeDocument?.save({ forceNewOrigin: true }); }
	
	closeDocument(id: string) { this.workspace.closeDocument(id); }
	finalizeClose(id: string, saveFirst = false) { this.workspace.finalizeClose(id, saveFirst); }
}

export const appState = new AppState();
