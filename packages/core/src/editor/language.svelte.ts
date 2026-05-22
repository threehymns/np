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
		return found || this.getMarkdown();
	}

	static getMarkdown(): LanguageDescription {
		return allLanguages.find((l) => l.name === "Markdown")!;
	}

	static async loadLanguage(lang: LanguageDescription) {
		return await lang.load();
	}
}
