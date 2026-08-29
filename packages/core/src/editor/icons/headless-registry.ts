import type {
	FileIconProvider,
	ProductIconProvider,
	IconRegistryInterface,
	ThemeInfo,
	ResolvedIcon
} from '../icons-types';

export class HeadlessIconRegistry implements IconRegistryInterface {
	activeFileThemeId = $state<string>('default');
	activeProductThemeId = $state<string>('default');
	currentAppearance = $state<'light' | 'dark'>('dark');

	private fileThemes = $state<Record<string, FileIconProvider>>({});
	private productThemes = $state<Record<string, ProductIconProvider>>({});

	constructor() {}

	async initialize(): Promise<void> {}

	registerFileTheme(id: string, provider: FileIconProvider): void {
		this.fileThemes[id] = provider;
	}

	registerProductTheme(id: string, provider: ProductIconProvider): void {
		this.productThemes[id] = provider;
	}

	getFileThemes(): ThemeInfo[] {
		return Object.keys(this.fileThemes).map(id => ({
			id,
			name: this.fileThemes[id].name || id,
			source: 'builtin'
		}));
	}

	getProductThemes(): ThemeInfo[] {
		return Object.keys(this.productThemes).map(id => ({
			id,
			name: this.productThemes[id].name || id,
			source: 'builtin'
		}));
	}

	setAppearance(appearance: 'light' | 'dark'): void {
		this.currentAppearance = appearance;
		for (const provider of Object.values(this.fileThemes)) {
			if (provider.setAppearance) {
				provider.setAppearance(appearance);
			}
		}
		for (const provider of Object.values(this.productThemes)) {
			if (provider.setAppearance) {
				provider.setAppearance(appearance);
			}
		}
	}

	resolveFileIconChain(filename: string, context?: { language?: string }): ResolvedIcon[] {
		const activeProvider = this.fileThemes[this.activeFileThemeId];
		if (!activeProvider) return [];
		const chain: ResolvedIcon[] = [];
		const activeIcon = activeProvider.resolveFileIcon(filename, context);
		if (activeIcon) chain.push(activeIcon);
		const activeDefault = activeProvider.getDefaultFileIcon();
		if (activeDefault) chain.push(activeDefault);
		return chain;
	}

	resolveFolderIconChain(foldername: string, options?: { expanded?: boolean }): ResolvedIcon[] {
		const activeProvider = this.fileThemes[this.activeFileThemeId];
		if (!activeProvider) return [];
		const chain: ResolvedIcon[] = [];
		const activeIcon = activeProvider.resolveFolderIcon(foldername, options);
		if (activeIcon) chain.push(activeIcon);
		const activeDefault = activeProvider.getDefaultFolderIcon(options);
		if (activeDefault) chain.push(activeDefault);
		return chain;
	}

	resolveProductIconChain(iconName: string): ResolvedIcon[] {
		const activeProvider = this.productThemes[this.activeProductThemeId];
		if (!activeProvider) return [];
		const chain: ResolvedIcon[] = [];
		const activeIcon = activeProvider.resolveProductIcon(iconName);
		if (activeIcon) chain.push(activeIcon);
		return chain;
	}

	resolveFileIcon(filename: string, languageModeName?: string): any {
		const chain = this.resolveFileIconChain(filename, { language: languageModeName });
		const first = chain[0];
		if (!first || first.type === 'empty') return null;
		return first.value;
	}

	resolveProductIcon(iconName: string): any {
		const chain = this.resolveProductIconChain(iconName);
		const first = chain[0];
		if (!first || first.type === 'empty') return null;
		return first.value;
	}

	getLanguageIcon(name: string): any {
		return this.resolveFileIcon('', name);
	}

	getFileIcon(filename: string): any {
		return this.resolveFileIcon(filename);
	}

	getFolderIcon(name: string): any {
		const chain = this.resolveFolderIconChain(name, { expanded: false });
		const first = chain[0];
		if (!first || first.type === 'empty') return null;
		return first.value;
	}

	getFolderExpandedIcon(name: string): any {
		const chain = this.resolveFolderIconChain(name, { expanded: true });
		const first = chain[0];
		if (!first || first.type === 'empty') return null;
		return first.value;
	}

	getThemeDefaultFileIcon(): any {
		const activeProvider = this.fileThemes[this.activeFileThemeId];
		const first = activeProvider?.getDefaultFileIcon();
		if (!first || first.type === 'empty') return null;
		return first.value;
	}

	getThemeDefaultFolderIcon(): any {
		const activeProvider = this.fileThemes[this.activeFileThemeId];
		const first = activeProvider?.getDefaultFolderIcon({ expanded: false });
		if (!first || first.type === 'empty') return null;
		return first.value;
	}

	getThemeDefaultFolderExpandedIcon(): any {
		const activeProvider = this.fileThemes[this.activeFileThemeId];
		const first = activeProvider?.getDefaultFolderIcon({ expanded: true });
		if (!first || first.type === 'empty') return null;
		return first.value;
	}
}
