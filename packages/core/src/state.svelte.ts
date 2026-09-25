import './polyfills';
import type { Storage, FileOrigin } from './storage';
import type { VCSAdapter } from './project/vcs';
import { Workspace } from './workspace.svelte';
import { Preferences, type PreferenceStorage } from './preferences.svelte';
import { registerCoreCommands } from './commands.svelte';
import { KeymapRegistry } from './keymap.svelte';
import { selectionState } from './editor/selection.svelte';
import { CommandPaletteState } from './components/commandPalette.svelte';
import { HeadlessIconRegistry } from './editor/icons/headless-registry.svelte';
import type { IconRegistryInterface } from './editor/icons-types';
import { getContext } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import { type SessionPersistence, MemorySessionPersistence } from './persistence';
import { PluginHost, type CommandRegistryLike, type PluginPlatform } from './plugins';
import {
	DIALOGS_SERVICE_KEY,
	DIFF_NAVIGATOR_SERVICE_KEY,
	PLUGIN_UI_LOADER_SERVICE_KEY,
	type PluginUILoader
} from './plugins/services';

export interface DialogService {
	alert?(message: string): Promise<void> | void;
	confirm?(message: string): Promise<boolean> | boolean;
}

export const windowDialogService: DialogService = {
	alert: (message) => {
		if (typeof window !== 'undefined' && typeof window.alert === 'function') {
			window.alert(message);
		}
	},
	confirm: (message) => {
		if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
			return window.confirm(message);
		}
		return false;
	}
};

export interface ClipboardService {
	readText?(): Promise<string>;
	writeText?(text: string): Promise<void>;
}

export const windowClipboardService: ClipboardService = {
	writeText: async (text) => {
		if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
			// edit.cut deletes the selection only when this resolves.
			throw new Error('Clipboard API is unavailable');
		}
		await navigator.clipboard.writeText(text);
	},
	readText: async () => {
		if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
			return await navigator.clipboard.readText();
		}
		return '';
	}
};

export interface ExportFileType {
	description: string;
	accept: Record<string, string[]>;
}

export interface ExportFileOptions {
	content: string;
	suggestedName: string;
	mimeType?: string;
	types?: ExportFileType[];
}

export interface ExportService {
	exportFile(options: ExportFileOptions): Promise<void>;
}

/**
 * Hunk-navigation bridge published by the mounted diff view (issue #80).
 * Feature hunk commands call through this slot so they mirror the
 * DiffViewer's button handlers including wrap behavior.
 */
export interface DiffHunkNavigator {
	nextHunk(): void;
	prevHunk(): void;
}

export interface AppStateOptions {
	storage: Storage;
	vcsFactory: (rootOrigin: FileOrigin) => VCSAdapter;
	persistence?: SessionPersistence;
	prefsStorage?: PreferenceStorage;
	dialogService?: DialogService;
	clipboardService?: ClipboardService;
	exportService?: ExportService;
	iconRegistry?: IconRegistryInterface;
	pluginHost?: PluginHost;
	platform?: PluginPlatform;
}

export class AppState {
	prefs: Preferences;
	storage: Storage;
	workspace: Workspace;
	selection = selectionState;
	commandPalette = new CommandPaletteState();
	icons: IconRegistryInterface;
	keymaps = new KeymapRegistry(this);
	plugins: PluginHost;

	/**
	 * Shared command registry, backed by the plugin host's replayable
	 * transforms. Palette and menus are views over this state.
	 */
	get commands(): CommandRegistryLike {
		return this.plugins.commands;
	}
	settingsOpen = $state(false);
	/**
	 * Actionable startup failure from the plugin dependency check
	 * (cycle / missing interface / version mismatch, ADR 0017), surfaced
	 * in the Plugins settings page instead of failing silently.
	 */
	pluginStartupError = $state<string | null>(null);
	dialogService?: DialogService;
	clipboardService?: ClipboardService;
	exportService?: ExportService;
	
	private _activeSidebarTab = $state<string>('explorer');

