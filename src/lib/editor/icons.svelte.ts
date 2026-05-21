import { File, FileCode, FileText, Code, Globe, Database, Gear, Folder, FolderOpen } from "phosphor-svelte";
import type { ZedIconTheme, ResolvedZedTheme, ZedThemeVariant } from "./icons/zed-format";
import { resolveZedTheme } from "./icons/zed-format";

export interface IconProvider {
	getIconByExactName?(name: string): any | null;
	getIconByExtension?(ext: string): any | null;
	getIconByLanguage?(lang: string): any | null;
	getDefaultIcon?(): any | null;

	getFolderIcon?(name: string): any | null;
	getFolderExpandedIcon?(name: string): any | null;

	getLanguageIcon(name: string): any | null;
	getFileIcon(filename: string): any | null;
	setAppearance?(appearance: 'light' | 'dark'): void;
}

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

export class ManifestIconProvider implements IconProvider {
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

	getIconByExactName(name: string): string | null {
		const lowerFilename = name.toLowerCase();
		const iconKey = this.resolved.fileStems[lowerFilename];
		if (iconKey) {
			return this.resolved.fileIcons[iconKey] || null;
		}
		return null;
	}

	getIconByExtension(ext: string): string | null {
		const extension = ext.toLowerCase();
		const iconKey = this.resolved.fileSuffixes[extension]
			?? COMMON_EXTENSION_FALLBACKS[extension];
		if (iconKey) {
			return this.resolved.fileIcons[iconKey] || null;
		}
		return null;
	}

	getIconByLanguage(lang: string): string | null {
		const lowerName = lang.toLowerCase();
		const iconKey = COMMON_LANGUAGE_FALLBACKS[lowerName] ?? lowerName;
		const icon = this.resolved.fileIcons[iconKey];
		if (icon) return icon;
		return null;
	}

	getDefaultIcon(): string | null {
		return this.resolved.fileIcons['file'] || null;
	}

	getFolderIcon(name: string): string | null {
		const lowerName = name.toLowerCase();
		const specific = this.resolved.namedDirectories[lowerName];
		if (specific) return specific.collapsed;
		return this.resolved.directoryCollapsed;
	}

	getFolderExpandedIcon(name: string): string | null {
		const lowerName = name.toLowerCase();
		const specific = this.resolved.namedDirectories[lowerName];
		if (specific) return specific.expanded;
		return this.resolved.directoryExpanded || this.resolved.directoryCollapsed;
	}

	getLanguageIcon(name: string): string | null {
		return this.getIconByLanguage(name);
	}

	getFileIcon(filename: string): string | null {
		const ext = filename.split(".").pop()?.toLowerCase() || '';
		return this.getIconByExactName(filename) || this.getIconByExtension(ext) || this.getDefaultIcon();
	}

	get name(): string {
		return this.themeName;
	}

	get id(): string {
		return this.themeId;
	}
}

if (typeof window !== 'undefined') {
	(window as any).ManifestIconProvider = ManifestIconProvider;
}

class PhosphorIconProvider implements IconProvider {
	getIconByExactName(name: string): any | null {
		return null;
	}

	getIconByExtension(ext: string): any | null {
		const extension = ext.toLowerCase();
		if (["md", "txt", "rtf"].includes(extension)) return FileText;
		if (["js", "ts", "jsx", "tsx", "py", "rs", "go", "cpp", "c", "java", "rb"].includes(extension)) return Code;
		if (["html", "css", "svelte", "svg"].includes(extension)) return Globe;
		if (["json", "yaml", "yml", "toml"].includes(extension)) return Gear;
		if (["sql", "db"].includes(extension)) return Database;
		return null;
	}

