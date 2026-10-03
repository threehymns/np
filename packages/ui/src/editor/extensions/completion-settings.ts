import { scopeForLanguage } from "@np/core";
import {
	DEFAULT_BUFFER_WORD_SETTINGS,
	type BufferWordSettings,
} from "./buffer-words";

/**
 * The `editor` settings namespace owns the completion triggers, and
 * `editor.languages` overrides them per language.
 */
export const COMPLETION_SETTINGS_NAMESPACE = "editor";

export const WORDS_SETTING = "words";
export const MIN_WORD_LENGTH_SETTING = "min_word_length";
export const AUTOMATIC_COMPLETIONS_SETTING = "automatic_completions";
export const LANGUAGE_OVERRIDES_SETTING = "languages";

/** Resolves one key of one settings namespace. */
export type SettingReader = (namespace: string, key: string) => unknown;

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
	const editorLevel = {
		words: read(COMPLETION_SETTINGS_NAMESPACE, WORDS_SETTING),
		min_word_length: read(COMPLETION_SETTINGS_NAMESPACE, MIN_WORD_LENGTH_SETTING),
	};

	const scoped = scopeForLanguage(
		editorLevel,
		read(COMPLETION_SETTINGS_NAMESPACE, LANGUAGE_OVERRIDES_SETTING),
		languageName,
	);

	return {
		words: scoped.value.words === "disabled" ? "disabled" : "enabled",
		// A value the schema already rejected, or one hand-edited past it, is
		// narrowed back to the documented default. The threshold itself is
		// normalized once more by the policy, which is the only place that reads
		// it as a length.
		minWordLength:
			typeof scoped.value.min_word_length === "number"
				? scoped.value.min_word_length
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
	return read(COMPLETION_SETTINGS_NAMESPACE, AUTOMATIC_COMPLETIONS_SETTING) !== false;
}
