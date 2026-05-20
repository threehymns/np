import { File, FileCode, FileText, Code, Globe, Database, Gear, Folder, FolderOpen } from "phosphor-svelte";
import type { IconPackManifest } from "./icons/default-themes";

export interface IconProvider {
	getIconByExactName?(name: string): any | null;
	getIconByExtension?(ext: string): any | null;
	getIconByLanguage?(lang: string): any | null;
	getDefaultIcon?(): any | null;

	getFolderIcon?(name: string): any | null;
	getFolderExpandedIcon?(name: string): any | null;

	getLanguageIcon(name: string): any | null;
	getFileIcon(filename: string): any | null;
	setFlavor?(flavor: string | null): void;
}

export class ManifestIconProvider implements IconProvider {
	private currentFlavor: string | null = null;

	constructor(public manifest: IconPackManifest) {}

	setFlavor(flavor: string | null) {
		this.currentFlavor = flavor;
	}

	private getBaseUrl(): string {
		if (this.manifest.id === 'catppuccin' && this.currentFlavor) {
			return `${this.manifest.baseUrl}${this.currentFlavor}/`;
		}
		return this.manifest.baseUrl;
	}

	getIconByExactName(name: string): string | null {
		const lowerFilename = name.toLowerCase();
		if (this.manifest.fileNames) {
			for (const [key, value] of Object.entries(this.manifest.fileNames)) {
				if (key.toLowerCase() === lowerFilename) {
					return `${this.getBaseUrl()}${value}`;
				}
			}
		}
		return null;
	}

	getIconByExtension(ext: string): string | null {
		const extension = ext.toLowerCase();
		if (this.manifest.fileExtensions) {
			for (const [key, value] of Object.entries(this.manifest.fileExtensions)) {
				if (key.toLowerCase() === extension) {
					return `${this.getBaseUrl()}${value}`;
				}
			}
		}
		return null;
	}

	getIconByLanguage(lang: string): string | null {
		const lowerName = lang.toLowerCase();
		if (this.manifest.languageIds) {
			for (const [key, value] of Object.entries(this.manifest.languageIds)) {
				if (key.toLowerCase() === lowerName) {
					return `${this.getBaseUrl()}${value}`;
				}
			}
		}
		return null;
	}

	getDefaultIcon(): string | null {
		if (this.manifest.defaultIcon) {
			return `${this.getBaseUrl()}${this.manifest.defaultIcon}`;
		}
		return null;
	}

	getFolderIcon(name: string): string | null {
		const lowerName = name.toLowerCase();
		if (this.manifest.folderNames) {
			for (const [key, value] of Object.entries(this.manifest.folderNames)) {
				if (key.toLowerCase() === lowerName) {
					return `${this.getBaseUrl()}${value}`;
				}
			}
		}
		if (this.manifest.folder) {
			return `${this.getBaseUrl()}${this.manifest.folder}`;
		}
		return null;
	}

	getFolderExpandedIcon(name: string): string | null {
		const lowerName = name.toLowerCase();
		if (this.manifest.folderNamesExpanded) {
			for (const [key, value] of Object.entries(this.manifest.folderNamesExpanded)) {
				if (key.toLowerCase() === lowerName) {
					return `${this.getBaseUrl()}${value}`;
				}
			}
		}
		if (this.manifest.folderExpanded) {
			return `${this.getBaseUrl()}${this.manifest.folderExpanded}`;
		}
		return this.getFolderIcon(name);
	}

	getLanguageIcon(name: string): string | null {
		return this.getIconByLanguage(name);
	}

	getFileIcon(filename: string): string | null {
		const ext = filename.split(".").pop()?.toLowerCase() || '';
		return this.getIconByExactName(filename) || this.getIconByExtension(ext) || this.getDefaultIcon();
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
}

import { vscodeIconsManifest, materialIconsManifest, catppuccinIconsManifest } from "./icons/default-themes";

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
		this.registerFileTheme('vscode', new ManifestIconProvider(vscodeIconsManifest));
		this.registerFileTheme('material', new ManifestIconProvider(materialIconsManifest));
		this.registerFileTheme('catppuccin', new ManifestIconProvider(catppuccinIconsManifest));
	}

	updateCatppuccinFlavor(theme: string) {
		const catppuccinProvider = this.fileThemes['catppuccin'] as ManifestIconProvider;
		if (catppuccinProvider && catppuccinProvider.setFlavor) {
			if (theme === 'catppuccin-latte') catppuccinProvider.setFlavor('latte');
			else if (theme === 'catppuccin-frappe') catppuccinProvider.setFlavor('frappe');
			else if (theme === 'catppuccin-macchiato') catppuccinProvider.setFlavor('macchiato');
			else if (theme === 'catppuccin-mocha') catppuccinProvider.setFlavor('mocha');
			else catppuccinProvider.setFlavor('mocha'); // Default
		}
	}

	registerFileTheme(id: string, provider: IconProvider) {
		this.fileThemes[id] = provider;
	}

	registerProductTheme(id: string, provider: IconProvider) {
		this.productThemes[id] = provider;
	}

	getFileThemes() {
		return Object.keys(this.fileThemes).map(id => ({
			id,
			name: (this.fileThemes[id] as any).manifest?.name || (id === 'phosphor' ? 'Phosphor' : id)
		}));
	}

	getProductThemes() {
		return Object.keys(this.productThemes).map(id => ({
			id,
			name: (this.productThemes[id] as any).manifest?.name || (id === 'phosphor' ? 'Phosphor' : id)
		}));
	}

	resolveFileIcon(filename: string, languageModeName?: string): any {
		const provider = this.fileThemes[this.activeFileThemeId] || this.fileThemes['phosphor'];

		// 1. Exact filename match
		if (provider.getIconByExactName) {
			const icon = provider.getIconByExactName(filename);
			if (icon) return icon;
		}

		// 2. File extension match
		const extension = filename.split('.').pop()?.toLowerCase() || '';
		if (extension && provider.getIconByExtension) {
			const icon = provider.getIconByExtension(extension);
			if (icon) return icon;
		}

		// 3. Language Mode name match
		if (languageModeName && provider.getIconByLanguage) {
			const icon = provider.getIconByLanguage(languageModeName);
			if (icon) return icon;
		}

		// 4. Fallback default icon in current theme
		if (provider.getDefaultIcon) {
			const icon = provider.getDefaultIcon();
			if (icon) return icon;
		}

		// 5. Global fallback to Phosphor default
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
		return this.fileThemes['phosphor'].getFolderIcon ? this.fileThemes['phosphor'].getFolderIcon(name) : Folder;
	}

	getFolderExpandedIcon(name: string): any {
		const provider = this.fileThemes[this.activeFileThemeId] || this.fileThemes['phosphor'];
		if (provider.getFolderExpandedIcon) {
			const icon = provider.getFolderExpandedIcon(name);
			if (icon) return icon;
		}
		return this.fileThemes['phosphor'].getFolderExpandedIcon ? this.fileThemes['phosphor'].getFolderExpandedIcon(name) : FolderOpen;
	}
}

export const iconRegistry = new IconRegistry();
