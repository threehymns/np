import type { SettingsRead } from '../services';
import {
	DIAGNOSTIC_SEVERITIES,
	INLINE_DIAGNOSTICS_SETTING,
	LSP_SETTINGS_NAMESPACE,
	MAX_SEVERITY_SETTING
} from './settings';
import type { LspDiagnostic, LspDiagnosticSeverity } from './diagnostics';

/**
 * What the editor shows of a document's findings, decided in one place
 * (issue #310).
 *
 * Three surfaces show findings — the inline marks, the gutter marks, and the
 * diagnostics list that arrives with #309 — and they have to agree about which
 * findings are shown at all. So the narrowing is here rather than in each of
 * them: a ceiling applied per surface is three rules to keep in step, and the
 * drift is invisible until an error shows in the list and not in the text.
 *
 * The module is plain on purpose. It reads findings, never the protocol, and
 * it knows nothing about the editor: the decoration layer is what turns a plan
 * into marks, and the plan is what a surface asks for. That is the same split
 * the store makes between the protocol and the display (ADR 0022), one layer
 * further down.
 */

/**
 * How findings are shown, as the two settings say it.
 */
export interface DiagnosticDisplaySettings {
	/** Whether findings are painted into the text. */
	readonly inline: boolean;
	/** The most severe finding any surface shows. */
	readonly maxSeverity: LspDiagnosticSeverity;
}

/**
 * The documented defaults: findings are painted, and nothing is hidden.
 *
 * A missing reader — an app that publishes no settings reader at all — gets
 * these, which is the same answer "no platform published" already gives
 * everywhere else in the plugin.
 */
export const DEFAULT_DIAGNOSTIC_DISPLAY_SETTINGS: DiagnosticDisplaySettings = {
	inline: true,
	maxSeverity: 'hint'
};

/**
 * One mark in the gutter, standing for every finding on one line.
 */
export interface DiagnosticGutterMark {
	/** The line the mark stands for, as the protocol numbers lines. */
	readonly line: number;
	/** The most severe finding on that line. */
	readonly severity: LspDiagnosticSeverity;
	/** How many findings that line carries. */
	readonly count: number;
	/**
	 * The findings the mark stands for, in the store's order.
	 *
	 * The findings rather than their messages, because a mark says what it
	 * stands for and the surface says how to phrase it: the inline mark's
	 * tooltip names the source and the code, and the gutter's says the same
	 * thing about the same finding.
	 */
	readonly findings: readonly LspDiagnostic[];
}

/**
 * What a surface draws for one document.
 */
export interface DiagnosticDisplayPlan {
	/** The findings painted into the text, in the store's order. */
	readonly inline: readonly LspDiagnostic[];
	/** One mark per line that carries a finding, in document order. */
	readonly gutter: readonly DiagnosticGutterMark[];
}

/**
 * Reads the two settings through the resolver.
 *
 * Only `false` turns the inline marks off, as every other boolean in the app
 * does: a value the schema would have rejected, or one hand-edited past it,
 * must not cost the user their underlines. A severity that is not one of the
 * four falls back to the documented default, which hides nothing.
 */
export function readDiagnosticDisplaySettings(
	read: SettingsRead | undefined
): DiagnosticDisplaySettings {
	if (!read) return DEFAULT_DIAGNOSTIC_DISPLAY_SETTINGS;
	const inline = read(LSP_SETTINGS_NAMESPACE, INLINE_DIAGNOSTICS_SETTING);
	const maxSeverity = read(LSP_SETTINGS_NAMESPACE, MAX_SEVERITY_SETTING);
	return {
		inline: inline !== false,
		maxSeverity: isDiagnosticSeverity(maxSeverity)
			? maxSeverity
			: DEFAULT_DIAGNOSTIC_DISPLAY_SETTINGS.maxSeverity
	};
}

