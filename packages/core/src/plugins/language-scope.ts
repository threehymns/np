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
 *
 * Known limitation, deliberately not fixed in this slice: because the fold
 * bypasses the resolver, a language override cannot itself be layered per
 * user/workspace scope — the last editor value the resolver produced for a
 * key is the one the override replaces, whichever scope that value came from.
 * Layering the language axis properly means giving the resolver a per-language
 * query and re-reporting provenance for it (ADR 0014); until then the two
 * axes compose by fold, and a user-scope `languages` map is overwritten by a
 * workspace-scope one rather than merged into it.
 */

import {
	EDITOR_COMPLETION_DEFAULTS,
	EDITOR_SETTINGS_NAMESPACE,
	LANGUAGE_OVERRIDES_SETTING
} from './settings';
import type { SettingsRead } from './services';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The editor-level values with one language's overrides folded over them, plus
 * which keys that language's entry actually contributed.
 *
 * The key list is what lets a caller tell "this language has no opinion about
 * this setting" apart from "this language said the same thing the default
 * said" — both arrive as the same value once the fold is done, and the two
 * need different answers. `readBufferWordSettings` is the case in point: prose
 * is quiet by default, and only an explicit override of *that* key may turn it
 * off, so an entry that tuned `min_word_length` must not count as a vote.
 */
export interface LanguageScoped<T> {
	readonly value: T;
	/** Keys this language's own entry supplied, empty when it had none. */
	readonly keys: readonly string[];
}

/**
 * Folds one language's overrides over the editor-level values.
 *
 * `languagesMap` is the `editor.languages` object; `language` is the document's
 * language name, matched case-insensitively — the same rule
 * `getContributionsForType` and the language registry use when they join on a
 * language name. `null`/`undefined` (plain text, or a language-less document)
 * and an unknown name both resolve to the editor-level values unchanged, with
 * no contributed keys.
 *
 * Everything here degrades to the default rather than throwing: the map comes
 * from a hand-editable settings file, so a non-object map, an array, or an
 * entry that is not an object must cost the user their overrides and nothing
 * else. Keys inside the override object are not validated — that is the owning
 * setting's schema's job, and this function only places them.
 */
export function scopeForLanguage<T>(
	defaultValue: T,
	languagesMap: unknown,
	language: string | null | undefined
): LanguageScoped<T> {
	const untouched: LanguageScoped<T> = { value: defaultValue, keys: [] };

	if (!isRecord(languagesMap)) return untouched;
	if (typeof language !== 'string') return untouched;

	const target = language.trim().toLowerCase();
	if (target === '') return untouched;

	for (const [name, override] of Object.entries(languagesMap)) {
		if (name.trim().toLowerCase() !== target) continue;
		if (!isRecord(override)) return untouched;
		if (!isRecord(defaultValue)) return untouched;
		return {
			value: { ...defaultValue, ...override } as T,
			keys: Object.keys(override)
		};
	}

	return untouched;
}

/**
 * The `editor` namespace's values for `keys`, with one language's
 * `editor.languages` overrides folded over them.
 *
 * One function for every reader rather than one per reader. The fold is a rule,
 * and a rule written once on each side of the package boundary is two answers to
 * one question right up until they drift — and the drift is invisible, because
 * both sides still agree on every input either of them happens to be shown.
 * The keys are a parameter because the readers genuinely differ in shape: the
 * editor's completion source resolves four at once and the LSP runtime's
 * `editor.lsp` gate resolves one.
 *
 * Values come back as the reader handed them over, `unknown` per key, because
 * narrowing is the owning setting's job: the gate wants a yes or a no and the
 * source wants a typed struct, and neither is the other's business. Which keys
 * an override actually supplied is still reported, so a caller can keep telling
 * "this language said nothing" from "this language agreed with the default".
 */
export function editorSettingsForLanguage(
	read: SettingsRead,
	language: string | null | undefined,
	keys: readonly string[]
): LanguageScoped<Readonly<Record<string, unknown>>> {
	const editorLevel: Record<string, unknown> = {};
	for (const key of keys) {
		editorLevel[key] = read(EDITOR_SETTINGS_NAMESPACE, key);
	}
	return scopeForLanguage(
		editorLevel,
		read(EDITOR_SETTINGS_NAMESPACE, LANGUAGE_OVERRIDES_SETTING),
		language
	);
}

/**
 * `editor.lsp`, narrowed to a yes or a no, for a value {@link
 * editorSettingsForLanguage} has already scoped.
 *
 * Only an explicit `false` turns a language off, so a missing value, a malformed
 * override and a hand-edited nonsense value all keep the documented default —
 * which is `true`, and is also what an app that publishes no reader at all gets.
 * Silence has to read as "the documented default" and never as "off": a switch
 * that silently withholds servers is the failure this whole slice is about.
 *
 * Shared for the same reason as the fold. The runtime that declines to start a
 * server and the source that settles `inactive` answer one question from two
 * packages, and a divergence shows as a language that stops offering completions
 * without stopping its server, or the reverse.
 */
export function editorLspEnabled(value: unknown): boolean {
	return (value ?? EDITOR_COMPLETION_DEFAULTS.lsp) !== false;
}