	getIconByLanguage(lang: string): any | null {
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

	getDefaultIcon(): any | null {
		return File;
	}

	getFolderIcon(name: string): any | null {
		return Folder;
	}

	getFolderExpandedIcon(name: string): any | null {
		return FolderOpen;
	}

	getLanguageIcon(name: string): any | null {
		return this.getIconByLanguage(name);
	}

	getFileIcon(filename: string): any | null {
		const ext = filename.split(".").pop()?.toLowerCase() || '';
		return this.getIconByExtension(ext) || this.getDefaultIcon();
	}

	get name(): string {
		return 'Phosphor';
	}

	get id(): string {
		return 'phosphor';
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

	private fileThemes = $state<Record<string, IconProvider>>({
		'phosphor': new PhosphorIconProvider()
	});
	private productThemes = $state<Record<string, IconProvider>>({
		'phosphor': new PhosphorIconProvider()
	});

	constructor() {
	}

	async initialize() {
		const { builtinFileThemes, fetchZedTheme } = await import("./icons/builtin-themes");

		for (const config of builtinFileThemes) {
			const themeUrl = `https://cdn.jsdelivr.net/gh/${config.repoUrl.replace('https://github.com/', '')}/${config.themePath}`;
			const theme = await fetchZedTheme(themeUrl);
			if (!theme) continue;

			const provider = new ManifestIconProvider(config.id, config.name, theme, config.iconBaseUrl);
			this.registerFileTheme(config.id, provider);
		}

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

	registerFileTheme(id: string, provider: IconProvider) {
		this.fileThemes[id] = provider;
	}

	registerProductTheme(id: string, provider: IconProvider) {
		this.productThemes[id] = provider;
	}

	getFileThemes(): ThemeInfo[] {
		return Object.keys(this.fileThemes).map(id => ({
			id,
			name: (this.fileThemes[id] as any).name || id,
			source: id === 'phosphor' || id === 'material' || id === 'catppuccin' || id === 'vscode' ? 'builtin' : 'installed'
		}));
	}

	getProductThemes(): ThemeInfo[] {
		return Object.keys(this.productThemes).map(id => ({
			id,
			name: (this.productThemes[id] as any).name || id,
			source: id === 'phosphor' ? 'builtin' : 'installed'
		}));
	}

	resolveFileIcon(filename: string, languageModeName?: string): any {
		const provider = this.fileThemes[this.activeFileThemeId] || this.fileThemes['phosphor'];

		if (provider.getIconByExactName) {
			const icon = provider.getIconByExactName(filename);
			if (icon) return icon;
		}

		const extension = filename.split('.').pop()?.toLowerCase() || '';
		if (extension && provider.getIconByExtension) {
			const icon = provider.getIconByExtension(extension);
			if (icon) return icon;
		}

		if (languageModeName && provider.getIconByLanguage) {
			const icon = provider.getIconByLanguage(languageModeName);
			if (icon) return icon;
		}

		if (provider.getDefaultIcon) {
			const icon = provider.getDefaultIcon();
			if (icon) return icon;
		}

		const phosphor = this.fileThemes['phosphor'];
		return phosphor.getDefaultIcon ? phosphor.getDefaultIcon() : null;
	}

	resolveProductIcon(iconName: string): any {
		const provider = this.productThemes[this.activeProductThemeId] || this.productThemes['phosphor'];
		if (provider.getIconByExactName) {
			const icon = provider.getIconByExactName(iconName);
			if (icon) return icon;
		}
		const phosphor = this.productThemes['phosphor'];
		return phosphor.getLanguageIcon(iconName);
	}

	getLanguageIcon(name: string): any {
		const provider = this.fileThemes[this.activeFileThemeId] || this.fileThemes['phosphor'];
		if (provider.getIconByLanguage) {
			const icon = provider.getIconByLanguage(name);
			if (icon) return icon;
		}
		return this.fileThemes['phosphor'].getLanguageIcon(name);
	}

	getFileIcon(filename: string): any {
		return this.resolveFileIcon(filename);
	}

	getFolderIcon(name: string): any {
		const provider = this.fileThemes[this.activeFileThemeId] || this.fileThemes['phosphor'];
		if (provider.getFolderIcon) {
			const icon = provider.getFolderIcon(name);
			if (icon) return icon;
		}
		if (provider.getFolderIcon) {
			const defaultFolder = provider.getFolderIcon('');
			if (defaultFolder) return defaultFolder;
		}
		return this.fileThemes['phosphor'].getFolderIcon ? this.fileThemes['phosphor'].getFolderIcon(name) : Folder;
	}

	getFolderExpandedIcon(name: string): any {
		const provider = this.fileThemes[this.activeFileThemeId] || this.fileThemes['phosphor'];
		if (provider.getFolderExpandedIcon) {
			const icon = provider.getFolderExpandedIcon(name);
			if (icon) return icon;
		}
		if (provider.getFolderExpandedIcon) {
			const defaultFolderExpanded = provider.getFolderExpandedIcon('');
			if (defaultFolderExpanded) return defaultFolderExpanded;
		}
		return this.fileThemes['phosphor'].getFolderExpandedIcon ? this.fileThemes['phosphor'].getFolderExpandedIcon(name) : FolderOpen;
	}

	getThemeDefaultFileIcon(): any {
		const provider = this.fileThemes[this.activeFileThemeId] || this.fileThemes['phosphor'];
		return provider.getDefaultIcon ? provider.getDefaultIcon() : File;
	}

	getThemeDefaultFolderIcon(): any {
		const provider = this.fileThemes[this.activeFileThemeId] || this.fileThemes['phosphor'];
		return provider.getFolderIcon ? provider.getFolderIcon('') : Folder;
	}

	getThemeDefaultFolderExpandedIcon(): any {
		const provider = this.fileThemes[this.activeFileThemeId] || this.fileThemes['phosphor'];
		return provider.getFolderExpandedIcon ? provider.getFolderExpandedIcon('') : FolderOpen;
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
