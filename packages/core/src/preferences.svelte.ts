import {
	SettingsManager,
	EDITOR_SCHEMA,
	UI_SCHEMA,
	type ResolvedSetting,
	type SettingDiagnostic
} from './plugins/settings';

export type Theme = 
	| 'default' 
	| 'gruvbox-dark-hard' | 'gruvbox-dark-medium' | 'gruvbox-dark-soft'
	| 'gruvbox-light-hard' | 'gruvbox-light-medium' | 'gruvbox-light-soft'
	| 'catppuccin-latte' | 'catppuccin-frappe' | 'catppuccin-macchiato' | 'catppuccin-mocha';

export type AppearanceMode = 'light' | 'dark' | 'system';

export interface PreferenceStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

export class LocalStorageAdapter implements PreferenceStorage {
	getItem(key: string): string | null {
		if (typeof window === 'undefined') return null;
		return window.localStorage.getItem(key);
	}
	setItem(key: string, value: string): void {
		if (typeof window === 'undefined') return;
		window.localStorage.setItem(key, value);
	}
}

const DEFAULTS = {
	wordWrap: true,
	statusBar: true,
	vimMode: false,
	vimSyncClipboard: true,
	tabSize: 2,
	lineNumbers: true,
	zoom: 100,
	theme: 'default' as Theme,
	appearanceMode: 'system' as AppearanceMode,
	accentColor: 'default' as string,
	sidebarVisible: true,
	sidebarWidth: 256,
	fileIconThemeId: 'phosphor' as string,
	productIconThemeId: 'phosphor' as string,
};

export class Preferences {
	private _data = $state({ ...DEFAULTS });
	onIconThemeChange?: (type: 'file' | 'product', id: string) => void;

	private storage: PreferenceStorage;
	private storageKey = 'np-prefs-v2';
	private isInitialized = false;
	private isRestoring = false;

	/** Underlying settings manager providing namespaces, schema validation, and diagnostics */
	readonly settings: SettingsManager;
	private storedRawData: Record<string, any> = {};
	private explicitlyModifiedKeys = new Set<string>();
	private explicitlyModifiedNamespaces = new Set<string>();

	constructor(storage: PreferenceStorage = new LocalStorageAdapter()) {
		this.storage = storage;
		this.settings = new SettingsManager({
			storage,
			storageKey: this.storageKey
		});

		this.reload();
		this.isInitialized = true;
	}

	get wordWrap(): boolean { return this._data.wordWrap; }
	set wordWrap(val: boolean) {
		if (this._data.wordWrap === val) return;
		this._data.wordWrap = val;
		this.explicitlyModifiedKeys.add('editor.word_wrap');
		this.syncToSettingsAndSave('editor', 'word_wrap', val);
	}

	get statusBar(): boolean { return this._data.statusBar; }
	set statusBar(val: boolean) {
		if (this._data.statusBar === val) return;
		this._data.statusBar = val;
		this.explicitlyModifiedKeys.add('ui.status_bar');
		this.syncToSettingsAndSave('ui', 'status_bar', val);
	}

	get vimMode(): boolean { return this._data.vimMode; }
	set vimMode(val: boolean) {
		if (this._data.vimMode === val) return;
		this._data.vimMode = val;
		this.explicitlyModifiedKeys.add('editor.vim_mode');
		this.syncToSettingsAndSave('editor', 'vim_mode', val);
	}

	get vimSyncClipboard(): boolean { return this._data.vimSyncClipboard; }
	set vimSyncClipboard(val: boolean) {
		if (this._data.vimSyncClipboard === val) return;
		this._data.vimSyncClipboard = val;
		this.explicitlyModifiedKeys.add('editor.vim_sync_clipboard');
		this.syncToSettingsAndSave('editor', 'vim_sync_clipboard', val);
	}

	get tabSize(): number { return this._data.tabSize; }
	set tabSize(val: number) {
		if (this._data.tabSize === val) return;
		this._data.tabSize = val;
		this.explicitlyModifiedKeys.add('editor.tab_size');
		this.syncToSettingsAndSave('editor', 'tab_size', val);
	}

	get lineNumbers(): boolean { return this._data.lineNumbers; }
	set lineNumbers(val: boolean) {
		if (this._data.lineNumbers === val) return;
		this._data.lineNumbers = val;
		this.explicitlyModifiedKeys.add('editor.line_numbers');
		this.syncToSettingsAndSave('editor', 'line_numbers', val);
	}

