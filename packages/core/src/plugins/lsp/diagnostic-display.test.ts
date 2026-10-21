import { describe, expect, it } from 'bun:test';
import {
	DEFAULT_DIAGNOSTIC_DISPLAY_SETTINGS,
	planDiagnosticDisplay,
	readDiagnosticDisplaySettings,
	visibleDiagnostics,
	type DiagnosticGutterMark
} from './diagnostic-display';
import { LSP_SCHEMA } from './settings';
import { SettingsResolver } from '../settings';
import type { LspDiagnostic, LspDiagnosticSeverity } from './diagnostics';

/**
 * The display decisions, as a pure function of the findings and the settings
 * (issue #310).
 *
 * The editor surfaces — the inline marks, the gutter marks, and the diagnostics
 * list that arrives with #309 — all read this module rather than the store, so
 * that a severity ceiling means one thing in all of them. The narrowing lives
 * here because a rule each surface applied on its own would be three rules to
 * keep in step, and the drift is invisible until an error shows in the list
 * and not in the text.
 */

function finding(
	severity: LspDiagnosticSeverity,
	line = 0,
	message = `${severity} finding`
): LspDiagnostic {
	return {
		server: 'typescript@/repo',
		range: { start: { line, character: 0 }, end: { line, character: 4 } },
		severity,
		message,
		source: null,
		code: null
	};
}

/**
 * A gutter mark as the test reads it: the line, the severity, how many
 * findings it stands for, and what they say.
 */
function markOf(mark: DiagnosticGutterMark) {
	return {
		line: mark.line,
		severity: mark.severity,
		count: mark.count,
		messages: mark.findings.map((finding) => finding.message)
	};
}

describe('The severity ceiling (#310)', () => {
	it('shows the findings at least as severe as the ceiling', () => {
		const findings = [finding('error'), finding('warning'), finding('info'), finding('hint')];

		expect(visibleDiagnostics(findings, 'hint').map((d) => d.severity)).toEqual([
			'error',
			'warning',
			'info',
			'hint'
		]);
		expect(visibleDiagnostics(findings, 'warning').map((d) => d.severity)).toEqual([
			'error',
			'warning'
		]);
		expect(visibleDiagnostics(findings, 'error').map((d) => d.severity)).toEqual(['error']);
	});

	it('hides nothing until the ceiling is narrowed', () => {
		// The default is the most permissive severity, so a user who has never
		// touched the setting sees what the server said.
		expect(DEFAULT_DIAGNOSTIC_DISPLAY_SETTINGS.maxSeverity).toBe('hint');

		const findings = [finding('error'), finding('warning'), finding('info'), finding('hint')];
		expect(
			visibleDiagnostics(findings, DEFAULT_DIAGNOSTIC_DISPLAY_SETTINGS.maxSeverity)
		).toHaveLength(4);
	});

	it('hides nothing for a ceiling that cannot be read', () => {
		// A ceiling is the user's answer about what to leave out, and an answer
		// that cannot be read must not leave anything out.
		const findings = [finding('error'), finding('hint')];
		expect(visibleDiagnostics(findings, 'loud' as LspDiagnosticSeverity)).toHaveLength(2);
	});

	it('narrows the inline marks and the gutter marks by the same ceiling', () => {
		const plan = planDiagnosticDisplay([finding('error', 0), finding('hint', 1)], {
			inline: true,
			maxSeverity: 'error'
		});

		expect(plan.inline.map((d) => d.severity)).toEqual(['error']);
		expect(plan.gutter.map(markOf)).toEqual([
			{ line: 0, severity: 'error', count: 1, messages: ['error finding'] }
		]);
	});
});

describe('The inline toggle (#310)', () => {
	it('turns the inline marks off without touching the gutter marks', () => {
		const findings = [finding('error', 0), finding('warning', 1)];

		const shown = planDiagnosticDisplay(findings, { inline: true, maxSeverity: 'hint' });
		const hidden = planDiagnosticDisplay(findings, { inline: false, maxSeverity: 'hint' });

		expect(shown.inline).toHaveLength(2);
		expect(hidden.inline).toHaveLength(0);
		// The gutter is its own surface: turning the underlines off must not take
		// the line markers with them, or "inline off" would mean "diagnostics off".
		expect(hidden.gutter).toEqual(shown.gutter);
	});
});

describe('The gutter marks (#310)', () => {
	it('gives each line one mark carrying its worst finding and how many it has', () => {
		const plan = planDiagnosticDisplay(
			[finding('info', 0, 'first'), finding('error', 0, 'second'), finding('hint', 2, 'third')],
			{ inline: true, maxSeverity: 'hint' }
		);

		expect(plan.gutter.map(markOf)).toEqual([
			{ line: 0, severity: 'error', count: 2, messages: ['first', 'second'] },
			{ line: 2, severity: 'hint', count: 1, messages: ['third'] }
		]);
	});

	it('keeps the marks in document order', () => {
		const plan = planDiagnosticDisplay(
			[finding('error', 5), finding('warning', 1), finding('info', 3)],
			{ inline: true, maxSeverity: 'hint' }
		);

		expect(plan.gutter.map((mark) => mark.line)).toEqual([1, 3, 5]);
	});
});

describe('Reading the display settings (#310)', () => {
	it('takes the values the resolver layers', () => {
		const resolver = new SettingsResolver(
			() => LSP_SCHEMA,
			() => ({ lsp: { inline_diagnostics: false, max_severity: 'warning' } })
		);

		expect(readDiagnosticDisplaySettings((namespace, key) => resolver.get(namespace, key))).toEqual({
			inline: false,
			maxSeverity: 'warning'
		});
	});

	it('lets the workspace scope win over the user scope', () => {
		const resolver = new SettingsResolver(
			() => LSP_SCHEMA,
			() => ({ lsp: { max_severity: 'warning' } }),
			() => ({ lsp: { max_severity: 'error' } })
		);

		expect(
			readDiagnosticDisplaySettings((namespace, key) => resolver.get(namespace, key)).maxSeverity
		).toBe('error');
	});

	it('keeps the documented defaults for an app that publishes no reader', () => {
		expect(readDiagnosticDisplaySettings(undefined)).toEqual({
			inline: true,
			maxSeverity: 'hint'
		});
	});

	it('keeps the defaults for a value the schema would have rejected', () => {
		const resolver = new SettingsResolver(
			() => LSP_SCHEMA,
			() => ({ lsp: { inline_diagnostics: 'no', max_severity: 'loud' } })
		);

		expect(readDiagnosticDisplaySettings((namespace, key) => resolver.get(namespace, key))).toEqual({
			inline: true,
			maxSeverity: 'hint'
		});
	});
});
