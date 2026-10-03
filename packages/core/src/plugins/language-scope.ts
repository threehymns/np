/**
 * Per-language scoping for editor settings (spec #259).
 *
 * `editor.languages` holds one override object per language name, so a setting
 * can have an editor-level value and a per-language answer:
 *
 * ```json
 * { "editor": { "words": "enabled", "min_word_length": 3,
 *               "languages": { "Markdown": { "words": "disabled" },
 *                              "TypeScript": { "min_word_length": 2 } } } }
 * ```
 *
 * This is deliberately *not* a widening of the layered `SettingsResolver`
 * (default < user < workspace): that model reports provenance for one key at
 * one scope, and a language is a third axis that would ripple through the
 * settings UI. One pure fold over the override map keeps the scoping in a
 * function that can be read and tested on its own.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" && value !== null && !Array.isArray(value)
	);
}

/**
 * Folds one language's overrides over the editor-level values.
 *
 * `languagesMap` is the `editor.languages` object; `language` is the document's
 * language name, matched case-insensitively — the same rule
 * `getContributionsForType` and the language registry use when they join on a
 * language name. `null`/`undefined` (plain text, or a language-less document)
 * and an unknown name both resolve to the editor-level values unchanged.
 *
 * Everything here degrades to the default rather than throwing: the map comes
 * from a hand-editable settings file, so a non-object map, an array, or an
 * entry that is not an object must cost the user their overrides and nothing
 * else. Keys inside the override object are not validated — that is the owning
 * setting's schema's job, and this function only places them.
 */
export function resolveLanguageScoped<T>(
	defaultValue: T,
	languagesMap: unknown,
	language: string | null | undefined
): T {
	if (!isRecord(languagesMap)) return defaultValue;
	if (typeof language !== 'string') return defaultValue;

	const target = language.trim().toLowerCase();
	if (target === '') return defaultValue;

	for (const [name, override] of Object.entries(languagesMap)) {
		if (name.trim().toLowerCase() !== target) continue;
		if (!isRecord(override)) return defaultValue;
		if (!isRecord(defaultValue)) return defaultValue;
		return { ...defaultValue, ...override } as T;
	}

	return defaultValue;
}