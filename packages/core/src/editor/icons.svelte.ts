import { File, FileCode, FileText, Code, Globe, Database, Gear, Folder, FolderOpen } from "phosphor-svelte";
import type { ZedIconTheme, ResolvedZedTheme, ZedThemeVariant } from "./icons/zed-format";
import { resolveZedTheme } from "./icons/zed-format";
import type { ResolvedIcon, FileIconProvider, ProductIconProvider, IconQuery } from "./icons-types";

const COMMON_EXTENSION_FALLBACKS: Record<string, string> = {
	ts: 'typescript',
	js: 'javascript',
	html: 'html',
	jsx: 'react',
	tsx: 'react_ts',
	mjs: 'javascript',
	cjs: 'javascript',
};

const COMMON_LANGUAGE_FALLBACKS: Record<string, string> = {
	'typescript': 'typescript',
	'javascript': 'javascript',
	'html': 'html',
	'css': 'css',
	'python': 'python',
	'rust': 'rust',
	'go': 'go',
	'java': 'java',
	'ruby': 'ruby',
	'php': 'php',
	'sql': 'database',
	'json': 'json',
	'yaml': 'yaml',
	'toml': 'toml',
	'markdown': 'markdown',
	'svelte': 'svelte',
	'react': 'react',
	'vue': 'vue',
	'angular': 'angular',
	'docker': 'docker',
	'git': 'git',
};

const DIRECTORY_ALIASES: Record<string, string[]> = {
	'static': ['assets', 'asset', 'resource', 'resources'],
};

export class ManifestIconProvider implements FileIconProvider {
	private currentAppearance: 'light' | 'dark' = 'dark';
	private resolved: ResolvedZedTheme;
	private allVariants: ZedThemeVariant[];
	private baseUrl: string;
	private themeId: string;
	private themeName: string;

	constructor(id: string, name: string, theme: ZedIconTheme, baseUrl: string) {
		this.themeId = id;
		this.themeName = name;
		this.allVariants = theme.themes;
		this.baseUrl = baseUrl;

		const defaultVariant = theme.themes.find(t => t.appearance === 'dark') ?? theme.themes[0];
		this.resolved = resolveZedTheme(id, name, defaultVariant, baseUrl);
	}

	setAppearance(appearance: 'light' | 'dark') {
		this.currentAppearance = appearance;
		const variant = this.allVariants.find(t => t.appearance === appearance)
			?? this.allVariants.find(t => t.appearance === 'dark')
			?? this.allVariants[0];
		if (variant) {
			this.resolved = resolveZedTheme(this.themeId, this.themeName, variant, this.baseUrl);
		}
	}

	get name(): string {
		return this.themeName;
	}

	get id(): string {
		return this.themeId;
	}

	resolveFileIcon(filename: string, context?: { language?: string }): ResolvedIcon | null {
		const lowerName = filename.toLowerCase();

		// 1. Exact match against file_stems
		let stemKey = this.resolved.fileStems[lowerName];
		if (stemKey) {
			const url = this.resolved.fileIcons[stemKey];
			if (url) return { type: 'url', value: url };
		}

		// 2. Hidden files: strip leading dot if it is a hidden file and check stems
		if (filename.startsWith('.') && filename.length > 1) {
			const strippedDot = lowerName.slice(1);
			stemKey = this.resolved.fileStems[strippedDot];
			if (stemKey) {
				const url = this.resolved.fileIcons[stemKey];
				if (url) return { type: 'url', value: url };
			}
		}

		// 3. Suffix / Multi-extension resolution via split-once loop on '.'
		const parts = lowerName.split('.');
		for (let i = 1; i < parts.length; i++) {
			const suffix = parts.slice(i).join('.');
			const suffixKey = this.resolved.fileSuffixes[suffix]
				?? COMMON_EXTENSION_FALLBACKS[suffix];
			if (suffixKey) {
				const url = this.resolved.fileIcons[suffixKey];
				if (url) return { type: 'url', value: url };
			}
		}

		// 4. Standard extension check
		const ext = parts.pop() || '';
		const extKey = this.resolved.fileSuffixes[ext] ?? COMMON_EXTENSION_FALLBACKS[ext];
		if (extKey) {
			const url = this.resolved.fileIcons[extKey];
			if (url) return { type: 'url', value: url };
		}

		// 5. Language Mode fallback check
		if (context?.language) {
			const lowerLang = context.language.toLowerCase();
			const langKey = COMMON_LANGUAGE_FALLBACKS[lowerLang] ?? lowerLang;

			// Define candidates to check for the file icon key in the theme
			const candidates = [
				langKey,
				`_f_${langKey}`
			];

			// Translate language ID to its canonical extension key as a backup
			const langExtMap: Record<string, string> = {
				'javascript': 'js',
				'typescript': 'ts',
				'markdown': 'md',
				'python': 'py',
				'rust': 'rs',
				'ruby': 'rb',
				'react': 'jsx',
			};

			const ext = langExtMap[lowerLang];
			if (ext) {
				candidates.push(ext);
				candidates.push(`_f_${ext}`);
			}

			for (const cand of candidates) {
				const url = this.resolved.fileIcons[cand];
				if (url) return { type: 'url', value: url };
			}
		}

		return null;
	}

