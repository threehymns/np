import { describe, it, expect } from "bun:test";
import { LanguageSupport, allLanguages } from "./language.svelte";

describe("LanguageSupport", () => {
	it("resolves language description for common file extensions", () => {
		expect(LanguageSupport.getLanguageForFile("file.ts")?.name).toBe("TypeScript");
		expect(LanguageSupport.getLanguageForFile("file.tsx")?.name).toBe("TSX");
		expect(LanguageSupport.getLanguageForFile("file.js")?.name).toBe("JavaScript");
		expect(LanguageSupport.getLanguageForFile("file.jsx")?.name).toBe("JSX");
		expect(LanguageSupport.getLanguageForFile("file.json")?.name).toBe("JSON");
		expect(LanguageSupport.getLanguageForFile("file.svelte")?.name).toBe("svelte");
		expect(LanguageSupport.getLanguageForFile("file.md")?.name).toBe("Markdown");
		expect(LanguageSupport.getLanguageForFile("file.unknown")?.name).toBe("Markdown");
	});

	it("preloads common languages without errors", async () => {
		LanguageSupport.preloadCommonLanguages();
		const tsx = LanguageSupport.getLanguageForFile("page.tsx");
		expect(tsx).not.toBeNull();
		const support = await LanguageSupport.loadLanguage(tsx!);
		expect(support).toBeDefined();
	});
});
