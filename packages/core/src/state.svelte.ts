import './polyfills';
import type { Storage, FileOrigin } from './storage';
import type { VCSAdapter } from './project/vcs';
import { Workspace } from './workspace.svelte';
import { Preferences, type PreferenceStorage } from './preferences.svelte';
import { CommandRegistry, registerCoreCommands } from './commands.svelte';
import { KeymapRegistry } from './keymap.svelte';
import { selectionState } from './editor/selection.svelte';
import { CommandPaletteState } from './components/commandPalette.svelte';
import { iconRegistry } from './editor/icons.svelte';
import { getContext } from 'svelte';
import { type SessionPersistence, MemorySessionPersistence } from './persistence';

export interface AppStateOptions {
	storage: Storage;
	vcsFactory: (rootOrigin: FileOrigin) => VCSAdapter;
	persistence?: SessionPersistence;
	prefsStorage?: PreferenceStorage;
}

export class AppState {
	prefs: Preferences;
	storage: Storage;
	workspace: Workspace;
	selection = selectionState;
	commandPalette = new CommandPaletteState();
	icons = iconRegistry;
	commands = new CommandRegistry();
	keymaps = new KeymapRegistry(this);
	settingsOpen = $state(false);
	
	activeSidebarTab = $state<'explorer' | 'git'>('explorer');
	activeEditorView = $state<any>(undefined);

	constructor(options: AppStateOptions) {
		this.storage = options.storage;
		this.prefs = new Preferences(options.prefsStorage);
		const persistence = options.persistence ?? new MemorySessionPersistence();
		this.workspace = new Workspace(this.storage, options.vcsFactory, persistence);
		registerCoreCommands(this);
	}

	async init() {
		// Defer heavy icon initialization until after the first paint
		const deferredInit = async () => {
			try {
				await this.prefs.initializeIcons();
			} catch (e) {
				console.error('[AppState] Failed to initialize icons:', e);
			}
		};

		if (typeof window !== 'undefined' && (window as any).electronAPI?.onWindowShown) {
			// On desktop, the window might already be shown
			// We use a timeout as a safeguard
			let initialized = false;
			const safeInit = () => {
				if (initialized) return;
				initialized = true;
				deferredInit();
			};

			(window as any).electronAPI.onWindowShown(safeInit);
			setTimeout(safeInit, 2000); // 2s safeguard
		} else if (typeof requestIdleCallback !== 'undefined') {
			requestIdleCallback(() => { void deferredInit(); });
		} else {
			setTimeout(() => { void deferredInit(); }, 100);
		}
	}

	// Convenience accessors
	get documents() { return this.workspace.documents; }
	get activeDocument() { return this.workspace.activeDocument; }
	get activeDocumentId() { return this.workspace.activeDocumentId; }
	set activeDocumentId(value: string) { this.workspace.activeDocumentId = value; }
	get activeTabId() { return this.workspace.activeTabId; }
	set activeTabId(value: string) { this.workspace.activeTabId = value; }

	async newFile() { return await this.workspace.newFile(); }
	async openFile() { return await this.workspace.openFile(); }
	async saveFile() { await this.activeDocument?.save(); }
	async saveFileAs() { await this.activeDocument?.save({ forceNewOrigin: true }); }
	
	closeDocument(id: string) { this.workspace.closeDocument(id); }
	closeTab(id: string) { this.workspace.closeTab(id); }
	finalizeClose(id: string, saveFirst = false) { this.workspace.finalizeClose(id, saveFirst); }
}

export function useAppState(): AppState {
	const state = getContext<AppState>('appState');
	if (!state) {
		throw new Error('AppState not found in Svelte context. Make sure AppState is initialized in a parent component/layout.');
	}
	return state;
}
