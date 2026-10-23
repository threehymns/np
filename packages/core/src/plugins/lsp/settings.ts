import type { SettingNamespaceSchema } from '../settings';
import type { LspDiagnosticSeverity } from './diagnostics';

/**
 * The settings the language-server plugin owns (ADR 0014, issue #310).
 *
 * A plugin-owned namespace rather than two more keys in the host's `editor`
 * namespace, and the reason is the same one ADR 0014 gives: a namespace has one
 * owner, and `editor` belongs to the host's core settings. A plugin that
 * widened it would either collide with that owner — the registry refuses two
 * owners for one namespace — or smuggle its keys into a tree it does not own,
 * where a user reading `editor` could not tell which keys the editor answers
 * for and which the language server does.
 *
 * What is here is about how diagnostics are *shown*, not about whether a server
 * runs: `editor.lsp` already decides that, per language, and it lives with the
 * editor because it is a question about the document rather than about the
 * plugin's own display. These two are the plugin's own display choices, and a
 * plugin that is disabled takes them with it.
 */
export const LSP_SETTINGS_NAMESPACE = 'lsp';

/** Whether diagnostics are painted into the text. */
export const INLINE_DIAGNOSTICS_SETTING = 'inline_diagnostics';

/** The most severe diagnostic any surface shows. */
export const MAX_SEVERITY_SETTING = 'max_severity';

/**
 * The severities the protocol names, most severe first.
 *
 * The protocol's own order, and the order the ceiling is read in: `error` is
 * the most severe, `hint` the least, so a ceiling of `hint` lets everything
 * through and a ceiling of `error` lets only errors through. The list is the
 * severity vocabulary, so it is written once here rather than spelled out in
 * the schema, the module that narrows by it, and the test that pins it.
 */
export const DIAGNOSTIC_SEVERITIES = [
	'error',
	'warning',
	'info',
	'hint'
] as const satisfies readonly LspDiagnosticSeverity[];

/**
 * The plugin's settings namespace.
 *
 * The severity ceiling defaults to `hint`, the most permissive of the four, so
 * a user who has never touched the setting sees exactly what the server said.
 * The alternative — defaulting to `error` — would hide warnings and hints on
 * every machine that had not been told otherwise, and a diagnostic that is
 * hidden by default is a diagnostic nobody knows is there.
 */
export const LSP_SCHEMA: SettingNamespaceSchema = {
	namespace: LSP_SETTINGS_NAMESPACE,
	title: 'Language Servers',
	description: 'How language-server diagnostics are shown',
	properties: {
		inline_diagnostics: {
			type: 'boolean',
			default: true,
			title: 'Inline Diagnostics',
			description:
				'Underline diagnostics in the text. Off leaves the gutter marks and the diagnostics list untouched',
			control: 'toggle'
		},
		max_severity: {
			type: 'string',
			default: 'hint',
			title: 'Maximum Severity',
			description:
				'The most severe diagnostic shown, everywhere diagnostics are shown. Hints show everything, errors show only errors',
			enum: DIAGNOSTIC_SEVERITIES,
			control: 'select'
		}
	}
};
