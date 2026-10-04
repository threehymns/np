import { editorLspEnabled, editorSettingsForLanguage } from '../language-scope';
import { LSP_SETTING } from '../settings';
import type { SettingsRead } from '../services';

/**
 * What `editor.lsp` gates (spec #263).
 *
 * The setting is per language and it gates *the server for documents of that
 * language*: a document whose language has it off is not scoped to a server, is
 * not synced, and is not diagnosed. It still gets notes and words. The three
 * clauses are one decision rather than three settings because "off" that left a
 * synced document, a painted gutter or a server with nothing left to serve would
 * read as the bug this replaces — a user who turns a switch off and watches errors
 * keep arriving concludes the switch is broken.
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
 * ## Turning it off stops a server nothing is served from
 *
 * Turning `lsp` off for a language stops new starts for that language and stops
 * syncing it. It does not tear down a server another document is still using —
 * that is the same per-process error from the other side, and it would mean a
 * settings toggle kills a process that other open files depend on, which is worse
 * than the bug it fixes.
 *
 * What it does do is stop a server that has no enabled document left. That is not
 * a different rule at the tail; it is the per-document rule run out: a process
 * with nothing to serve is not a server the user has, and leaving it in the status
 * list shows a process with no document attached, which is what a switch that does
 * nothing looks like from the outside. The stop is an ordinary lifecycle decision,
 * so the pid accounting and the no-orphan guarantee are the same ones an explicit
 * stop gets.
 *
 * ## Resolution is on the way out of the memo, and the change is an event
 *
 * {@link LspTargetResolver} memoizes a target per file against the descriptor
 * registry's revision, and a settings change does not move that revision. The gate
 * therefore reads the setting on every use, *outside* the memo: a value cached while
 * `lsp` was on would otherwise keep a server running for a language the user has
 * since turned off, which is the failure this whole slice is about.
 *
 * Reading per use is not enough on its own, though. The events that carry a
 * document are typed keystrokes and a user flipping a switch is not one, so a gate
 * that only re-reads on the next event makes "off" arrive whenever the user happens
 * to type next — which is indistinguishable from a broken switch. The runtime
 * therefore also subscribes to the settings *change* (see `SettingsReader.subscribe`)
 * and re-evaluates there, so the transition happens while the editor sits idle.
 */

/**
 * Reads `editor.lsp` for one language, narrowed the way the editor's completion
 * source narrows it.
 *
 * Both halves of the narrowing live in `@np/core` — {@link editorSettingsForLanguage}
 * for the fold over `editor.languages`, {@link editorLspEnabled} for "only `false` turns
 * a language off" — and this is the runtime's one-line call into them. Two readers
 * of one rule in two packages is a second implementation of it, whatever a
 * cross-package comparison test says.
 */
export function lspEnabledFor(read: SettingsRead, languageName: string | null): boolean {
	const scoped = editorSettingsForLanguage(read, languageName, [LSP_SETTING]);
	return editorLspEnabled(scoped.value.lsp);
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