	get zoom(): number { return this._data.zoom; }
	set zoom(val: number) {
		if (this._data.zoom === val) return;
		this._data.zoom = val;
		this.explicitlyModifiedKeys.add('ui.zoom');
		this.syncToSettingsAndSave('ui', 'zoom', val);
	}

	get theme(): Theme { return this._data.theme; }
	set theme(val: Theme) {
		if (this._data.theme === val) return;
		this._data.theme = val;
		this.explicitlyModifiedKeys.add('ui.theme');
		this.syncToSettingsAndSave('ui', 'theme', val);
	}

	get appearanceMode(): AppearanceMode { return this._data.appearanceMode; }
	set appearanceMode(val: AppearanceMode) {
		if (this._data.appearanceMode === val) return;
		this._data.appearanceMode = val;
		this.explicitlyModifiedKeys.add('ui.appearance_mode');
		this.syncToSettingsAndSave('ui', 'appearance_mode', val);
	}

	get accentColor(): string { return this._data.accentColor; }
	set accentColor(val: string) {
		if (this._data.accentColor === val) return;
		this._data.accentColor = val;
		this.explicitlyModifiedKeys.add('ui.accent_color');
		this.syncToSettingsAndSave('ui', 'accent_color', val);
	}

	get sidebarVisible(): boolean { return this._data.sidebarVisible; }
	set sidebarVisible(val: boolean) {
		if (this._data.sidebarVisible === val) return;
		this._data.sidebarVisible = val;
		this.explicitlyModifiedKeys.add('ui.sidebar_visible');
		this.syncToSettingsAndSave('ui', 'sidebar_visible', val);
	}

	get sidebarWidth(): number { return this._data.sidebarWidth; }
	set sidebarWidth(val: number) {
		if (this._data.sidebarWidth === val) return;
		this._data.sidebarWidth = val;
		this.explicitlyModifiedKeys.add('ui.sidebar_width');
		this.syncToSettingsAndSave('ui', 'sidebar_width', val);
	}

	get fileIconThemeId(): string { return this._data.fileIconThemeId; }
	set fileIconThemeId(val: string) {
		if (this._data.fileIconThemeId === val) return;
		this._data.fileIconThemeId = val;
		this.explicitlyModifiedKeys.add('ui.file_icon_theme_id');
		this.onIconThemeChange?.('file', val);
		this.syncToSettingsAndSave('ui', 'file_icon_theme_id', val);
	}

	get productIconThemeId(): string { return this._data.productIconThemeId; }
	set productIconThemeId(val: string) {
		if (this._data.productIconThemeId === val) return;
		this._data.productIconThemeId = val;
		this.explicitlyModifiedKeys.add('ui.product_icon_theme_id');
		this.onIconThemeChange?.('product', val);
		this.syncToSettingsAndSave('ui', 'product_icon_theme_id', val);
	}

	get diagnostics(): SettingDiagnostic[] {
		return this.settings.getDiagnostics();
	}

	getDiagnostics(): SettingDiagnostic[] {
		return this.settings.getDiagnostics();
	}

	resolve<T = any>(namespace: string, key: string): ResolvedSetting<T> {
		return this.settings.resolve<T>(namespace, key);
	}

	get<T = any>(namespace: string, key: string): T {
		return this.settings.get<T>(namespace, key);
	}

	set<T = any>(namespace: string, key: string, value: T): void {
		this.explicitlyModifiedKeys.add(`${namespace}.${key}`);
		this.explicitlyModifiedNamespaces.add(namespace);
		// Update corresponding _data property if it is a core property
		this.updateDataFromNamespacedKey(namespace, key, value);
		this.syncToSettingsAndSave(namespace, key, value);
	}

