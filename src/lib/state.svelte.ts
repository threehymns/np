import { FileStorage } from './storage';
import { Workspace } from './workspace.svelte';
import { Preferences } from './preferences.svelte';
import { registerCoreCommands } from './commands.svelte';
import { selectionState } from './editor/selection.svelte';

export class AppState {
	prefs = new Preferences();
	storage = new FileStorage();
	workspace = new Workspace(this.storage);
	selection = selectionState;
	
	activeEditorView = $state<any>(undefined);

	constructor() {
		registerCoreCommands();
	}

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
