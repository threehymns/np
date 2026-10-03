import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

export interface LanguageInfo {
	name: string;
	alias: string[];
	extension: () => Promise<any>;
}

/**
 * Seeded base table (host-owned, lowest priority). The shared language table
 * stays host-seeded data rather than a hundred plugin rows; Svelte and any
 * future language arrive via plugin transforms, not static imports here.
 * No grammar import lives in this module, so the startup graph contains no
 * eager grammar — every grammar loads on first use through its loader.
 */
export const allLanguages: LanguageDescription[] = [...languages];

/** Active registry snapshot, synced by the host on every rebuild. */
class ActiveLanguageStore {
	descriptions = $state<LanguageDescription[]>([...languages]);
}

const activeStore = new ActiveLanguageStore();

/**
 * Host sync hook: replaces the active snapshot with the rebuilt registry
 * (seeded base plus plugin transforms in activation order). Called on every
 * register, remove, enable, or disable; each call corresponds to a
 * `languageRevision` bump on the host.
 */
export function syncActiveLanguageDescriptions(descriptions: LanguageDescription[]): void {
	activeStore.descriptions = [...descriptions];
}

/** Registry snapshot in registration order (seeded base first). */
export function getActiveLanguages(): LanguageDescription[] {
	return activeStore.descriptions;
}

export class LanguageSupport {
	static getLanguageForFile(filename: string): LanguageDescription | null {
		const snapshot = activeStore.descriptions;
		if (snapshot.length === 0) return null;

		// Latest-first so later registrations override earlier ones (single
		// precedence rule). Seeded base counts as the earliest registration.
		const ordered = [...snapshot].reverse();
		const exact = LanguageDescription.matchFilename(ordered, filename);
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
				return LanguageDescription.matchFilename(ordered, lowered);
			}
		}
		return null;
	}

	static getMarkdown(): LanguageDescription {
		const markdown = activeStore.descriptions.find((l) => l.name === "Markdown");
		if (!markdown) throw new Error("Markdown language support is missing from @codemirror/language-data");
		return markdown;
	}

	static async loadLanguage(lang: LanguageDescription) {
		return await lang.load();
	}
}
