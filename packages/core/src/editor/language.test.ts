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
		expect(LanguageSupport.getLanguageForFile("file.markdown")?.name).toBe("Markdown");
		expect(LanguageSupport.getLanguageForFile("notes.MD")?.name).toBe("Markdown");
	});

	it("never resolves non-markdown files to the Markdown preview language", () => {
		// Unknown extensions resolve to null (plain text), never Markdown,
		// so they can't pick up the markdown preview stack in
		// getLanguageExtensions (is-markdown class, wikilinks, hideMarkers).
		expect(LanguageSupport.getLanguageForFile("file.unknown")).toBeNull();
		expect(LanguageSupport.getLanguageForFile("data.xyz")).toBeNull();
		// Extensionless files (Untitled scratchpads, LICENSE, Makefile,
		// README) are not Markdown either.
		expect(LanguageSupport.getLanguageForFile("Untitled")).toBeNull();
		expect(LanguageSupport.getLanguageForFile("LICENSE")).toBeNull();
		expect(LanguageSupport.getLanguageForFile("Makefile")).toBeNull();
		expect(LanguageSupport.getLanguageForFile("README")).toBeNull();
		// Known non-markdown languages still resolve to themselves.
		expect(LanguageSupport.getLanguageForFile("script.py")?.name).toBe("Python");
		expect(LanguageSupport.getLanguageForFile("Dockerfile")?.name).toBe("Dockerfile");
		// Extension matching is case-insensitive: uppercase extensions
		// resolve to their real language, never to the Markdown fallback.
		expect(LanguageSupport.getLanguageForFile("APP.TS")?.name).toBe("TypeScript");
	});

	it("preloads common languages without errors", async () => {
		LanguageSupport.preloadCommonLanguages();
		const tsx = LanguageSupport.getLanguageForFile("page.tsx");
		expect(tsx).not.toBeNull();
		const support = await LanguageSupport.loadLanguage(tsx!);
		expect(support).toBeDefined();
	});
});
