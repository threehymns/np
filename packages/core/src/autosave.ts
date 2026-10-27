/**
 * Auto-save policy values for `editor.autosave`.
 *
 * The setting is either one of three named triggers or an object naming an
 * inactivity delay. It is deliberately a small closed vocabulary: the
 * Workspace reads it on every edit, focus change and window change, so an
 * unrecognised value has to fall back to `off` rather than invent a trigger.
 */

/** The named triggers, which are also the string forms of the setting. */
export const AUTOSAVE_TRIGGERS = ['off', 'on_focus_change', 'on_window_change'] as const;

export type AutosaveTrigger = (typeof AUTOSAVE_TRIGGERS)[number];

/** The selected mode: a named trigger, or the delay form's mode. */
export type AutosaveMode = AutosaveTrigger | 'after_delay';

/** The delay form of `editor.autosave`, in milliseconds. */
export interface AutosaveAfterDelay {
	after_delay: {
		milliseconds: number;
	};
}

export type AutosaveSetting = AutosaveTrigger | AutosaveAfterDelay;

/** Auto-save is off unless the user asks for it. */
export const DEFAULT_AUTOSAVE_SETTING: AutosaveSetting = 'off';

/**
 * The value the delay input starts from when the mode is first switched to
 * `after_delay`. A default only; the stored object always carries its own
 * milliseconds.
 */
export const DEFAULT_AUTOSAVE_DELAY_MS = 1000;

export function isAutosaveTrigger(value: unknown): value is AutosaveTrigger {
	return typeof value === 'string' && (AUTOSAVE_TRIGGERS as readonly string[]).includes(value);
}

/** A non-negative integer, matching the delay's unit: whole milliseconds. */
function isMilliseconds(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

/**
 * Validates a stored `editor.autosave` value.
 *
 * Returns `true` when the value is one of the named triggers or the exact
 * `{ after_delay: { milliseconds } }` shape, and a diagnostic message
 * otherwise. The message names the accepted forms so a hand-edited settings
 * file reports what to write rather than only that it is wrong.
 */
export function validateAutosaveSetting(value: unknown): true | string {
	if (typeof value === 'string') {
		if (isAutosaveTrigger(value)) return true;
		return `Auto-save must be one of: ${AUTOSAVE_TRIGGERS.map((mode) => JSON.stringify(mode)).join(', ')}`;
	}

	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return 'Auto-save must be "off", "on_focus_change", "on_window_change", or { "after_delay": { "milliseconds": <number> } }';
	}

	const afterDelay = (value as { after_delay?: unknown }).after_delay;
	if (typeof afterDelay !== 'object' || afterDelay === null || Array.isArray(afterDelay)) {
		return 'Auto-save object form requires an "after_delay" object';
	}

	const milliseconds = (afterDelay as { milliseconds?: unknown }).milliseconds;
	if (!isMilliseconds(milliseconds)) {
		return 'Auto-save "after_delay.milliseconds" must be a non-negative integer';
	}

	return true;
}

export function isAutosaveSetting(value: unknown): value is AutosaveSetting {
	return validateAutosaveSetting(value) === true;
}

/** The mode the setting selects, with the object form folded to `after_delay`. */
export function autosaveModeOf(setting: AutosaveSetting): AutosaveMode {
	return typeof setting === 'string' ? setting : 'after_delay';
}

/** The inactivity delay in milliseconds, or null for the named triggers. */
export function autosaveDelayMs(setting: AutosaveSetting): number | null {
	return typeof setting === 'object' ? setting.after_delay.milliseconds : null;
}

/** Whether the setting asks for auto-save on any trigger. */
export function isAutosaveEnabled(setting: AutosaveSetting): boolean {
	return setting !== 'off';
}
