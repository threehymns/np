import { File, FileCode, FileText, Code, Globe, Database, Gear } from "phosphor-svelte";

export interface IconProvider {
	getLanguageIcon(name: string): any | null;
	getFileIcon(filename: string): any | null;
}

class PhosphorIconProvider implements IconProvider {
	getLanguageIcon(name: string): any | null {
		const lowerName = name.toLowerCase();
		if (lowerName === "language" || lowerName === "auto") return Globe;
		if (lowerName.includes("markdown")) return FileText;
		if (lowerName.includes("javascript") || lowerName.includes("typescript") || lowerName.includes("ts") || lowerName.includes("js")) return Code;
		if (lowerName.includes("html") || lowerName.includes("svelte") || lowerName.includes("css") || lowerName.includes("xml")) return Globe;
		if (lowerName.includes("sql")) return Database;
		if (lowerName.includes("json") || lowerName.includes("yaml") || lowerName.includes("toml") || lowerName.includes("ini")) return Gear;
		if (lowerName.includes("plain text") || lowerName.includes("text")) return FileText;
		return FileCode; // generic code icon
	}

	getFileIcon(filename: string): any | null {
		const extension = filename.split(".").pop()?.toLowerCase();
		if (!extension) return FileText;
		if (["md", "txt", "rtf"].includes(extension)) return FileText;
		if (["js", "ts", "jsx", "tsx", "py", "rs", "go", "cpp", "c", "java", "rb"].includes(extension)) return Code;
		if (["html", "css", "svelte", "svg"].includes(extension)) return Globe;
		if (["json", "yaml", "yml", "toml"].includes(extension)) return Gear;
		if (["sql", "db"].includes(extension)) return Database;
		return File;
	}
}

export class IconRegistry {
	private providers = $state<IconProvider[]>([new PhosphorIconProvider()]);

	registerProvider(provider: IconProvider) {
		this.providers.unshift(provider);
	}

	getLanguageIcon(name: string): any {
		for (const provider of this.providers) {
			const icon = provider.getLanguageIcon(name);
			if (icon) return icon;
		}
		return FileCode;
	}

	getFileIcon(filename: string): any {
		for (const provider of this.providers) {
			const icon = provider.getFileIcon(filename);
			if (icon) return icon;
		}
		return File;
	}
}

export const iconRegistry = new IconRegistry();
