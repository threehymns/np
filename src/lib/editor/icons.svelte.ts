import { File, FileCode, FileText, Code, Globe, Database, Gear } from "phosphor-svelte";
import type { IconPackManifest } from "./icons/default-themes";

export interface IconProvider {
	getIconByExactName?(name: string): any | null;
	getIconByExtension?(ext: string): any | null;
	getIconByLanguage?(lang: string): any | null;
	getDefaultIcon?(): any | null;

	getLanguageIcon(name: string): any | null;
	getFileIcon(filename: string): any | null;
}

export class ManifestIconProvider implements IconProvider {
	constructor(public manifest: IconPackManifest) {}

	getIconByExactName(name: string): string | null {
		const lowerFilename = name.toLowerCase();
		if (this.manifest.fileNames) {
			for (const [key, value] of Object.entries(this.manifest.fileNames)) {
				if (key.toLowerCase() === lowerFilename) {
					return `${this.manifest.baseUrl}${value}`;
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
					return `${this.manifest.baseUrl}${value}`;
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
					return `${this.manifest.baseUrl}${value}`;
				}
			}
		}
		return null;
	}

	getDefaultIcon(): string | null {
		if (this.manifest.defaultIcon) {
			return `${this.manifest.baseUrl}${this.manifest.defaultIcon}`;
		}
		return null;
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
}

export const iconRegistry = new IconRegistry();

