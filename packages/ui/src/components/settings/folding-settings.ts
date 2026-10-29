import {
	DOCUMENT_FOLDING_RANGES_SETTING,
	EDITOR_SETTINGS_NAMESPACE,
	GUTTER_SETTING,
	type SettingScope
} from '@np/core';
import type { ScopeOverrideSettings } from './language-overrides';

/**
 * The fold gutter and document-folding controls edit one scope at a time, so
 * they read that scope's own stored value rather than the resolved one. The
 * resolved value folds the other scope in, and writing it back would copy one
 * scope's entries into the other.
 */

const DEFAULT_GUTTER_FOLDS = true;
const DEFAULT_DOCUMENT_FOLDING_RANGES = 'off' as const;

function readScopeGutter(settings: ScopeOverrideSettings, scope: SettingScope): unknown {
	return settings.getScopeValue(EDITOR_SETTINGS_NAMESPACE, GUTTER_SETTING, scope);
}

/**
 * The fold-gutter value one scope stores, normalized to a boolean. A scope
 * with no stored value shows the schema default.
 */
export function scopeGutterFolds(
	settings: ScopeOverrideSettings,
	scope: SettingScope = 'user'
): boolean {
	const own = readScopeGutter(settings, scope);
	if (typeof own === 'boolean') return own;
	if (own && typeof own === 'object' && !Array.isArray(own) && 'folds' in own) {
		return Boolean((own as { folds?: unknown }).folds);
	}
	return DEFAULT_GUTTER_FOLDS;
}

/**
 * Writes the fold-gutter toggle into the scope the control shows, preserving
 * any sibling keys the scope already stores for the gutter object.
 */
export function writeScopeGutterFolds(
	settings: ScopeOverrideSettings,
	scope: SettingScope,
	folds: boolean
): void {
	const own = readScopeGutter(settings, scope);
	const next =
		own && typeof own === 'object' && !Array.isArray(own)
			? { ...own, folds }
			: { folds };
	settings.set(EDITOR_SETTINGS_NAMESPACE, GUTTER_SETTING, next, scope);
}

/**
 * The document-folding-ranges value one scope stores, normalized to 'off' or
 * 'on'. A scope with no stored value shows the schema default.
 */
export function scopeDocumentFoldingRanges(
	settings: ScopeOverrideSettings,
	scope: SettingScope = 'user'
): 'off' | 'on' {
	const own = settings.getScopeValue(
		EDITOR_SETTINGS_NAMESPACE,
		DOCUMENT_FOLDING_RANGES_SETTING,
		scope
	);
	return own === 'on' || own === true ? 'on' : DEFAULT_DOCUMENT_FOLDING_RANGES;
}

/** Writes the document-folding-ranges selector into the scope it shows. */
export function writeScopeDocumentFoldingRanges(
	settings: ScopeOverrideSettings,
	scope: SettingScope,
	value: 'off' | 'on'
): void {
	settings.set(
		EDITOR_SETTINGS_NAMESPACE,
		DOCUMENT_FOLDING_RANGES_SETTING,
		value,
		scope
	);
}