	resolveFolderIcon(folderName: string, options?: { expanded?: boolean }): ResolvedIcon | null {
		const lowerName = folderName.toLowerCase();

		// 1. Try exact match
		let specific = this.resolved.namedDirectories[lowerName];
		if (specific) {
			const url = options?.expanded ? specific.expanded : specific.collapsed;
			if (url) return { type: 'url', value: url };
		}

		// 2. Try stripping leading dot
		if (lowerName.startsWith('.') && lowerName.length > 1) {
			const stripped = lowerName.slice(1);
			specific = this.resolved.namedDirectories[stripped];
			if (specific) {
				const url = options?.expanded ? specific.expanded : specific.collapsed;
				if (url) return { type: 'url', value: url };
			}
		}

		// 3. Try folder aliases
		const aliases = DIRECTORY_ALIASES[lowerName];
		if (aliases) {
			for (const alias of aliases) {
				specific = this.resolved.namedDirectories[alias];
				if (specific) {
					const url = options?.expanded ? specific.expanded : specific.collapsed;
					if (url) return { type: 'url', value: url };
				}
			}
		}

		return null;
	}

	getDefaultFileIcon(): ResolvedIcon | null {
		const url = this.resolved.fileIcons['file']
			?? this.resolved.fileIcons['default']
			?? this.resolved.fileIcons['fallback'];
		return url ? { type: 'url', value: url } : null;
	}

	getDefaultFolderIcon(options?: { expanded?: boolean }): ResolvedIcon | null {
		const url = options?.expanded
			? (this.resolved.directoryExpanded || this.resolved.directoryCollapsed)
			: this.resolved.directoryCollapsed;
		return url ? { type: 'url', value: url } : null;
	}

	// Legacy compatibility methods for Playwright tests
	getFileIcon(filename: string): string | null {
		const resolved = this.resolveFileIcon(filename) ?? this.getDefaultFileIcon();
		return resolved?.type === 'url' ? resolved.value : null;
	}

	getFolderIcon(name: string): string | null {
		const resolved = this.resolveFolderIcon(name, { expanded: false });
		if (resolved?.type === 'url') return resolved.value;
		const def = this.getDefaultFolderIcon({ expanded: false });
		return def?.type === 'url' ? def.value : null;
	}
}

if (typeof window !== 'undefined') {
	(window as any).ManifestIconProvider = ManifestIconProvider;
}

class PhosphorIconProvider implements FileIconProvider, ProductIconProvider {
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
		const comp = this.getComponentByLanguage(iconName);
		return comp ? { type: 'component', value: comp } : null;
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

export interface ThemeInfo {
	id: string;
	name: string;
	source: 'builtin' | 'installed';
}

export class IconRegistry {
	activeFileThemeId = $state<string>('phosphor');
	activeProductThemeId = $state<string>('phosphor');
	currentAppearance = $state<'light' | 'dark'>('dark');

	private fileThemes = $state<Record<string, FileIconProvider>>({
		'phosphor': new PhosphorIconProvider()
	});
	private productThemes = $state<Record<string, ProductIconProvider>>({
		'phosphor': new PhosphorIconProvider()
	});

	constructor() {}

	async initialize() {
		const { builtinFileThemes, fetchZedTheme } = await import("./icons/builtin-themes");

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
			return JSON.parse(raw);
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
			source: id === 'phosphor' || id === 'material' || id === 'catppuccin' || id === 'vscode' ? 'builtin' : 'installed'
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

		const activeIcon = activeProvider.resolveFileIcon(filename, context);
		if (activeIcon) {
			chain.push(activeIcon);
		}

		const activeDefault = activeProvider.getDefaultFileIcon();
		if (activeDefault) {
			chain.push(activeDefault);
		}

		if (activeProvider.id !== 'phosphor') {
			const phosphorIcon = phosphor.resolveFileIcon(filename, context);
			if (phosphorIcon) {
				chain.push(phosphorIcon);
			}
		}

		const phosphorDefault = phosphor.getDefaultFileIcon();
		if (phosphorDefault) {
			chain.push(phosphorDefault);
		}

		return chain;
	}

