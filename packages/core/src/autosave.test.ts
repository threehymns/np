import { describe, expect, it } from 'bun:test';
import {
	AUTOSAVE_TRIGGERS,
	DEFAULT_AUTOSAVE_DELAY_MS,
	DEFAULT_AUTOSAVE_SETTING,
	MAX_AUTOSAVE_DELAY_MS,
	autosaveDelayMs,
	autosaveModeOf,
	isAutosaveEnabled,
	isAutosaveSetting,
	validateAutosaveSetting
} from './autosave';
import { EDITOR_SCHEMA, validateSettingValue } from './plugins/settings';

describe('autosave setting vocabulary', () => {
	it('defaults to off', () => {
		expect(DEFAULT_AUTOSAVE_SETTING).toBe('off');
		expect(DEFAULT_AUTOSAVE_DELAY_MS).toBe(1000);
		expect(AUTOSAVE_TRIGGERS).toEqual(['off', 'on_focus_change', 'on_window_change']);
	});

	it('folds the object form into the after_delay mode', () => {
		expect(autosaveModeOf('off')).toBe('off');
		expect(autosaveModeOf('on_focus_change')).toBe('on_focus_change');
		expect(autosaveModeOf('on_window_change')).toBe('on_window_change');
		expect(autosaveModeOf({ after_delay: { milliseconds: 250 } })).toBe('after_delay');
	});

	it('reports the delay only for the object form', () => {
		expect(autosaveDelayMs('off')).toBeNull();
		expect(autosaveDelayMs('on_focus_change')).toBeNull();
		expect(autosaveDelayMs('on_window_change')).toBeNull();
		expect(autosaveDelayMs({ after_delay: { milliseconds: 250 } })).toBe(250);
		expect(autosaveDelayMs({ after_delay: { milliseconds: 0 } })).toBe(0);
	});

	it('treats every named trigger and the delay form as enabled', () => {
		expect(isAutosaveEnabled('off')).toBe(false);
		expect(isAutosaveEnabled('on_focus_change')).toBe(true);
		expect(isAutosaveEnabled('on_window_change')).toBe(true);
		expect(isAutosaveEnabled({ after_delay: { milliseconds: 10 } })).toBe(true);
	});
});

describe('autosave setting validation', () => {
	it('accepts every documented form', () => {
		for (const value of [
			'off',
			'on_focus_change',
			'on_window_change',
			{ after_delay: { milliseconds: 0 } },
			{ after_delay: { milliseconds: 1000 } },
			{ after_delay: { milliseconds: MAX_AUTOSAVE_DELAY_MS } }
		]) {
			expect(validateAutosaveSetting(value)).toBe(true);
			expect(isAutosaveSetting(value)).toBe(true);
		}
	});

	it('rejects values outside the documented shapes with an actionable message', () => {
		for (const value of [
			'sometimes',
			'',
			true,
			42,
			[],
			{},
			{ after_delay: 1000 },
			{ after_delay: {} },
			{ after_delay: { milliseconds: '1000' } },
			{ after_delay: { milliseconds: -1 } },
			{ after_delay: { milliseconds: 1.5 } },
			{ after_delay: { milliseconds: Number.POSITIVE_INFINITY } },
			{ after_delay: { milliseconds: MAX_AUTOSAVE_DELAY_MS + 1 } }
		]) {
			expect(isAutosaveSetting(value)).toBe(false);
			const result = validateAutosaveSetting(value);
			expect(typeof result).toBe('string');
			expect(result).toContain('Auto-save');
		}
	});

	it('names the timer range when a delay is too large', () => {
		const result = validateAutosaveSetting({
			after_delay: { milliseconds: MAX_AUTOSAVE_DELAY_MS + 1 }
		});
		expect(result).toContain(String(MAX_AUTOSAVE_DELAY_MS));
	});

	it('is wired into the editor schema as a union with a schema-level validator', () => {
		const property = EDITOR_SCHEMA.properties.autosave;

		expect(property.type).toBe('json');
		expect(property.default).toBe('off');
		// An enum lists scalar allowed values; the delay form is an object, so
		// the validator is the authoritative list rather than a partial enum.
		expect(property.enum).toBeUndefined();
		expect(property.title).toBe('Auto-save');

		expect(
			validateSettingValue('editor', 'autosave', 'on_window_change', property).valid
		).toBe(true);
		expect(
			validateSettingValue(
				'editor',
				'autosave',
				{ after_delay: { milliseconds: 600 } },
				property
			).valid
		).toBe(true);
		expect(validateSettingValue('editor', 'autosave', 'later', property).valid).toBe(false);
		expect(
			validateSettingValue(
				'editor',
				'autosave',
				{ after_delay: { milliseconds: -5 } },
				property
			).valid
		).toBe(false);
	});
});
