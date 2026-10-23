/**
 * The project-wide diagnostics tab's model (spec #309, issue #309).
 *
 * The tab is a view over the merged diagnostics store: the workspace owns the
 * tab and the session behind it — the severity filter and the sort order the
 * reader chose — while the diagnostics themselves come from the store the LSP
 * plugin publishes (ADR 0008, ADR 0022, ADR 0029). Nothing here knows the
 * protocol: the severity levels below are the four a tab shows a diagnostic
 * under, and the plugin maps its own codes onto them.
 */

/**
 * How serious a diagnostic is.
 *
 * The order of the words is the order of the severity: the first is the most
 * serious. It is the order the tab sorts by when the reader asks for severity,
 * so the two cannot drift apart by accident.
 */
export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

/**
 * The severity filter, or `all` for every diagnostic.
 *
 * One severity at a time rather than a set: a reader narrows to what they are
 * looking for, and a set would have to say what "everything but hints" means
 * before the first filter is even chosen.
 */
export type DiagnosticsSeverityFilter = 'all' | DiagnosticSeverity;

/**
 * The order the tab shows diagnostics in.
 *
 * `severity` puts the most serious first, then the file, then the position in
 * it. `path` reads the project as a tree of files, in the order the files come.
 */
export type DiagnosticsSort = 'severity' | 'path';

/** Tab id of the diagnostics tab. */
export const DIAGNOSTICS_TAB_ID = '__diagnostics__';

/** Title of the diagnostics tab, as the tab strip shows it. */
export const DIAGNOSTICS_TAB_TITLE = 'Diagnostics';

/**
 * What the reader chose for one diagnostics tab.
 *
 * Held per tab, not per window: two diagnostics tabs in two panes are two
 * readers, and one of them narrowing to errors says nothing about the other.
 * The state is reactive because the tab's controls write to it and the list
 * reads from it, and neither of them is a component.
 */
export class DiagnosticsSession {
	filter = $state<DiagnosticsSeverityFilter>('all');
	sort = $state<DiagnosticsSort>('severity');
}