/**
 * The findings a surface shows, narrowed by the severity ceiling.
 *
 * The one narrowing every surface goes through: the inline marks, the gutter
 * marks, and the diagnostics list of #309, which reads this function rather
 * than the store. A finding is shown when it is at least as severe as the
 * ceiling, so a ceiling of `error` shows errors and a ceiling of `hint` — the
 * default — shows everything.
 */
export function visibleDiagnostics(
	diagnostics: readonly LspDiagnostic[],
	maxSeverity: LspDiagnosticSeverity
): readonly LspDiagnostic[] {
	// A ceiling that is not one of the four hides nothing: a ceiling is the
	// user's answer about what to leave out, and an answer that cannot be read
	// must not leave anything out.
	const limit = isDiagnosticSeverity(maxSeverity)
		? severityRank(maxSeverity)
		: DIAGNOSTIC_SEVERITIES.length - 1;
	return diagnostics.filter((diagnostic) => severityRank(diagnostic.severity) <= limit);
}

/**
 * The plan for one document: what is painted, and what the gutter carries.
 *
 * The inline toggle and the severity ceiling are independent. The toggle says
 * whether findings are painted into the text and nothing else, so the gutter
 * marks — and the diagnostics list — are the same with it on and off. The
 * ceiling says how severe a finding has to be to be shown at all, and it says
 * it to every surface.
 */
export function planDiagnosticDisplay(
	diagnostics: readonly LspDiagnostic[],
	settings: DiagnosticDisplaySettings
): DiagnosticDisplayPlan {
	const visible = visibleDiagnostics(diagnostics, settings.maxSeverity);
	return {
		inline: settings.inline ? visible : [],
		gutter: gutterMarks(visible)
	};
}

/**
 * Whether a severity is one of the protocol's four.
 */
export function isDiagnosticSeverity(value: unknown): value is LspDiagnosticSeverity {
	return (
		typeof value === 'string' &&
		(DIAGNOSTIC_SEVERITIES as readonly string[]).includes(value)
	);
}

/**
 * Whether one severity is more severe than another.
 *
 * The order lives here so that every surface asking "which of these two is
 * worse" asks the same module: an answer derived from the severity strings
 * themselves would put the vocabulary in a second place, and the drift would
 * show as a line marked as a warning that carries an error.
 */
export function isMoreSevere(
	severity: LspDiagnosticSeverity,
	than: LspDiagnosticSeverity
): boolean {
	return severityRank(severity) < severityRank(than);
}

/**
 * How severe a finding is, as a rank: lower is more severe.
 *
 * The order is the protocol's own (ADR 0022's severities, most severe first),
 * so the ceiling reads as "at least as severe as this one".
 */
function severityRank(severity: LspDiagnosticSeverity): number {
	const rank = DIAGNOSTIC_SEVERITIES.indexOf(severity);
	// A severity the protocol never named is treated as the most severe one:
	// hiding a finding whose severity we cannot read is how a build failure
	// disappears.
	return rank === -1 ? 0 : rank;
}

/**
 * One mark per line that carries a finding.
 *
 * A line is marked once rather than once per finding: a gutter with three
 * markers on one line says less than one marker that says there are three.
 * The mark carries the line's worst severity, because a line with an error and
 * a hint is an error line, and a mark showing the hint would hide the error.
 */
function gutterMarks(diagnostics: readonly LspDiagnostic[]): DiagnosticGutterMark[] {
	const byLine = new Map<
		number,
		{ severity: LspDiagnosticSeverity; findings: LspDiagnostic[] }
	>();
	for (const diagnostic of diagnostics) {
		const line = diagnostic.range.start.line;
		const existing = byLine.get(line);
		if (!existing) {
			byLine.set(line, { severity: diagnostic.severity, findings: [diagnostic] });
			continue;
		}
		existing.findings.push(diagnostic);
		if (isMoreSevere(diagnostic.severity, existing.severity)) {
			existing.severity = diagnostic.severity;
		}
	}
	return [...byLine.entries()]
		.sort(([left], [right]) => left - right)
		.map(([line, mark]) => ({
			line,
			severity: mark.severity,
			count: mark.findings.length,
			findings: mark.findings
		}));
}