	private updateDataFromNamespacedKey(namespace: string, key: string, value: any): void {
		if (namespace === 'editor') {
			if (key === 'word_wrap' || key === 'wordWrap') this._data.wordWrap = value;
			else if (key === 'vim_mode' || key === 'vimMode') this._data.vimMode = value;
			else if (key === 'vim_sync_clipboard' || key === 'vimSyncClipboard') this._data.vimSyncClipboard = value;
			else if (key === 'tab_size' || key === 'tabSize') this._data.tabSize = value;
			else if (key === 'line_numbers' || key === 'lineNumbers') this._data.lineNumbers = value;
		} else if (namespace === 'ui') {
			if (key === 'theme') this._data.theme = value;
			else if (key === 'appearance_mode' || key === 'appearanceMode') this._data.appearanceMode = value;
			else if (key === 'accent_color' || key === 'accentColor') this._data.accentColor = value;
			else if (key === 'zoom') this._data.zoom = value;
			else if (key === 'status_bar' || key === 'statusBar') this._data.statusBar = value;
			else if (key === 'sidebar_visible' || key === 'sidebarVisible') this._data.sidebarVisible = value;
			else if (key === 'sidebar_width' || key === 'sidebarWidth') this._data.sidebarWidth = value;
			else if (key === 'file_icon_theme_id' || key === 'fileIconThemeId') {
				this._data.fileIconThemeId = value;
				this.onIconThemeChange?.('file', value);
			} else if (key === 'product_icon_theme_id' || key === 'productIconThemeId') {
				this._data.productIconThemeId = value;
				this.onIconThemeChange?.('product', value);
			}
		}
	}

	private syncToSettingsAndSave(namespace: string, key: string, value: any): void {
		if (!this.isInitialized || this.isRestoring) return;

		// Update stored raw data
		if (typeof this.storedRawData[namespace] !== 'object' || this.storedRawData[namespace] === null) {
			this.storedRawData[namespace] = {};
		}
		this.storedRawData[namespace][key] = value;

		this.save();
	}

	private resetToDefaults() {
		const prevFile = this._data.fileIconThemeId;
		const prevProduct = this._data.productIconThemeId;
		this._data = { ...DEFAULTS };
		if (prevFile !== 'phosphor') {
			this.onIconThemeChange?.('file', 'phosphor');
		}
		if (prevProduct !== 'phosphor') {
			this.onIconThemeChange?.('product', 'phosphor');
		}
	}

	private applyData(raw: string | null) {
		this.resetToDefaults();
		this.settings.loadFromText(raw);

		if (!raw) {
			this.storedRawData = {};
			return;
		}

		try {
			// Synchronize _data from settings resolver
			this.storedRawData = this.settings.getStoredDocument();

			// Resolve editor settings
			this._data.wordWrap = this.settings.resolve('editor', 'word_wrap').value;
			this._data.vimMode = this.settings.resolve('editor', 'vim_mode').value;
			this._data.vimSyncClipboard = this.settings.resolve('editor', 'vim_sync_clipboard').value;
			this._data.tabSize = this.settings.resolve('editor', 'tab_size').value;
			this._data.lineNumbers = this.settings.resolve('editor', 'line_numbers').value;

			// Resolve UI settings
			this._data.theme = this.settings.resolve('ui', 'theme').value;
			this._data.appearanceMode = this.settings.resolve('ui', 'appearance_mode').value;
			this._data.accentColor = this.settings.resolve('ui', 'accent_color').value;
			this._data.zoom = this.settings.resolve('ui', 'zoom').value;
			this._data.statusBar = this.settings.resolve('ui', 'status_bar').value;
			this._data.sidebarVisible = this.settings.resolve('ui', 'sidebar_visible').value;
			this._data.sidebarWidth = this.settings.resolve('ui', 'sidebar_width').value;

			const newFileIconTheme = this.settings.resolve('ui', 'file_icon_theme_id').value;
			if (newFileIconTheme !== this._data.fileIconThemeId) {
				this._data.fileIconThemeId = newFileIconTheme;
				this.onIconThemeChange?.('file', newFileIconTheme);
			}

			const newProductIconTheme = this.settings.resolve('ui', 'product_icon_theme_id').value;
			if (newProductIconTheme !== this._data.productIconThemeId) {
				this._data.productIconThemeId = newProductIconTheme;
				this.onIconThemeChange?.('product', newProductIconTheme);
			}
		} catch (e) {
			console.error('Failed to load preferences', e);
		}
	}

	public reload(rawContent?: string) {
		this.isRestoring = true;
		try {
			const content = rawContent !== undefined ? rawContent : this.storage.getItem(this.storageKey);
			this.applyData(content);
		} finally {
			this.isRestoring = false;
		}
	}