	resolveFolderIconChain(foldername: string, options?: { expanded?: boolean }): ResolvedIcon[] {
		const activeProvider = this.fileThemes[this.activeFileThemeId] || this.fileThemes['phosphor'];
		const phosphor = this.fileThemes['phosphor'];

		const chain: ResolvedIcon[] = [];

		const activeIcon = activeProvider.resolveFolderIcon(foldername, options);
		if (activeIcon) {
			chain.push(activeIcon);
		}

		const activeDefault = activeProvider.getDefaultFolderIcon(options);
		if (activeDefault) {
			chain.push(activeDefault);
		}

		if (activeProvider.id !== 'phosphor') {
			const phosphorIcon = phosphor.resolveFolderIcon(foldername, options);
			if (phosphorIcon) {
				chain.push(phosphorIcon);
			}
		}

		const phosphorDefault = phosphor.getDefaultFolderIcon(options);
		if (phosphorDefault) {
			chain.push(phosphorDefault);
		}

		return chain;
	}

	resolveProductIconChain(iconName: string): ResolvedIcon[] {
		const activeProvider = this.productThemes[this.activeProductThemeId] || this.productThemes['phosphor'];
		const phosphor = this.productThemes['phosphor'];

		const chain: ResolvedIcon[] = [];

		const activeIcon = activeProvider.resolveProductIcon(iconName);
		if (activeIcon) {
			chain.push(activeIcon);
		}

		if (activeProvider.id !== 'phosphor') {
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
		if (!first || first.type === 'empty') return Folder;
		return first.value;
	}

	getFolderExpandedIcon(name: string): any {
		const chain = this.resolveFolderIconChain(name, { expanded: true });
		const first = chain[0];
		if (!first || first.type === 'empty') return FolderOpen;
		return first.value;
	}

	getThemeDefaultFileIcon(): any {
		const activeProvider = this.fileThemes[this.activeFileThemeId] || this.fileThemes['phosphor'];
		const first = activeProvider.getDefaultFileIcon();
		if (!first || first.type === 'empty') return File;
		return first.value;
	}

	getThemeDefaultFolderIcon(): any {
		const activeProvider = this.fileThemes[this.activeFileThemeId] || this.fileThemes['phosphor'];
		const first = activeProvider.getDefaultFolderIcon({ expanded: false });
		if (!first || first.type === 'empty') return Folder;
		return first.value;
	}

	getThemeDefaultFolderExpandedIcon(): any {
		const activeProvider = this.fileThemes[this.activeFileThemeId] || this.fileThemes['phosphor'];
		const first = activeProvider.getDefaultFolderIcon({ expanded: true });
		if (!first || first.type === 'empty') return FolderOpen;
		return first.value;
	}

	async installThemeFromGitHub(repoUrl: string): Promise<{ id: string; name: string } | null> {
		const { fetchZedTheme } = await import("./icons/builtin-themes");

		const normalizedUrl = this.normalizeGitHubUrl(repoUrl);
		if (!normalizedUrl) return null;

		const themeUrl = `https://cdn.jsdelivr.net/gh/${normalizedUrl.owner}/${normalizedUrl.repo}@${normalizedUrl.ref}/icon_themes/`;
		const theme = await fetchZedTheme(themeUrl);
		if (!theme) return null;

		const baseUrl = `https://cdn.jsdelivr.net/gh/${normalizedUrl.owner}/${normalizedUrl.repo}@${normalizedUrl.ref}/`;
		const id = `installed-${normalizedUrl.owner}-${normalizedUrl.repo}`;
		const name = theme.name || id;

		const provider = new ManifestIconProvider(id, name, theme, baseUrl);
		this.registerFileTheme(id, provider);

		this.cacheTheme(id, name, baseUrl, theme);

		return { id, name };
	}

	private normalizeGitHubUrl(url: string): { owner: string; repo: string; ref: string } | null {
		const cleaned = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
		const match = cleaned.match(/github\.com\/([^/]+)\/([^/@]+)(?:@(.+))?/);
		if (!match) return null;

		return {
			owner: match[1],
			repo: match[2],
			ref: match[3] || 'main',
		};
	}

	private cacheTheme(id: string, name: string, baseUrl: string, theme: ZedIconTheme) {
		if (typeof window === 'undefined') return;

		try {
			const installed = this.loadInstalledThemes();
			if (!installed.find(t => t.id === id)) {
				installed.push({ id, name, baseUrl });
				localStorage.setItem('np-installed-icon-themes', JSON.stringify(installed));
			}

			localStorage.setItem(`np-icon-theme-cache-${id}`, JSON.stringify(theme));
		} catch (e) {
			console.warn('Failed to cache theme:', e);
		}
	}

	async uninstallTheme(id: string) {
		if (id === 'phosphor' || id === 'material' || id === 'catppuccin' || id === 'vscode') return;

		delete this.fileThemes[id];

		if (this.activeFileThemeId === id) {
			this.activeFileThemeId = 'phosphor';
		}

		if (typeof window !== 'undefined') {
			try {
				const installed = this.loadInstalledThemes().filter(t => t.id !== id);
				localStorage.setItem('np-installed-icon-themes', JSON.stringify(installed));
				localStorage.removeItem(`np-icon-theme-cache-${id}`);
			} catch {
			}
		}
	}
}

export const iconRegistry = new IconRegistry();