	get activeSidebarTab(): string {
		if (
			this._activeSidebarTab !== 'explorer' &&
			!this.plugins.getSidebarPanel(this._activeSidebarTab)
		) {
			return 'explorer';
		}
		return this._activeSidebarTab;
	}

	set activeSidebarTab(val: string) {
		this._activeSidebarTab = val;
	}

	get ui() {
		return this.plugins.ui;
	}
	activeEditorView = $state<any>(undefined);
	// Mounted diff view's hunk navigator, if any. Mirrors the
	// activeEditorView precedent: UI publishes, core commands consume.
	activeDiffNavigator = $state<DiffHunkNavigator | undefined>(undefined);

	constructor(options: AppStateOptions) {
		this.storage = options.storage;
		this.prefs = new Preferences(options.prefsStorage);
		this.dialogService = options.dialogService ?? windowDialogService;
		this.clipboardService = options.clipboardService ?? windowClipboardService;
		this.exportService = options.exportService;
		this.icons = options.iconRegistry ?? new HeadlessIconRegistry();

		this.icons.activeFileThemeId = this.prefs.fileIconThemeId;
		this.icons.activeProductThemeId = this.prefs.productIconThemeId;
		this.prefs.onIconThemeChange = (type, id) => {
			if (type === 'file') {
				this.icons.activeFileThemeId = id;
			} else if (type === 'product') {
				this.icons.activeProductThemeId = id;
			}
		};

		this.plugins = options.pluginHost ?? new PluginHost({ platform: options.platform });
		this.plugins.attachKeymapRegistryInternal(this.keymaps);
		this.plugins.attachIconRegistryInternal(this.icons);
		// The document-edit operation addresses a document by the id a plugin
		// read from a tab, so the host resolves ids against the open documents
		// the workspace owns (ADR 0016).
		this.plugins.attachDocumentResolverInternal(
			(docId) => this.workspace.documents.find((doc) => doc.id === docId)
		);
		// Bundled feature plugins (e.g. version control) register through the
		// generic UI bridge (`@np/ui` plugins entry) so this file stays free
		// of feature names.
		// Plugin-contributed settings schemas flow into the generated
		// settings UI (#199) through the shared host registry.
		this.prefs.settings.setSchemaRegistry(this.plugins.settings);

		const persistence = options.persistence ?? new MemorySessionPersistence();
		this.workspace = new Workspace(this.storage, options.vcsFactory, persistence, this.plugins);
		// Generic collaborator services for feature plugins (#202, ADR 0008):
		// dialog capability and the mounted diff view's hunk navigator. The
		// workspace publishes itself. Keys are generic; values are consumed
		// by each plugin with its own types.
		if (this.dialogService) {
			this.plugins.provideService(DIALOGS_SERVICE_KEY, this.dialogService);
		}
		this.plugins.provideService(DIFF_NAVIGATOR_SERVICE_KEY, {
			getCurrentNavigator: () => this.activeDiffNavigator ?? undefined
		});
		this.workspace.onRootOriginChange = async (origin) => {
			if (origin && this.workspace.hasRootPermission) {
				await this.prefs.attachWorkspace(this.storage, origin);
			} else {
				this.prefs.clearWorkspace();
			}
		};
		registerCoreCommands(this);
	}

	private async loadPluginUI(pluginId: string): Promise<void> {
		const loader = this.plugins.getService<PluginUILoader>(PLUGIN_UI_LOADER_SERVICE_KEY);
		if (loader) await loader.load(pluginId);
	}

