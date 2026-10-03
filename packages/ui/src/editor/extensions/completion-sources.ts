import type { Extension } from "@codemirror/state";
import type { Language } from "@codemirror/language";
import type { CompletionSource } from "@codemirror/autocomplete";
import {
	bufferWordCompletions,
	type BufferWordSettings,
} from "./buffer-words";

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
	readonly readSettings?: () => BufferWordSettings;
}

/**
 * The host-owned chain that follows the note sources the language compartment
 * already registers. #260 adds words only; #262 prepends snippets to this list,
 * which is why the word source is last here rather than the whole chain.
 */
export function bufferWordCompletionChain(
	options: CompletionChainOptions,
): Extension[] {
	return orderedCompletionSources(options.language, [
		bufferWordCompletions({
			languageName: options.languageName,
			readSettings: options.readSettings,
		}),
	]);
}
