import {
	editorLspEnabled,
	editorSettingsForLanguage,
	EDITOR_SETTINGS_NAMESPACE,
	LSP_SETTING,
	LSP_FETCH_TIMEOUT_SETTING,
	LSP_INSERT_MODE_SETTING,
	MIN_WORD_LENGTH_SETTING,
	SHOW_COMPLETION_DOCUMENTATION_SETTING,
	WORDS_SETTING,
	AUTOMATIC_COMPLETIONS_SETTING,
	type CompletionWordsMode,
	type SettingsRead
} from "@np/core";
import {
	DEFAULT_BUFFER_WORD_SETTINGS,
	type BufferWordSettings,
} from "./buffer-words";
import {
	DEFAULT_SERVER_COMPLETION_SETTINGS,
	type ServerCompletionSettings,
} from "./server-completions";

/**
 * The `editor` settings namespace owns the completion triggers, and
 * `editor.languages` overrides them per language.
 *
 * The fold over those overrides, and the narrowing of `editor.lsp`, are not
 * written here: both are in `@np/core` beside the schema that declares the keys,
 * which is where the LSP runtime's own gate reads them from. Two readers of one
 * rule in two packages drift, and the drift is invisible until a language stops
 * offering completions without stopping its server.
 */

/** Resolves one key of one settings namespace. */
export type SettingReader = SettingsRead;

/**
 * The buffer-word settings for one language: the editor-level `words` and
 * `min_word_length` values with that language's overrides folded over them.
 *
 * `read` is injected so this stays a pure function of the settings store, and
 * so the word source can call it on every query — a per-language override
 * therefore takes effect on the next completion without the editor being
 * reconfigured.
 *
 * Only the two trigger settings are read. `automatic_completions` is
 * deliberately not scoped: it is the global popup toggle, applied once through
 * `autocompletion({ activateOnTyping })`, and a per-language entry for it would
 * be ignored here rather than half-honoured.
 *
 * The base object is keyed by *setting name*, not by the source's own field
 * names, because the override map is: `{ "Markdown": { "words": "disabled" } }`
 * only folds over a base spelled `{ words: ... }`. Normalizing to the source's
 * own names happens on the way out, and the fold's key list travels out with
 * it so prose silence stays a default the user can reverse — by naming `words`
 * specifically, not merely by having a Markdown entry at all.
 */
export function readBufferWordSettings(
	read: SettingReader,
	languageName: string | null,
): BufferWordSettings {
	const scoped = editorSettingsForLanguage(read, languageName, [
		WORDS_SETTING,
		MIN_WORD_LENGTH_SETTING,
	]);

	return {
		words: readWordsMode(scoped.value[WORDS_SETTING]),
		// A value the schema already rejected, or one hand-edited past it, is
		// narrowed back to the documented default. The threshold itself is
		// normalized once more by the policy, which is the only place that reads
		// it as a length.
		minWordLength:
			typeof scoped.value[MIN_WORD_LENGTH_SETTING] === "number"
				? scoped.value[MIN_WORD_LENGTH_SETTING]
				: DEFAULT_BUFFER_WORD_SETTINGS.minWordLength,
		wordsOverridden: scoped.keys.includes(WORDS_SETTING),
	};
}

/**
 * The global popup toggle. Only an explicit `false` mutes the editor, so a
 * missing or malformed stored value keeps the documented default instead of
 * turning every completion off.
 */
export function readAutomaticCompletions(read: SettingReader): boolean {
	return read(EDITOR_SETTINGS_NAMESPACE, AUTOMATIC_COMPLETIONS_SETTING) !== false;
}

/**
 * The five settings that shape server completions, resolved for one language
 * (spec #263).
 *
 * All five are scoped per language, unlike `automatic_completions`: a machine
 * that wants a server only for code, or a 400ms bound only for TypeScript, is a
 * per-language answer, and scoping them keeps that one `editor.languages` entry
 * rather than a second settings tree.
 *
 * Each value is narrowed back to its documented default when the stored value is
 * not the declared type. The overrides map is hand-editable, so a
 * `lsp_fetch_timeout_ms` of `"soon"` has to cost the user their bound and
 * nothing else — and `0` in particular must survive, because it is the
 * documented "no bound" default rather than an absent value.
 */
export function readServerCompletionSettings(
	read: SettingReader,
	languageName: string | null,
): ServerCompletionSettings {
	const scoped = editorSettingsForLanguage(read, languageName, [
		LSP_SETTING,
		LSP_FETCH_TIMEOUT_SETTING,
		LSP_INSERT_MODE_SETTING,
		SHOW_COMPLETION_DOCUMENTATION_SETTING,
	]);

	return {
		lsp: editorLspEnabled(scoped.value[LSP_SETTING]),
		fetchTimeoutMs:
			typeof scoped.value[LSP_FETCH_TIMEOUT_SETTING] === "number" &&
			Number.isFinite(scoped.value[LSP_FETCH_TIMEOUT_SETTING])
				? Math.max(0, Math.trunc(scoped.value[LSP_FETCH_TIMEOUT_SETTING]))
				: DEFAULT_SERVER_COMPLETION_SETTINGS.fetchTimeoutMs,
		insertMode: readInsertMode(scoped.value[LSP_INSERT_MODE_SETTING]),
		showDocumentation:
			scoped.value[SHOW_COMPLETION_DOCUMENTATION_SETTING] !== false,
	};
}

/** Narrows a stored `words` to the documented union, defaulting when it is not one. */
function readWordsMode(value: unknown): CompletionWordsMode {
	return value === "enabled" || value === "fallback" || value === "disabled"
		? value
		: DEFAULT_BUFFER_WORD_SETTINGS.words;
}

function readInsertMode(value: unknown): ServerCompletionSettings["insertMode"] {
	return value === "replace_suffix" || value === "replace_range"
		? value
		: DEFAULT_SERVER_COMPLETION_SETTINGS.insertMode;
}