	async init() {
		// Cycle/interface check first (ADR 0017): a broken dependency graph
		// surfaces as one actionable error in the Plugins settings page
		// instead of partial per-plugin failures.
		try {
			this.plugins.computeActivationOrder();
		} catch (e) {
			this.pluginStartupError = (e as Error).message;
			console.error('[AppState] Plugin dependency check failed:', e);
		}

		// Activate enabled plugins before session restore so per-workspace
		// lifecycles are plugin-owned from the first open. Generic: no
		// feature names here; persisted toggles win, otherwise manifests
		// declare `defaultEnabled`. Guarded for custom hosts that never
		// registered them.
		if (!this.pluginStartupError) {
			try {
				for (const manifest of this.plugins.getManifests()) {
					if (this.isPluginEnabled(manifest.id) && !this.plugins.isPluginActive(manifest.id)) {
						try {
							await this.loadPluginUI(manifest.id);
							await this.plugins.activate(manifest.id);
						} catch (e) {
							console.error(`[AppState] Failed to activate plugin "${manifest.id}":`, e);
						}
					}
				}
			} catch (e) {
				console.error('[AppState] Failed to activate default plugins:', e);
			}
		}

		try {
			await this.workspace.restoreSession();
		} catch (e) {
			console.error('[AppState] Failed to restore session:', e);
		}

		if (this.icons.initialize) {
			this.icons.initialize().catch((e) => {
				console.error('[AppState] Failed to initialize icons:', e);
			});
		}
	}

	/**
	 * Effective enablement for a plugin: the persisted user toggle wins,
	 * otherwise the manifest's `defaultEnabled` (ADR 0009: app-scoped).
	 */
	isPluginEnabled(id: string): boolean {
		const manifest = this.plugins.getManifest(id);
		return this.prefs.isPluginEnabled(id, manifest?.defaultEnabled ?? false);
	}

	/**
	 * Live enable/disable without restart (ADR 0008): activates or
	 * deactivates through the host, then persists the choice. On disable,
	 * cascade-deactivated dependents are also persisted as off so they
	 * never auto re-enable (ADR 0017).
	 */
	async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
		if (enabled) {
			await this.loadPluginUI(id);
			await this.plugins.activate(id);
			this.prefs.setPluginEnabled(id, true);
			return;
		}
		const activeBefore = new SvelteSet(
			this.plugins.getManifests().map((m) => m.id).filter((pid) => this.plugins.isPluginActive(pid))
		);
		const manifest = this.plugins.getManifest(id);
		await this.plugins.deactivate(
			id,
			manifest ? `${manifest.name} disabled in settings.` : 'Disabled in settings.'
		);
		this.prefs.setPluginEnabled(id, false);
		for (const pid of activeBefore) {
			if (pid !== id && !this.plugins.isPluginActive(pid)) {
				this.prefs.setPluginEnabled(pid, false);
			}
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
	async saveFile() {
		if (this.activeDocument) {
			const ok = await this.workspace.saveDocument(this.activeDocument);
			if (!ok && this.workspace.lastSaveCancellationReason) {
				if (this.dialogService?.alert) {
					await this.dialogService.alert(this.workspace.lastSaveCancellationReason);
				} else if (typeof window !== 'undefined' && window.alert) {
					window.alert(this.workspace.lastSaveCancellationReason);
				}
			}
			return ok;
		}
	}
	async saveFileAs() {
		if (this.activeDocument) {
			const ok = await this.workspace.saveDocument(this.activeDocument, { forceNewOrigin: true });
			if (!ok && this.workspace.lastSaveCancellationReason) {
				if (this.dialogService?.alert) {
					await this.dialogService.alert(this.workspace.lastSaveCancellationReason);
				} else if (typeof window !== 'undefined' && window.alert) {
					window.alert(this.workspace.lastSaveCancellationReason);
				}
			}
			return ok;
		}
	}
	
	closeDocument(id: string) { this.workspace.closeDocument(id); }
	closeTab(id: string) { this.workspace.closeTab(id); }
	async finalizeClose(id: string, saveFirst = false): Promise<boolean> {
		const closed = await this.workspace.finalizeClose(id, saveFirst);
		if (!closed && this.workspace.lastSaveCancellationReason) {
			if (this.dialogService?.alert) {
				await this.dialogService.alert(this.workspace.lastSaveCancellationReason);
			} else if (typeof window !== 'undefined' && window.alert) {
				window.alert(this.workspace.lastSaveCancellationReason);
			}
		}
		return closed;
	}
	flushSaveOpenFiles() { return this.workspace.flushSaveOpenFiles(); }
}

export function useAppState(): AppState {
	const state = getContext<AppState>('appState');
	if (!state) {
		throw new Error('AppState not found in Svelte context. Make sure AppState is initialized in a parent component/layout.');
	}
	return state;
}
