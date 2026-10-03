import type { Extension } from "@codemirror/state";
import type { Language } from "@codemirror/language";
import { autocompletion, type CompletionSource } from "@codemirror/autocomplete";
import type { RegisteredSnippet } from "@np/core";
import {
	bufferWordCompletions,
	WORDS_RANK_BELOW_EVERY_SOURCE,
	type BufferWordSettings,
} from "./buffer-words";
import { snippetCompletions, SNIPPETS_RANK_BELOW_NOTE_SOURCES } from "./snippets";

/**
 * Registers completion sources as separate inputs on the language's data facet,
 * in list order.
 *
 * Separate inputs rather than one merged source, because CodeMirror filters
 * each source's options against that source's own `from`/`to`; a merge would
 * force a single match range onto the wikilink source and break its
 * bracket-aware matching. The facet concatenates inputs in configuration order
 * and `languageDataAt` resolves them through the active language, so list order
 * here is chain order — appending leaves every earlier source in place.
 */
export function orderedCompletionSources(
	language: Language | null,
	sources: readonly CompletionSource[],
): Extension[] {
	if (!language) return [];
	return sources.map((source) => language.data.of({ autocomplete: source }));
}

export interface CompletionChainOptions {
	/** Active language, or null when the document has none (plain text). */
	readonly language: Language | null;
	readonly languageName: string | null;
	/** Registered snippets for any language; each source filters its own. */
	readonly snippets: readonly RegisteredSnippet[];
	readonly readSettings?: () => BufferWordSettings;
}

/**
 * The host-owned chain that follows the note sources the language compartment
 * already registers: snippets, then buffer words.
 *
 * Both levers matter and they are not the same one. List position is chain
 * order, which decides which source's result is consulted first and which
 * options are offered before the popover re-ranks them; the boost decides the
 * popover order itself, because CodeMirror re-sorts every source's options
 * together on `fuzzy score + boost`. The three rank tiers are asserted
 * together in `completion-composition.test.ts`.
 */
export function hostCompletionChain(options: CompletionChainOptions): Extension[] {
	return orderedCompletionSources(options.language, [
		snippetCompletions({
			snippets: options.snippets,
			languageName: options.languageName,
		}),
		bufferWordCompletions({
			languageName: options.languageName,
			readSettings: options.readSettings,
		}),
	]);
}

/**
 * The three rank tiers every source in the chain sits on, in popover order.
 * Exported so the composition suite asserts the tiers against these values
 * rather than restating the numbers.
 */
export const COMPLETION_RANK_TIERS = {
	/** The note sources carry no boost at all; they rank first at 0. */
	noteSources: 0,
	snippets: SNIPPETS_RANK_BELOW_NOTE_SOURCES,
	words: WORDS_RANK_BELOW_EVERY_SOURCE,
} as const;

export interface CompletionCompartmentOptions extends CompletionChainOptions {
	/**
	 * The global popup toggle. `false` stops every *automatic* offer — including
	 * the table and wikilink sources, which are registered through the
	 * language-data facet and cannot be gated per source without editing them.
	 *
	 * `activateOnTyping` is therefore the only lever that covers the whole
	 * chain, and it happens to keep the explicit trigger: `startCompletion`
	 * dispatches its own effect rather than relying on typing
	 * (`@codemirror/autocomplete/dist/index.js`, `ActiveSource.update` reads
	 * the flag only for the `input.type` path). The snippet source needs no gate
	 * of its own for the same reason.
	 */
	readonly automaticCompletions: boolean;
}

/**
 * Everything the completion compartment carries: the popup gate and the host
 * source chain.
 *
 * The gate lives here rather than in the static extension array because only
 * one `autocompletion()` may exist per state — `completionConfig` merges
 * facet inputs first-value-wins and throws on a conflict — so the compartment
 * is the one place the setting can be expressed. Its content changes when the
 * setting changes, which is a reconfiguration; the word source reads its own
 * settings per query and needs none.
 */
export function completionCompartmentExtensions(
	options: CompletionCompartmentOptions,
): Extension[] {
	return [
		autocompletion({ activateOnTyping: options.automaticCompletions }),
		...hostCompletionChain(options),
	];
}
