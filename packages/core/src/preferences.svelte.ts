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

export class Preferences {
	private _wordWrap = $state(true);
	private _statusBar = $state(true);
	private _vimMode = $state(false);
	private _vimSyncClipboard = $state(true);
	private _zoom = $state(100);
	private _lineEnding = $state('Unix (LF)');
	private _encoding = $state('UTF-8');
	private _theme = $state<Theme>('default');
	private _appearanceMode = $state<AppearanceMode>('system');
	private _accentColor = $state<string>('default');
	private _sidebarVisible = $state(true);
	private _sidebarWidth = $state(256);
	private _fileIconThemeId = $state<string>('phosphor');
	private _productIconThemeId = $state<string>('phosphor');

	onIconThemeChange?: (type: 'file' | 'product', id: string) => void;

	private storage: PreferenceStorage;
	private storageKey = 'np-prefs-v2';
	private isInitialized = false;
	private isRestoring = false;

	constructor(storage: PreferenceStorage = new LocalStorageAdapter()) {
		this.storage = storage;
		this.load();
		this.isInitialized = true;
	}

	get wordWrap() {
		return this._wordWrap;
	}
	set wordWrap(val: boolean) {
		if (this._wordWrap === val) return;
		this._wordWrap = val;
		this.save();
	}

	get statusBar() {
		return this._statusBar;
	}
	set statusBar(val: boolean) {
		if (this._statusBar === val) return;
		this._statusBar = val;
		this.save();
	}

	get vimMode() {
		return this._vimMode;
	}
	set vimMode(val: boolean) {
		if (this._vimMode === val) return;
		this._vimMode = val;
		this.save();
	}

	get vimSyncClipboard() {
		return this._vimSyncClipboard;
	}
	set vimSyncClipboard(val: boolean) {
		if (this._vimSyncClipboard === val) return;
		this._vimSyncClipboard = val;
		this.save();
	}

	get zoom() {
		return this._zoom;
	}
	set zoom(val: number) {
		if (this._zoom === val) return;
		this._zoom = val;
		this.save();
	}

	get lineEnding() {
		return this._lineEnding;
	}
	set lineEnding(val: string) {
		if (this._lineEnding === val) return;
		this._lineEnding = val;
		this.save();
	}

	get encoding() {
		return this._encoding;
	}
	set encoding(val: string) {
		if (this._encoding === val) return;
		this._encoding = val;
		this.save();
	}

	get theme() {
		return this._theme;
	}
	set theme(val: Theme) {
		if (this._theme === val) return;
		this._theme = val;
		this.save();
	}

	get appearanceMode() {
		return this._appearanceMode;
	}
	set appearanceMode(val: AppearanceMode) {
		if (this._appearanceMode === val) return;
		this._appearanceMode = val;
		this.save();
	}

	get accentColor() {
		return this._accentColor;
	}
	set accentColor(val: string) {
		if (this._accentColor === val) return;
		this._accentColor = val;
		this.save();
	}

	get sidebarVisible() {
		return this._sidebarVisible;
	}
	set sidebarVisible(val: boolean) {
		if (this._sidebarVisible === val) return;
		this._sidebarVisible = val;
		this.save();
	}

	get sidebarWidth() {
		return this._sidebarWidth;
	}
	set sidebarWidth(val: number) {
		if (this._sidebarWidth === val) return;
		this._sidebarWidth = val;
		this.save();
	}

	get fileIconThemeId() {
		return this._fileIconThemeId;
	}
	set fileIconThemeId(val: string) {
		if (this._fileIconThemeId === val) return;
		this._fileIconThemeId = val;
		this.onIconThemeChange?.('file', val);
		this.save();
	}

	get productIconThemeId() {
		return this._productIconThemeId;
	}
	set productIconThemeId(val: string) {
		if (this._productIconThemeId === val) return;
		this._productIconThemeId = val;
		this.onIconThemeChange?.('product', val);
		this.save();
	}

	private applyData(raw: string | null) {
		if (!raw) return;
		try {
			const prefs = JSON.parse(raw);
			if (prefs.wordWrap !== undefined) this._wordWrap = prefs.wordWrap;
			if (prefs.statusBar !== undefined) this._statusBar = prefs.statusBar;
			if (prefs.vimMode !== undefined) this._vimMode = prefs.vimMode;
			if (prefs.vimSyncClipboard !== undefined) this._vimSyncClipboard = prefs.vimSyncClipboard;
			if (prefs.zoom !== undefined) this._zoom = prefs.zoom;
			if (prefs.lineEnding !== undefined) this._lineEnding = prefs.lineEnding;
			if (prefs.encoding !== undefined) this._encoding = prefs.encoding;
			if (prefs.theme !== undefined) this._theme = prefs.theme;
			if (prefs.appearanceMode !== undefined) this._appearanceMode = prefs.appearanceMode;
			if (prefs.accentColor !== undefined) this._accentColor = prefs.accentColor;
			if (prefs.sidebarVisible !== undefined) this._sidebarVisible = prefs.sidebarVisible;
			if (prefs.sidebarWidth !== undefined) this._sidebarWidth = prefs.sidebarWidth;
			if (prefs.fileIconThemeId !== undefined && prefs.fileIconThemeId !== this._fileIconThemeId) {
				this._fileIconThemeId = prefs.fileIconThemeId;
				this.onIconThemeChange?.('file', prefs.fileIconThemeId);
			}
			if (prefs.productIconThemeId !== undefined && prefs.productIconThemeId !== this._productIconThemeId) {
				this._productIconThemeId = prefs.productIconThemeId;
				this.onIconThemeChange?.('product', prefs.productIconThemeId);
			}
		} catch (e) {
			console.error('Failed to load preferences', e);
		}
	}

	private load() {
		this.isRestoring = true;
		try {
			const saved = this.storage.getItem(this.storageKey);
			this.applyData(saved);
		} finally {
			this.isRestoring = false;
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

	private save() {
		if (!this.isInitialized || this.isRestoring) return;
		try {
			const prefs = {
				wordWrap: this._wordWrap,
				statusBar: this._statusBar,
				vimMode: this._vimMode,
				vimSyncClipboard: this._vimSyncClipboard,
				zoom: this._zoom,
				lineEnding: this._lineEnding,
				encoding: this._encoding,
				theme: this._theme,
				appearanceMode: this._appearanceMode,
				accentColor: this._accentColor,
				sidebarVisible: this._sidebarVisible,
				sidebarWidth: this._sidebarWidth,
				fileIconThemeId: this._fileIconThemeId,
				productIconThemeId: this._productIconThemeId
			};
			this.storage.setItem(this.storageKey, JSON.stringify(prefs));
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
