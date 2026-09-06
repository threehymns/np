import {
	File,
	FileCode,
	FileText,
	Code,
	Globe,
	Database,
	Gear,
	Folder,
	FolderOpen,
	PencilSimple,
	Article,
	Info,
	CheckSquare,
	Lightbulb,
	CheckCircle,
	Question,
	Warning,
	WarningOctagon,
	Bug,
	Flask,
	Quotes,
	XCircle,
} from "phosphor-svelte";
import type {
	ZedIconTheme,
	ResolvedIcon,
	FileIconProvider,
	ProductIconProvider,
	IconRegistryInterface,
	ThemeInfo
} from "@np/core";
import { ManifestIconProvider, builtinFileThemes, fetchZedTheme } from "@np/core";

export class PhosphorIconProvider implements FileIconProvider, ProductIconProvider {
	readonly id = 'phosphor';
	readonly name = 'Phosphor';

	resolveFileIcon(filename: string, context?: { language?: string }): ResolvedIcon | null {
		const ext = filename.split(".").pop()?.toLowerCase() || '';
		let comp = this.getComponentByExtension(ext);
		if (!comp && context?.language) {
			comp = this.getComponentByLanguage(context.language);
		}
		return comp ? { type: 'component', value: comp } : null;
	}

	resolveFolderIcon(folderName: string, options?: { expanded?: boolean }): ResolvedIcon | null {
		return { type: 'component', value: options?.expanded ? FolderOpen : Folder };
	}

	getDefaultFileIcon(): ResolvedIcon | null {
		return { type: 'component', value: File };
	}

	getDefaultFolderIcon(options?: { expanded?: boolean }): ResolvedIcon | null {
		return { type: 'component', value: options?.expanded ? FolderOpen : Folder };
	}

	resolveProductIcon(iconName: string): ResolvedIcon | null {
		const productComp = this.getComponentByProduct(iconName);
		if (productComp) return { type: 'component', value: productComp };
		const comp = this.getComponentByLanguage(iconName);
		return comp ? { type: 'component', value: comp } : null;
	}

	private getComponentByProduct(name: string): any | null {
		const lower = name.toLowerCase().replace(/^callout-/, "");
		switch (lower) {
			case "note":
				return PencilSimple;
			case "abstract":
			case "summary":
			case "tldr":
				return Article;
			case "info":
				return Info;
			case "todo":
				return CheckSquare;
			case "tip":
			case "hint":
			case "important":
				return Lightbulb;
			case "success":
			case "check":
			case "done":
				return CheckCircle;
			case "question":
			case "help":
			case "faq":
				return Question;
			case "warning":
			case "caution":
			case "attention":
				return Warning;
			case "danger":
			case "error":
				return WarningOctagon;
			case "bug":
				return Bug;
			case "example":
				return Flask;
			case "quote":
			case "cite":
				return Quotes;
			case "failure":
			case "fail":
			case "missing":
				return XCircle;
			default:
				return null;
		}
	}

	private getComponentByExtension(ext: string): any | null {
		if (["md", "txt", "rtf"].includes(ext)) return FileText;
		if (["js", "ts", "jsx", "tsx", "py", "rs", "go", "cpp", "c", "java", "rb"].includes(ext)) return Code;
		if (["html", "css", "svelte", "svg"].includes(ext)) return Globe;
		if (["json", "yaml", "yml", "toml"].includes(ext)) return Gear;
		if (["sql", "db"].includes(ext)) return Database;
		return null;
	}

	private getComponentByLanguage(lang: string): any | null {
		const lowerName = lang.toLowerCase();
		if (lowerName === "language" || lowerName === "auto") return Globe;
		if (lowerName.includes("markdown")) return FileText;
		if (lowerName.includes("javascript") || lowerName.includes("typescript") || lowerName.includes("ts") || lowerName.includes("js")) return Code;
		if (lowerName.includes("html") || lowerName.includes("svelte") || lowerName.includes("css") || lowerName.includes("xml")) return Globe;
		if (lowerName.includes("sql")) return Database;
		if (lowerName.includes("json") || lowerName.includes("yaml") || lowerName.includes("toml") || lowerName.includes("ini")) return Gear;
		if (lowerName.includes("plain text") || lowerName.includes("text")) return FileText;
		return FileCode;
	}
}

const BUILTIN_FILE_THEME_IDS = new Set<string>([
	'phosphor',
	...builtinFileThemes.map((config) => config.id)
]);

export class IconRegistry implements IconRegistryInterface {
	activeFileThemeId = $state<string>('phosphor');
	activeProductThemeId = $state<string>('phosphor');
	currentAppearance = $state<'light' | 'dark'>('dark');

	private fileThemes = $state<Record<string, FileIconProvider>>({
		'phosphor': new PhosphorIconProvider()
	});
	private productThemes = $state<Record<string, ProductIconProvider>>({
		'phosphor': new PhosphorIconProvider()
	});

