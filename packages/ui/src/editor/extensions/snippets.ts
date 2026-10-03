import type { RegisteredSnippet } from "@np/core";
import {
	insertCompletionText,
	pickedCompletion,
	type Completion,
	type CompletionContext,
	type CompletionResult,
	type CompletionSource,
} from "@codemirror/autocomplete";

/**
 * Rank offset carried by every snippet.
 *
 * CodeMirror sorts options on `fuzzy score + boost` descending. Fuzzy scores
 * are `<= 0` and bottom out near `-2100 - word length`, and the note sources
 * carry no boost at all, so any offset past that floor puts a snippet
 * unconditionally below every note option — which is the ranking the spec
 * asks for, and the reason this is not simply "no boost": an unboosted snippet
 * would outrank a note option whenever the note's fuzzy match happened to be
 * the worse of the two, making the order depend on the note's text rather
 * than on the source. It sits between that floor and
 * {@link WORDS_RANK_BELOW_EVERY_SOURCE}, so it needs no knowledge of either
 * neighbouring source's internals to stay between them.
 */
export const SNIPPETS_RANK_BELOW_NOTE_SOURCES = -10_000;

/**
 * Completion type for a snippet option. `keyword` already carries a glyph in
 * CodeMirror's base theme (as do `text` and the other named types) and reads
 * correctly for a language construct; `text` is deliberately not reused
 * because the buffer-word source already owns it and the two offers would be
 * indistinguishable in the popover.
 */
const SNIPPET_COMPLETION_TYPE = "keyword";

export interface SnippetSourceOptions {
	/** Every registered snippet; language filtering happens per query. */
	readonly snippets: readonly RegisteredSnippet[];
	/**
	 * Name of the language the editor currently holds. A snippet joins on a
	 * registered language, so with no language there is nothing to offer.
	 */
	readonly languageName: string | null;
}

/**
 * Registered snippets as a completion source, offering the triggers that
 * extend the typed prefix and inserting the body on accept.
 *
 * Answers on a typing trigger as well as the explicit one: a trigger is a
 * word a plugin chose to offer, and it is already scoped to one language and
 * filtered by prefix, so there is no vocabulary to flood the popover with.
 *
 * No `validFor`, unlike the buffer-word source: re-querying narrows the
 * trigger as it is typed, which is the behavior a summoned construct needs.
 */
export function snippetCompletions(options: SnippetSourceOptions): CompletionSource {
	const { snippets, languageName } = options;

	return (context: CompletionContext): CompletionResult | null => {
		if (!languageName) return null;

		const lowered = languageName.toLowerCase();
		const typed = context.matchBefore(/[A-Za-z0-9_$]*/);
		// An empty prefix would dump the whole pack into the popover.
		if (!typed || typed.from === context.pos) return null;

		const prefix = typed.text.toLowerCase();
		const options = snippets.filter(
			(snippet) =>
				snippet.language.toLowerCase() === lowered &&
				snippet.trigger.toLowerCase().startsWith(prefix)
		);
		if (options.length === 0) return null;

		return {
			from: typed.from,
			options: options.map(
				(snippet): Completion => ({
					label: snippet.trigger,
					detail: snippet.description,
					type: SNIPPET_COMPLETION_TYPE,
					boost: SNIPPETS_RANK_BELOW_NOTE_SOURCES,
					apply: snippetApply(snippet.body),
				})
			),
		};
	};
}

/**
 * Replaces the matched trigger with the body. Bodies are plain text with no
 * placeholders, so this is `insertCompletionText` and nothing else: it
 * resolves the multi-range selection a completion applies to, which a raw
 * single-range change would ignore.
 */
function snippetApply(body: string): NonNullable<Completion["apply"]> {
	return (view, completion, from, to) => {
		view.dispatch({
			...insertCompletionText(view.state, body, from, to),
			annotations: pickedCompletion.of(completion),
		});
	};
}