import type { Extension } from "@codemirror/state";
import type { Language } from "@codemirror/language";
import { autocompletion, type CompletionSource } from "@codemirror/autocomplete";
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
 * already registers. Snippets prepend to this list, which is why the word
 * source is last here rather than the whole chain.
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
	 * the flag only for the `input.type` path).
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
		...bufferWordCompletionChain(options),
	];
}