	async initialize(): Promise<void> {
		await Promise.all(
			builtinFileThemes.map(async (config) => {
				try {
					const themeUrl = `https://cdn.jsdelivr.net/gh/${config.repoUrl.replace('https://github.com/', '')}/${config.themePath}`;
					const theme = await fetchZedTheme(themeUrl);
					if (theme) {
						const provider = new ManifestIconProvider(config.id, config.name, theme, config.iconBaseUrl);
						this.registerFileTheme(config.id, provider);
					}
				} catch (e) {
					console.warn(`Failed to load builtin theme ${config.id}:`, e);
				}
			})
		);

		const installed = this.loadInstalledThemes();
		for (const installedTheme of installed) {
			try {
				const themeJson = await this.loadCachedTheme(installedTheme.id);
				if (themeJson) {
					const provider = new ManifestIconProvider(
						installedTheme.id,
						installedTheme.name,
						themeJson,
						installedTheme.baseUrl
					);
					this.registerFileTheme(installedTheme.id, provider);
				}
			} catch {
				console.warn(`Failed to load installed theme: ${installedTheme.id}`);
			}
		}
	}

	private loadInstalledThemes(): Array<{ id: string; name: string; baseUrl: string }> {
		if (typeof window === 'undefined') return [];
		try {
			const raw = localStorage.getItem('np-installed-icon-themes');
			if (!raw) return [];
			const parsed: unknown = JSON.parse(raw);
			if (!Array.isArray(parsed)) return [];
			return parsed.filter(
				(t): t is { id: string; name: string; baseUrl: string } =>
					typeof (t as any)?.id === 'string' &&
					typeof (t as any)?.name === 'string' &&
					typeof (t as any)?.baseUrl === 'string'
			);
		} catch {
			return [];
		}
	}

	private async loadCachedTheme(id: string): Promise<ZedIconTheme | null> {
		if (typeof window === 'undefined') return null;
		try {
			const raw = localStorage.getItem(`np-icon-theme-cache-${id}`);
			if (!raw) return null;
			return JSON.parse(raw);
		} catch {
			return null;
		}
	}

	registerFileTheme(id: string, provider: FileIconProvider) {
		this.fileThemes[id] = provider;
	}

	registerProductTheme(id: string, provider: ProductIconProvider) {
		this.productThemes[id] = provider;
	}

	getFileThemes(): ThemeInfo[] {
		return Object.keys(this.fileThemes).map(id => ({
			id,
			name: this.fileThemes[id].name || id,
			source: BUILTIN_FILE_THEME_IDS.has(id) ? 'builtin' : 'installed'
		}));
	}

	getProductThemes(): ThemeInfo[] {
		return Object.keys(this.productThemes).map(id => ({
			id,
			name: this.productThemes[id].name || id,
			source: id === 'phosphor' ? 'builtin' : 'installed'
		}));
	}

	setAppearance(appearance: 'light' | 'dark') {
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
		const activeProvider = this.fileThemes[this.activeFileThemeId] || this.fileThemes['phosphor'];
		const phosphor = this.fileThemes['phosphor'];

		const chain: ResolvedIcon[] = [];

		if (activeProvider) {
			const activeIcon = activeProvider.resolveFileIcon(filename, context);
			if (activeIcon) {
				chain.push(activeIcon);
			}

			const activeDefault = activeProvider.getDefaultFileIcon();
			if (activeDefault) {
				chain.push(activeDefault);
			}
		}

		if (phosphor && activeProvider?.id !== 'phosphor') {
			const phosphorIcon = phosphor.resolveFileIcon(filename, context);
			if (phosphorIcon) {
				chain.push(phosphorIcon);
			}

			const phosphorDefault = phosphor.getDefaultFileIcon();
			if (phosphorDefault) {
				chain.push(phosphorDefault);
			}
		}

		return chain;
	}

	resolveFolderIconChain(foldername: string, options?: { expanded?: boolean }): ResolvedIcon[] {
		const activeProvider = this.fileThemes[this.activeFileThemeId] || this.fileThemes['phosphor'];
		const phosphor = this.fileThemes['phosphor'];

		const chain: ResolvedIcon[] = [];

		if (activeProvider) {
			const activeIcon = activeProvider.resolveFolderIcon(foldername, options);
			if (activeIcon) {
				chain.push(activeIcon);
			}

			const activeDefault = activeProvider.getDefaultFolderIcon(options);
			if (activeDefault) {
				chain.push(activeDefault);
			}
		}

		if (phosphor && activeProvider?.id !== 'phosphor') {
			const phosphorIcon = phosphor.resolveFolderIcon(foldername, options);
			if (phosphorIcon) {
				chain.push(phosphorIcon);
			}

			const phosphorDefault = phosphor.getDefaultFolderIcon(options);
			if (phosphorDefault) {
				chain.push(phosphorDefault);
			}
		}

		return chain;
	}

	resolveProductIconChain(iconName: string): ResolvedIcon[] {
		const activeProvider = this.productThemes[this.activeProductThemeId] || this.productThemes['phosphor'];
		const phosphor = this.productThemes['phosphor'];

		const chain: ResolvedIcon[] = [];

		if (activeProvider) {
			const activeIcon = activeProvider.resolveProductIcon(iconName);
			if (activeIcon) {
				chain.push(activeIcon);
			}
		}

		if (phosphor && activeProvider?.id !== 'phosphor') {
			const phosphorIcon = phosphor.resolveProductIcon(iconName);
			if (phosphorIcon) {
				chain.push(phosphorIcon);
			}
		}

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

export const iconRegistry = new IconRegistry();
