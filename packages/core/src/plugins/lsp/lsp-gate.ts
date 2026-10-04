import { scopeForLanguage } from '../language-scope';
import {
	EDITOR_COMPLETION_DEFAULTS,
	EDITOR_SETTINGS_NAMESPACE,
	LANGUAGE_OVERRIDES_SETTING,
	LSP_SETTING
} from '../settings';
import type { SettingsRead } from '../services';

/**
 * What `editor.lsp` gates (spec #263).
 *
 * The setting is per language and it gates *the server for documents of that
 * language*: a document whose language has it off is not scoped to a server, is
 * not synced, and is not diagnosed. It still gets notes and words. The three
 * clauses are one decision rather than three settings because "off" that left a
 * running server, a synced document and a painted gutter would read as the bug
 * this replaces — a user who turns a switch off and watches errors keep arriving
 * concludes the switch is broken.
 *
 * ## Per document, not per process
 *
 * One descriptor serves several languages — the TypeScript descriptor serves
 * `TypeScript`, `TSX`, `JavaScript` and `JSX` — and one process serves all of
 * them. So the gate has to be per *document*: a `.tsx` with `lsp: false` is
 * declined while a `.ts` with `lsp: true` starts and syncs the shared process.
 * A per-process gate would be the wrong shape for the same reason a per-language
 * key is: turning `lsp` off for TSX would then also silence TypeScript, and the
 * two are independent answers to independent questions.
 *
 * ## Turning it off does not stop a server
 *
 * Turning `lsp` off for a language stops new starts for that language and stops
 * syncing it. It deliberately does **not** tear down a server other documents are
 * still using — that is the same per-process error from the other side, and it
 * would mean a settings toggle kills processes that other open files depend on,
 * which is worse than the bug it fixes. The process goes on explicit stop or
 * restart, or when the plugin is disabled, exactly as before.
 *
 * ## Resolution is on the way out of the memo
 *
 * {@link LspTargetResolver} memoizes a target per file against the descriptor
 * registry's revision, and a settings change does not move that revision. The
 * gate therefore reads the setting on every use, *outside* the memo: a value
 * cached while `lsp` was on would otherwise keep a server running for a language
 * the user has since turned off, which is the failure this whole slice is about.
 */

/**
 * Reads `editor.lsp` for one language, narrowed the way the editor's completion
 * source narrows it.
 *
 * Deliberately the same fold and the same narrowing as
 * `readServerCompletionSettings` on the UI side, because the two must agree: the
 * source that settles `inactive` and the runtime that declines to start are
 * answering one question from two places, and a divergence would show up as a
 * language that stops offering completions without stopping its server, or the
 * reverse. Only `false` turns a language off, so a missing value, an absent
 * reader and a hand-edited nonsense value all keep the documented default —
 * which is `true`, and is also what an app that publishes no reader gets.
 */
export function lspEnabledFor(read: SettingsRead, languageName: string | null): boolean {
	const editorLevel = { lsp: read(EDITOR_SETTINGS_NAMESPACE, LSP_SETTING) };
	const scoped = scopeForLanguage(
		editorLevel,
		read(EDITOR_SETTINGS_NAMESPACE, LANGUAGE_OVERRIDES_SETTING),
		languageName
	);
	return (scoped.value.lsp ?? EDITOR_COMPLETION_DEFAULTS.lsp) !== false;
}

/**
 * The same answer, phrased for a user who has to read it.
 *
 * Kept next to {@link lspEnabledFor} so the runtime's decline, the logs and the
 * status menu all say one thing, and so the wording cannot drift into describing
 * only the completion path the way the setting's own description used to.
 */
export function lspDisabledReason(languageName: string | null): string {
	return `Language servers are off for ${languageName ?? 'this language'}, so this document is not scoped to a server, not synced and not diagnosed. Notes and words are unaffected.`;
}
