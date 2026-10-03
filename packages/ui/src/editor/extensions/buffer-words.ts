import type {
	Completion,
	CompletionContext,
	CompletionResult,
	CompletionSource,
} from "@codemirror/autocomplete";

/**
 * Per-query knobs for the buffer-word source. Read through an injected reader
 * on every query instead of being captured when the source is built, so a
 * settings change never needs an editor reconfiguration (#261 owns the schema
 * and the per-language scoping).
 */
export interface BufferWordSettings {
	/**
	 * Shortest token admitted to the vocabulary. #260 answers the explicit
	 * trigger only, so this bounds the vocabulary rather than a trigger; #261
	 * gives the automatic trigger its own threshold off the same setting.
	 */
	readonly minWordLength: number;
}

export const DEFAULT_BUFFER_WORD_SETTINGS: BufferWordSettings = { minWordLength: 3 };

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
	/** Shortest token admitted to the vocabulary. */
	readonly minWordLength: number;
}

/**
 * The single place deciding what a query may offer, so #261 changes the trigger
 * split and the per-language resolution here instead of in the source body.
 *
 * #260 keeps automatic offers off everywhere, which is the whole of the
 * "no automatic behavior changes" bar. `_languageName` is unused until #261
 * turns `automatic` on outside Markdown prose; it is already threaded so that
 * change is local.
 */
export function resolveBufferWordPolicy(
	_languageName: string | null,
	settings: BufferWordSettings,
): BufferWordPolicy {
	return {
		automatic: false,
		minWordLength: Math.max(1, Math.trunc(settings.minWordLength)),
	};
}

export interface BufferWordSourceOptions {
	/**
	 * Name of the language the editor currently holds. #261 reads it to keep
	 * automatic offers out of Markdown prose.
	 */
	readonly languageName: string | null;
	/** Defaults to {@link DEFAULT_BUFFER_WORD_SETTINGS}. */
	readonly readSettings?: () => BufferWordSettings;
}

function staticDefaultSettings(): BufferWordSettings {
	return DEFAULT_BUFFER_WORD_SETTINGS;
}

/**
 * Current-document words, answered on the explicit trigger in every file and
 * ranked behind every other completion source.
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
		if (!context.explicit && !policy.automatic) return null;

		const typed = context.matchBefore(/[A-Za-z0-9_$]*/);
		// An empty typed prefix would dump the whole vocabulary into the popover.
		if (!typed || typed.from === context.pos) return null;

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
