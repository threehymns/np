import type { SettingScope } from '@np/core';

/**
 * The notice shown when a setting declares `scope` that excludes the scope the
 * user is currently looking at. A setting allowed only at one scope cannot be
 * overridden at the other, so the notice has to name the scope that can edit
 * it - the one the user is not currently in. Getting this backwards tells a
 * user looking at User settings to go and edit their User settings.
 */
export interface ScopeRestrictionNotice {
	/** The scope the setting can actually be overridden at. */
	readonly allowedScope: SettingScope;
	/** Short badge text, e.g. "User scope only". */
	readonly badge: string;
	/** Sentence explaining where to go instead, e.g. "Edit in User settings." */
	readonly guidance: string;
}

function label(scope: SettingScope): string {
	return scope === 'user' ? 'User' : 'Workspace';
}

/**
 * Describes why a setting is not editable in the given scope. Returns null
 * when the setting declares no scope restriction, or allows the given scope.
 */
export function describeScopeRestriction(
	declaredScopes: readonly SettingScope[] | undefined,
	viewingScope: SettingScope
): ScopeRestrictionNotice | null {
	if (!declaredScopes || declaredScopes.includes(viewingScope)) {
		return null;
	}
	const allowedScope: SettingScope = declaredScopes.includes('user') ? 'user' : 'workspace';
	return {
		allowedScope,
		badge: `${label(allowedScope)} scope only`,
		guidance: `This setting cannot be overridden at ${label(viewingScope).toLowerCase()} level. Edit in ${label(allowedScope)} settings.`
	};
}
