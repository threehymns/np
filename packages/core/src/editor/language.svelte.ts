import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { svelte } from "@replit/codemirror-lang-svelte";

export interface LanguageInfo {
	name: string;
	alias: string[];
	extension: () => Promise<any>;
}

// Custom languages not in language-data
const extraLanguages: LanguageDescription[] = [
	LanguageDescription.of({
		name: "svelte",
		alias: ["sv", "svelte"],
		load: async () => svelte(),
	}),
];

export const allLanguages = [...languages, ...extraLanguages];

export class LanguageSupport {
	static getLanguageForFile(filename: string): LanguageDescription | null {
		const extension = filename.split(".").pop()?.toLowerCase();

		// Special cases or manual mapping if language-data doesn't cover it
		if (extension === "svelte") return extraLanguages[0];

		const exact = LanguageDescription.matchFilename(allLanguages, filename);
		if (exact) return exact;

		// language-data matching is case-sensitive, so `NOTES.MD` or
		// `APP.TS` miss on the first pass. Retry with a lowercased
		// extension — but never fall back to Markdown: unknown extensions
		// and extensionless files (Untitled scratchpads, LICENSE, ...)
		// resolve to null (plain text), so only files recognised as
		// Markdown use the markdown preview stack in getLanguageExtensions.
		const dot = filename.lastIndexOf(".");
		if (dot >= 0 && dot < filename.length - 1) {
			const lowered = filename.slice(0, dot + 1) + filename.slice(dot + 1).toLowerCase();
			if (lowered !== filename) {
				return LanguageDescription.matchFilename(allLanguages, lowered);
			}
		}
		return null;
	}

	static getMarkdown(): LanguageDescription {
		const markdown = allLanguages.find((l) => l.name === "Markdown");
		if (!markdown) throw new Error("Markdown language support is missing from @codemirror/language-data");
		return markdown;
	}

	static async loadLanguage(lang: LanguageDescription) {
		return await lang.load();
	}

	static preloadCommonLanguages(): void {
		const load = () => {
			const commonNames = new Set(['javascript', 'typescript', 'jsx', 'tsx', 'json', 'markdown', 'svelte', 'css', 'html']);
			const targetLangs = allLanguages.filter(l =>
				commonNames.has(l.name.toLowerCase()) || l.alias.some(a => commonNames.has(a.toLowerCase()))
			);
			for (const lang of targetLangs) {
				lang.load().catch(() => {});
			}
		};

		if (typeof globalThis !== 'undefined' && typeof (globalThis as any).requestIdleCallback === 'function') {
			(globalThis as any).requestIdleCallback(() => load());
		} else {
			setTimeout(load, 50);
		}
	}
}
