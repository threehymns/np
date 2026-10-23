import {
	EDITOR_SETTINGS_NAMESPACE,
	LANGUAGE_OVERRIDES_SETTING,
	type SettingScope
} from '@np/core';

/**
 * The slice of the settings API the per-language override box needs: read one
 * scope's own value, and write one scope's own value.
 *
 * The box edits one scope at a time, so it must never read or write the
 * resolved value. The resolved value of `editor.languages` is the two scopes
 * folded together (ADR 0031), and a box that showed the folded map and saved
 * it back would put one scope's entries into the other scope's file: a
 * personal override into a repository's shared settings, or a repository's
 * override into the user's own settings.
 */
export interface ScopeOverrideSettings {
	/** The value one scope stores for one key, with no other scope folded in. */
	getScopeValue<T = any>(namespace: string, key: string, scope: SettingScope): T | undefined;
	/** Writes one scope's value for one key. */
	set<T = any>(namespace: string, key: string, value: T, scope: SettingScope): void;
}

/**
 * The per-language override map one scope owns, with no other scope folded in.
 *
 * A scope that stores no map at all owns an empty one: the box then shows
 * `{}` rather than the other scope's entries, which is the whole point.
 */
export function scopeLanguageOverrides(
	settings: ScopeOverrideSettings,
	scope: SettingScope
): Record<string, unknown> {
	const own = settings.getScopeValue(
		EDITOR_SETTINGS_NAMESPACE,
		LANGUAGE_OVERRIDES_SETTING,
		scope
	);
	if (!own || typeof own !== 'object' || Array.isArray(own)) return {};
	return own as Record<string, unknown>;
}

/**
 * The text the box shows for one scope: that scope's own map, pretty-printed.
 */
export function languageOverridesText(
	settings: ScopeOverrideSettings,
	scope: SettingScope
): string {
	return JSON.stringify(scopeLanguageOverrides(settings, scope), null, 2);
}

/**
 * Writes the box's text back into the scope the box is editing.
 *
 * Throws when the text is not JSON, so the caller can show the parse error and
 * leave the stored value alone.
 */
export function writeLanguageOverrides(
	settings: ScopeOverrideSettings,
	scope: SettingScope,
	draft: string
): void {
	settings.set(
		EDITOR_SETTINGS_NAMESPACE,
		LANGUAGE_OVERRIDES_SETTING,
		JSON.parse(draft),
		scope
	);
}
