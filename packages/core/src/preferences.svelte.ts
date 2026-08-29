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
	wordWrap = $state(true);
	statusBar = $state(true);
	vimMode = $state(false);
	vimSyncClipboard = $state(true);
	zoom = $state(100);
	lineEnding = $state('Unix (LF)');
	encoding = $state('UTF-8');
	theme = $state<Theme>('default');
	appearanceMode = $state<AppearanceMode>('system');
	accentColor = $state<string>('default');
	sidebarVisible = $state(true);
	sidebarWidth = $state(256);
	private _fileIconThemeId = $state<string>('phosphor');
	private _productIconThemeId = $state<string>('phosphor');
	onIconThemeChange?: (type: 'file' | 'product', id: string) => void;

	get fileIconThemeId() {
		return this._fileIconThemeId;
	}
	set fileIconThemeId(val: string) {
		this._fileIconThemeId = val;
		this.onIconThemeChange?.('file', val);
		this.save();
	}

	get productIconThemeId() {
		return this._productIconThemeId;
	}
	set productIconThemeId(val: string) {
		this._productIconThemeId = val;
		this.onIconThemeChange?.('product', val);
		this.save();
	}

	private storage: PreferenceStorage;
	private storageKey = 'np-prefs-v2';

	constructor(storage: PreferenceStorage = new LocalStorageAdapter()) {
		this.storage = storage;
		
		if (typeof window !== 'undefined') {
			$effect.root(() => {
				let initialized = false;
				$effect(() => {
					if (!initialized) {
						this.load();
						initialized = true;
					}
					this.save();
				});
			});
		}
	}

	async initializeIcons() {}


	private load() {
		try {
			const saved = this.storage.getItem(this.storageKey);
			if (saved) {
				const prefs = JSON.parse(saved);
				if (prefs.wordWrap !== undefined) this.wordWrap = prefs.wordWrap;
				if (prefs.statusBar !== undefined) this.statusBar = prefs.statusBar;
				if (prefs.vimMode !== undefined) this.vimMode = prefs.vimMode;
				if (prefs.vimSyncClipboard !== undefined) this.vimSyncClipboard = prefs.vimSyncClipboard;
				if (prefs.zoom !== undefined) this.zoom = prefs.zoom;
				if (prefs.lineEnding !== undefined) this.lineEnding = prefs.lineEnding;
				if (prefs.encoding !== undefined) this.encoding = prefs.encoding;
				if (prefs.theme !== undefined) this.theme = prefs.theme;
				if (prefs.appearanceMode !== undefined) this.appearanceMode = prefs.appearanceMode;
				if (prefs.accentColor !== undefined) this.accentColor = prefs.accentColor;
				if (prefs.sidebarVisible !== undefined) this.sidebarVisible = prefs.sidebarVisible;
				if (prefs.sidebarWidth !== undefined) this.sidebarWidth = prefs.sidebarWidth;
				if (prefs.fileIconThemeId !== undefined) this.fileIconThemeId = prefs.fileIconThemeId;
				if (prefs.productIconThemeId !== undefined) this.productIconThemeId = prefs.productIconThemeId;
			}
		} catch (e) {
			console.error('Failed to load preferences', e);
		}
	}

	private save() {
		try {
			const prefs = {
				wordWrap: this.wordWrap,
				statusBar: this.statusBar,
				vimMode: this.vimMode,
				vimSyncClipboard: this.vimSyncClipboard,
				zoom: this.zoom,
				lineEnding: this.lineEnding,
				encoding: this.encoding,
				theme: this.theme,
				appearanceMode: this.appearanceMode,
				accentColor: this.accentColor,
				sidebarVisible: this.sidebarVisible,
				sidebarWidth: this.sidebarWidth,
				fileIconThemeId: this.fileIconThemeId,
				productIconThemeId: this.productIconThemeId
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
