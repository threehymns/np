import type {
	Completion,
	CompletionContext,
	CompletionResult,
	CompletionSource,
} from "@codemirror/autocomplete";

/** Whether automatic word offers are permitted at all. */
export type BufferWordMode = "enabled" | "disabled";

/**
 * Per-query knobs for the buffer-word source. Read through an injected reader
 * on every query instead of being captured when the source is built, so a
 * settings change never needs an editor reconfiguration.
 */
export interface BufferWordSettings {
	/**
	 * Shortest word the source deals in, enforced at both ends.
	 *
	 * On the automatic path it is a *trigger* threshold: the typed prefix must
	 * already reach this length before a popover appears, so the popup never
	 * interrupts the first characters of a word. On the explicit path the user
	 * asked, so it is only a *vocabulary* floor: candidates shorter than it are
	 * not offered.
	 *
	 * The two readings are the same question — how short a word may be and
	 * still be a completion — asked of the two words involved: the one being
	 * typed and the one being offered. Neither is ever allowed below it.
	 */
	readonly minWordLength: number;
	/**
	 * Gates automatic offers only. `'disabled'` means quiet, not unavailable:
	 * the explicit trigger still answers, in every language.
	 */
	readonly words: BufferWordMode;
}

export const DEFAULT_BUFFER_WORD_SETTINGS: BufferWordSettings = {
	minWordLength: 3,
	words: "enabled",
};

/**
 * Rank offset carried by every buffer word. CodeMirror adds `boost` to the
 * fuzzy match score and sorts descending; fuzzy scores are `<= 0` and bottom
 * out near `-2100 - word length`, so this parks words below every option
 * another source can emit whatever the typed prefix is. #262 slots snippets
 * above words by choosing a boost between this and 0.
 */
export const WORDS_RANK_BELOW_EVERY_SOURCE = -100_000;

/**
 * Word-shaped tokens: a leading letter, `_` or `$`, continued with word
 * characters. Picked over the language's own `wordChars` because one
 * vocabulary has to serve prose and code, and this shape covers identifiers,
 * `snake_case` and `camelCase` in both.
 */
const BUFFER_WORD_PATTERN = /[A-Za-z_$][A-Za-z0-9_$]*/g;

export interface BufferWordPolicy {
	/** Whether a typing trigger may offer words, as opposed to an explicit one. */
	readonly automatic: boolean;
	/** Shortest word admitted to the vocabulary and to the automatic trigger. */
	readonly minWordLength: number;
}

/**
 * Prose is identified by language identity, matched case-insensitively on the
 * lowercased name — the same rule `getContributionsForType`
 * (`plugins/editor.ts`) and the language registry use when they join on a
 * language name. A document's language is its description `name`, which is
 * `"Markdown"` for a note; aliases are not part of that identity and are
 * deliberately not matched.
 */
const MARKDOWN_LANGUAGE_NAME = "markdown";

export function isMarkdownProse(languageName: string | null | undefined): boolean {
	return (
		typeof languageName === "string" &&
		languageName.trim().toLowerCase() === MARKDOWN_LANGUAGE_NAME
	);
}

/**
 * The single place deciding what a query may offer, so the trigger split and
 * the settings land here instead of in the source body.
 *
 * Two independent brakes on the automatic path, and neither of them touches
 * the explicit one:
 *
 * - Markdown prose is always quiet on a typing trigger. A note is prose being
 *   written, not code being recalled, and words fire constantly while writing.
 *   #259 asks for silence here; the explicit trigger stays available so prose
 *   is never worse off than before.
 * - `words: 'disabled'` silences the automatic path in every language. Off
 *   means quiet, not unavailable.
 */
export function resolveBufferWordPolicy(
	languageName: string | null,
	settings: BufferWordSettings,
): BufferWordPolicy {
	return {
		automatic: settings.words !== "disabled" && !isMarkdownProse(languageName),
		minWordLength: normalizeMinWordLength(settings.minWordLength),
	};
}

/**
 * The threshold reaches the source through storage, a per-language override
 * map, or a hand-edited settings file, so it is normalized once here instead
 * of being trusted. A value that is not a usable number falls back to the
 * default rather than silently disabling every offer.
 */
function normalizeMinWordLength(value: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return DEFAULT_BUFFER_WORD_SETTINGS.minWordLength;
	}
	return Math.max(1, Math.trunc(value));
}

export interface BufferWordSourceOptions {
	/** Name of the language the editor currently holds. */
	readonly languageName: string | null;
	/** Defaults to {@link DEFAULT_BUFFER_WORD_SETTINGS}. */
	readonly readSettings?: () => BufferWordSettings;
}

function staticDefaultSettings(): BufferWordSettings {
	return DEFAULT_BUFFER_WORD_SETTINGS;
}

/**
 * Current-document words, ranked behind every other completion source.
 *
 * Offered on the explicit trigger in every language and file type, and on a
 * typing trigger wherever {@link resolveBufferWordPolicy} allows it — code
 * files only, and only past the minimum word length.
 *
 * The vocabulary is the open document and nothing else: there is no index
 * behind it, so every query re-reads `context.state.doc` and no staleness rule
 * is needed.
 */
export function bufferWordCompletions(
	options: BufferWordSourceOptions,
): CompletionSource {
	const { languageName, readSettings = staticDefaultSettings } = options;

	return (context: CompletionContext): CompletionResult | null => {
		const policy = resolveBufferWordPolicy(languageName, readSettings());

		const typed = context.matchBefore(/[A-Za-z0-9_$]*/);
		// An empty typed prefix would dump the whole vocabulary into the popover.
		if (!typed || typed.from === context.pos) return null;

		if (!context.explicit) {
			if (!policy.automatic) return null;
			// Past the minimum length, or the popup interrupts the first
			// characters of every word.
			if (typed.text.length < policy.minWordLength) return null;
		}

		const prefix = typed.text.toLowerCase();
		const labels = bufferVocabulary(
			context.state.doc.toString(),
			typed.from,
			policy.minWordLength,
		).filter((label) => label.toLowerCase().startsWith(prefix));

		if (labels.length === 0) return null;

		return {
			from: typed.from,
			// Re-querying on every keystroke would reshuffle the list under the
			// cursor, so a longer run of word characters keeps this vocabulary.
			validFor: /^[\w$]*$/,
			options: labels.map(
				(label): Completion => ({
					label,
					type: "text",
					boost: WORDS_RANK_BELOW_EVERY_SOURCE,
				}),
			),
		};
	};
}

/**
 * Distinct tokens in document order, first occurrence winning. Document order
 * is the only ranking a reader of the buffer can predict — nothing here has a
 * corpus behind it, so frequency would make the list jump as the file grows.
 * The token under the cursor is skipped: it is the prefix being typed.
 */
function bufferVocabulary(
	text: string,
	typedFrom: number,
	minWordLength: number,
): string[] {
	const seen = new Set<string>();
	const labels: string[] = [];
	// matchAll clones the pattern, so the shared regex keeps its position.
	for (const match of text.matchAll(BUFFER_WORD_PATTERN)) {
		const start = match.index;
		if (start === typedFrom) continue;
		const label = match[0];
		if (label.length < minWordLength || seen.has(label)) continue;
		seen.add(label);
		labels.push(label);
	}
	return labels;
}
