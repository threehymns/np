import {
	CORE_ICONS_OWNER,
	type FileIconProvider,
	type ProductIconProvider,
	type FileIconTransform,
	type FileIconTransformEntry,
	type ProductIconTransform,
	type ProductIconTransformEntry,
	type IconRegistryInterface,
	type ThemeInfo,
	type ResolvedIcon
} from '../icons-types';
import { SvelteMap } from 'svelte/reactivity';

type FileIconTransformRegistration = FileIconTransformEntry & { themeId?: string };
type ProductIconTransformRegistration = ProductIconTransformEntry & { themeId?: string };

export class HeadlessIconRegistry implements IconRegistryInterface {
	activeFileThemeId = $state<string>('default');
	activeProductThemeId = $state<string>('default');
	currentAppearance = $state<'light' | 'dark'>('dark');

	private fileThemes = $state<Record<string, FileIconProvider>>({});
	private productThemes = $state<Record<string, ProductIconProvider>>({});
	private fileIconTransforms: FileIconTransformRegistration[] = [];
	private productIconTransforms: ProductIconTransformRegistration[] = [];
	private ownerOrdering?: (ownerIds: readonly string[]) => string[];

	async initialize(): Promise<void> {}

	registerFileTheme(id: string, provider: FileIconProvider): void {
		this.registerCoreFileTheme(id, provider);
	}

	registerProductTheme(id: string, provider: ProductIconProvider): void {
		this.registerCoreProductTheme(id, provider);
	}

	registerFileIconTransform(pluginId: string, transform: FileIconTransform): void {
		this.fileIconTransforms.push({ pluginId, transform });
		this.rebuild();
	}

	registerProductIconTransform(pluginId: string, transform: ProductIconTransform): void {
		this.productIconTransforms.push({ pluginId, transform });
		this.rebuild();
	}

	removePluginIcons(pluginId: string): void {
		const keptFileTransforms = this.fileIconTransforms.filter((entry) => entry.pluginId !== pluginId);
		const keptProductTransforms = this.productIconTransforms.filter((entry) => entry.pluginId !== pluginId);
		if (
			keptFileTransforms.length !== this.fileIconTransforms.length ||
			keptProductTransforms.length !== this.productIconTransforms.length
		) {
			this.fileIconTransforms = keptFileTransforms;
			this.productIconTransforms = keptProductTransforms;
			this.rebuild();
		}
	}

	setOwnerOrdering(order: (ownerIds: readonly string[]) => string[]): void {
		this.ownerOrdering = order;
		this.rebuild();
	}

	private orderedEntries<T extends { pluginId: string }>(entries: readonly T[]): T[] {
		if (!this.ownerOrdering) return [...entries];
		const byOwner = new Map<string, T[]>();
		for (const entry of entries) {
			const list = byOwner.get(entry.pluginId);
			if (list) list.push(entry);
			else byOwner.set(entry.pluginId, [entry]);
		}
		return this.ownerOrdering(Array.from(byOwner.keys())).flatMap((id) => byOwner.get(id)!);
	}

	rebuild(): void {
		this.fileThemes = this.replayFileTransforms();
		this.productThemes = this.replayProductTransforms();
		this.applyAppearance();
	}

	refresh(): void {
		this.rebuild();
	}

	private registerCoreFileTheme(id: string, provider: FileIconProvider): void {
		const entry: FileIconTransformEntry & { themeId?: string } = {
			pluginId: CORE_ICONS_OWNER,
			themeId: id,
			transform: (previous) => {
				const next = new SvelteMap(previous);
				next.set(id, provider);
				return next;
			}
		};
		const index = this.fileIconTransforms.findIndex(
			(candidate) => candidate.pluginId === CORE_ICONS_OWNER && candidate.themeId === id
		);
		if (index === -1) {
			this.fileIconTransforms.push(entry);
		} else {
			this.fileIconTransforms[index] = entry;
		}
		this.rebuild();
	}

	private registerCoreProductTheme(id: string, provider: ProductIconProvider): void {
		const entry: ProductIconTransformEntry & { themeId?: string } = {
			pluginId: CORE_ICONS_OWNER,
			themeId: id,
			transform: (previous) => {
				const next = new SvelteMap(previous);
				next.set(id, provider);
				return next;
			}
		};
		const index = this.productIconTransforms.findIndex(
			(candidate) => candidate.pluginId === CORE_ICONS_OWNER && candidate.themeId === id
		);
		if (index === -1) {
			this.productIconTransforms.push(entry);
		} else {
			this.productIconTransforms[index] = entry;
		}
		this.rebuild();
	}

	private replayFileTransforms(): Record<string, FileIconProvider> {
		let state = new SvelteMap<string, FileIconProvider>();
		for (const entry of this.orderedEntries(this.fileIconTransforms)) {
			const next = entry.transform(new SvelteMap(state));
			state = new SvelteMap(next);
		}
		return Object.fromEntries(state);
	}

	private replayProductTransforms(): Record<string, ProductIconProvider> {
		let state = new SvelteMap<string, ProductIconProvider>();
		for (const entry of this.orderedEntries(this.productIconTransforms)) {
			const next = entry.transform(new SvelteMap(state));
			state = new SvelteMap(next);
		}
		return Object.fromEntries(state);
	}

	private applyAppearance(): void {
		for (const provider of Object.values(this.fileThemes)) {
			provider.setAppearance?.(this.currentAppearance);
		}
		for (const provider of Object.values(this.productThemes)) {
			provider.setAppearance?.(this.currentAppearance);
		}
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
		this.applyAppearance();
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