	private buildStoragePayload(): Record<string, any> {
		// Start with stored raw data to preserve unknown namespaces and disabled plugins
		const payload: Record<string, any> = { ...this.storedRawData };

		const hasEditorNs = ('editor' in this.storedRawData) || this.explicitlyModifiedNamespaces.has('editor');
		if (hasEditorNs) {
			const editorNs = typeof payload.editor === 'object' && payload.editor !== null ? { ...payload.editor } : {};
			editorNs.tab_size = this.explicitlyModifiedKeys.has('editor.tab_size') ? this._data.tabSize : (editorNs.tab_size ?? this._data.tabSize);
			editorNs.line_numbers = this.explicitlyModifiedKeys.has('editor.line_numbers') ? this._data.lineNumbers : (editorNs.line_numbers ?? this._data.lineNumbers);
			editorNs.word_wrap = this.explicitlyModifiedKeys.has('editor.word_wrap') ? this._data.wordWrap : (editorNs.word_wrap ?? this._data.wordWrap);
			editorNs.vim_mode = this.explicitlyModifiedKeys.has('editor.vim_mode') ? this._data.vimMode : (editorNs.vim_mode ?? this._data.vimMode);
			editorNs.vim_sync_clipboard = this.explicitlyModifiedKeys.has('editor.vim_sync_clipboard') ? this._data.vimSyncClipboard : (editorNs.vim_sync_clipboard ?? this._data.vimSyncClipboard);
			payload.editor = editorNs;
		}

		const hasUiNs = ('ui' in this.storedRawData) || this.explicitlyModifiedNamespaces.has('ui');
		if (hasUiNs) {
			const uiNs = typeof payload.ui === 'object' && payload.ui !== null ? { ...payload.ui } : {};
			uiNs.theme = this.explicitlyModifiedKeys.has('ui.theme') ? this._data.theme : (uiNs.theme ?? this._data.theme);
			uiNs.appearance_mode = this.explicitlyModifiedKeys.has('ui.appearance_mode') ? this._data.appearanceMode : (uiNs.appearance_mode ?? this._data.appearanceMode);
			uiNs.accent_color = this.explicitlyModifiedKeys.has('ui.accent_color') ? this._data.accentColor : (uiNs.accent_color ?? this._data.accentColor);
			uiNs.zoom = this.explicitlyModifiedKeys.has('ui.zoom') ? this._data.zoom : (uiNs.zoom ?? this._data.zoom);
			uiNs.status_bar = this.explicitlyModifiedKeys.has('ui.status_bar') ? this._data.statusBar : (uiNs.status_bar ?? this._data.statusBar);
			uiNs.sidebar_visible = this.explicitlyModifiedKeys.has('ui.sidebar_visible') ? this._data.sidebarVisible : (uiNs.sidebar_visible ?? this._data.sidebarVisible);
			uiNs.sidebar_width = this.explicitlyModifiedKeys.has('ui.sidebar_width') ? this._data.sidebarWidth : (uiNs.sidebar_width ?? this._data.sidebarWidth);
			uiNs.file_icon_theme_id = this.explicitlyModifiedKeys.has('ui.file_icon_theme_id') ? this._data.fileIconThemeId : (uiNs.file_icon_theme_id ?? this._data.fileIconThemeId);
			uiNs.product_icon_theme_id = this.explicitlyModifiedKeys.has('ui.product_icon_theme_id') ? this._data.productIconThemeId : (uiNs.product_icon_theme_id ?? this._data.productIconThemeId);
			payload.ui = uiNs;
		}

		// Backward-compatible flat aliases at root level
		payload.wordWrap = this._data.wordWrap;
		payload.statusBar = this._data.statusBar;
		payload.vimMode = this._data.vimMode;
		payload.vimSyncClipboard = this._data.vimSyncClipboard;
		payload.zoom = this._data.zoom;
		payload.theme = this._data.theme;
		payload.appearanceMode = this._data.appearanceMode;
		payload.accentColor = this._data.accentColor;
		payload.sidebarVisible = this._data.sidebarVisible;
		payload.sidebarWidth = this._data.sidebarWidth;
		payload.fileIconThemeId = this._data.fileIconThemeId;
		payload.productIconThemeId = this._data.productIconThemeId;

		return payload;
	}

	private save() {
		if (!this.isInitialized || this.isRestoring) return;
		try {
			const payload = this.buildStoragePayload();
			this.storage.setItem(this.storageKey, JSON.stringify(payload));
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
