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

	constructor(storage: PreferenceStorage = new LocalStorageAdapter()) {
		this.storage = storage;
		this.reload();
		this.isInitialized = true;
	}

	get wordWrap() { return this._data.wordWrap; }
	set wordWrap(val: boolean) {
		if (this._data.wordWrap === val) return;
		this._data.wordWrap = val;
		this.save();
	}

	get statusBar() { return this._data.statusBar; }
	set statusBar(val: boolean) {
		if (this._data.statusBar === val) return;
		this._data.statusBar = val;
		this.save();
	}

	get vimMode() { return this._data.vimMode; }
	set vimMode(val: boolean) {
		if (this._data.vimMode === val) return;
		this._data.vimMode = val;
		this.save();
	}

	get vimSyncClipboard() { return this._data.vimSyncClipboard; }
	set vimSyncClipboard(val: boolean) {
		if (this._data.vimSyncClipboard === val) return;
		this._data.vimSyncClipboard = val;
		this.save();
	}

	get zoom() { return this._data.zoom; }
	set zoom(val: number) {
		if (this._data.zoom === val) return;
		this._data.zoom = val;
		this.save();
	}

	get theme() { return this._data.theme; }
	set theme(val: Theme) {
		if (this._data.theme === val) return;
		this._data.theme = val;
		this.save();
	}

	get appearanceMode() { return this._data.appearanceMode; }
	set appearanceMode(val: AppearanceMode) {
		if (this._data.appearanceMode === val) return;
		this._data.appearanceMode = val;
		this.save();
	}

	get accentColor() { return this._data.accentColor; }
	set accentColor(val: string) {
		if (this._data.accentColor === val) return;
		this._data.accentColor = val;
		this.save();
	}

	get sidebarVisible() { return this._data.sidebarVisible; }
	set sidebarVisible(val: boolean) {
		if (this._data.sidebarVisible === val) return;
		this._data.sidebarVisible = val;
		this.save();
	}

	get sidebarWidth() { return this._data.sidebarWidth; }
	set sidebarWidth(val: number) {
		if (this._data.sidebarWidth === val) return;
		this._data.sidebarWidth = val;
		this.save();
	}

	get fileIconThemeId() { return this._data.fileIconThemeId; }
	set fileIconThemeId(val: string) {
		if (this._data.fileIconThemeId === val) return;
		this._data.fileIconThemeId = val;
		this.onIconThemeChange?.('file', val);
		this.save();
	}

	get productIconThemeId() { return this._data.productIconThemeId; }
	set productIconThemeId(val: string) {
		if (this._data.productIconThemeId === val) return;
		this._data.productIconThemeId = val;
		this.onIconThemeChange?.('product', val);
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
		if (!raw) return;
		try {
			const prefs = JSON.parse(raw);
			for (const key of Object.keys(DEFAULTS)) {
				if (prefs[key] !== undefined && key !== 'fileIconThemeId' && key !== 'productIconThemeId') {
					(this._data as any)[key] = prefs[key];
				}
			}
			if (prefs.fileIconThemeId !== undefined && prefs.fileIconThemeId !== this._data.fileIconThemeId) {
				this._data.fileIconThemeId = prefs.fileIconThemeId;
				this.onIconThemeChange?.('file', prefs.fileIconThemeId);
			}
			if (prefs.productIconThemeId !== undefined && prefs.productIconThemeId !== this._data.productIconThemeId) {
				this._data.productIconThemeId = prefs.productIconThemeId;
				this.onIconThemeChange?.('product', prefs.productIconThemeId);
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

	private save() {
		if (!this.isInitialized || this.isRestoring) return;
		try {
			this.storage.setItem(this.storageKey, JSON.stringify(this._data));
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
