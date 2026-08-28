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
		if (!extension) return this.getMarkdown();

		// Special cases or manual mapping if language-data doesn't cover it
		if (extension === "svelte") return extraLanguages[0];

		const found = LanguageDescription.matchFilename(allLanguages, filename);
		return (found || this.getMarkdown()) as LanguageDescription;
	}

	static getMarkdown(): LanguageDescription {
		return allLanguages.find((l) => l.name === "Markdown") as LanguageDescription;
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

		if (typeof window !== 'undefined') {
			if (typeof window.requestIdleCallback === 'function') {
				window.requestIdleCallback(() => load());
			} else {
				setTimeout(load, 50);
			}
		} else {
			load();
		}
	}
}
