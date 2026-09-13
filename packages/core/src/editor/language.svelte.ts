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
		const dot = filename.lastIndexOf(".");

		// Special cases or manual mapping if language-data doesn't cover it
		if (dot >= 0 && dot < filename.length - 1 && filename.slice(dot + 1).toLowerCase() === "svelte")
			return extraLanguages[0];

		const exact = LanguageDescription.matchFilename(allLanguages, filename);
		if (exact) return exact;

		// language-data matching is case-sensitive, so `NOTES.MD` or
		// `APP.TS` miss on the first pass. Retry with a lowercased
		// extension — but never fall back to Markdown: unknown extensions
		// and extensionless files (Untitled scratchpads, LICENSE, ...)
		// resolve to null (plain text), so only files recognised as
		// Markdown use the markdown preview stack in getLanguageExtensions.
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
}
