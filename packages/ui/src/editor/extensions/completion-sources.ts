import { Prec, type Extension } from "@codemirror/state";
import type { Language } from "@codemirror/language";
import { acceptCompletion, autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { keymap, type KeyBinding } from "@codemirror/view";
import type { RegisteredSnippet } from "@np/core";
import {
	bufferWordCompletions,
	WORDS_RANK_BELOW_EVERY_SOURCE,
	type BufferWordSettings,
} from "./buffer-words";
import { snippetCompletions, SNIPPETS_RANK_BELOW_NOTE_SOURCES } from "./snippets";

/**
 * The completion bindings minus Enter, plus vim's own accept key.
 *
 * `completionKeymap` is installed at `Prec.highest` by `autocompletion()`
 * itself and binds Enter to `acceptCompletion`, which in a code file the user
 * is reading as a newline. Under vim that is a completion eating a keystroke
 * the mode owns — exactly "completions fighting the mode" — so Enter is
 * dropped and `Ctrl-y` (vim's canonical insert-mode completion accept) takes
 * its place. Every other binding is kept verbatim, so the explicit trigger and
 * the selection keys stay where they were.
 *
 * This only works as a *replacement*: exactly one `autocompletion()` may exist
 * per editor state (see {@link completionCompartmentExtensions}), so the whole
 * keymap is re-declared here rather than added alongside the bundled one.
 */
const VIM_COMPLETION_KEYMAP: readonly KeyBinding[] = [
	...completionKeymap.filter((binding) => binding.key !== "Enter"),
	{ key: "Ctrl-y", run: acceptCompletion },
];

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
 * Each source is a separate input on the language's `data` facet, in list
 * order. Separate inputs rather than one merged source, because CodeMirror
 * filters each source's options against that source's own `from`/`to`; a merge
 * would force a single match range onto the wikilink source and break its
 * bracket-aware matching. The facet concatenates inputs in configuration order
 * and `languageDataAt` resolves them through the active language, so list order
 * here is chain order — appending leaves every earlier source in place.
 *
 * Both levers matter and they are not the same one. List position is chain
 * order, which decides which source's result is consulted first and which
 * options are offered before the popover re-ranks them; the boost decides the
 * popover order itself, because CodeMirror re-sorts every source's options
 * together on `fuzzy score + boost`. The three rank tiers are asserted together
 * in `completion-composition.test.ts`.
 */
function hostCompletionChain(options: CompletionChainOptions): Extension[] {
	const { language } = options;
	if (!language) return [];
	return [
		snippetCompletions({
			snippets: options.snippets,
			languageName: options.languageName,
		}),
		bufferWordCompletions({
			languageName: options.languageName,
			readSettings: options.readSettings,
		}),
	].map((source) => language.data.of({ autocomplete: source }));
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
	/**
	 * Whether vim modal editing is on. Swaps the bundled completion keymap for
	 * {@link VIM_COMPLETION_KEYMAP} so Enter stays the mode's.
	 */
	readonly vimEnabled?: boolean;
}

/**
 * Everything the completion compartment carries: the popup gate, the modal
 * keymap, and the host source chain.
 *
 * The gate and the keymap live here rather than in the static extension array
 * because only one `autocompletion()` may exist per state — `combineConfig`
 * throws `"Config merge conflict for field X"` when two `autocompletion()`
 * inputs disagree on a field that has no combiner, so a second one configured
 * differently (which is exactly what `defaultKeymap: false` is) crashes the
 * editor state instead of overriding anything. The compartment is therefore
 * the one place either setting can be expressed. Its content changes when they
 * change, which is a reconfiguration; the word source reads its own settings
 * per query and needs none.
 */
export function completionCompartmentExtensions(
	options: CompletionCompartmentOptions,
): Extension[] {
	const vimEnabled = options.vimEnabled ?? false;
	return [
		autocompletion({
			activateOnTyping: options.automaticCompletions,
			defaultKeymap: !vimEnabled,
		}),
		...(vimEnabled ? [Prec.highest(keymap.of(VIM_COMPLETION_KEYMAP))] : []),
		...hostCompletionChain(options),
	];
}
