import { Prec, type Extension } from "@codemirror/state";
import type { Language } from "@codemirror/language";
import { acceptCompletion, autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { keymap, type KeyBinding } from "@codemirror/view";
import type { RegisteredSnippet } from "@np/core";
import {
	bufferWordCompletions,
	WORDS_RANK_BELOW_EVERY_SOURCE,
	fenceWordFallback,
	type BufferWordSettings,
} from "./buffer-words";
import { snippetCompletions, SNIPPETS_RANK_BELOW_NOTE_SOURCES } from "./snippets";
import {
	serverCompletions,
	SERVER_RANKS_WITH_NOTE_SOURCES,
	type ServerCompletionSettings,
	type ServerCompletionSourceOptions,
} from "./server-completions";

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
	/**
	 * Server completions, or null when nothing serves this document. Everything
	 * but the settings reader is optional: the fetch, the language and the
	 * coordinator come from here.
	 */
	readonly server?: ServerCompletionSourceOptions | null;
}

/**
 * The host-owned chain that follows the note sources the language compartment
 * already registers: server items, then snippets, then buffer words.
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
 * together on `fuzzy score + boost`. The four rank tiers are asserted together
 * in `completion-composition.test.ts`.
 *
 * The server source leads the chain for one reason beyond ordering: it records
 * its query before it returns the promise, so the buffer-word source — asked
 * immediately after, in the same pass — can wait on that exact query and decide
 * `words: 'fallback'` against a real answer instead of a guess. Moving it below
 * the words source would break the fallback silently, which is why the comment
 * is here and not only on the coordinator.
 */
function hostCompletionChain(options: CompletionChainOptions): Extension[] {
	const { language } = options;
	if (!language) return [];
	const server =
		options.server === null || options.server === undefined
			? null
			: serverCompletions({
					...options.server,
					languageName: options.languageName,
					// The trigger rules are the word source's, not a second copy:
					// server items follow the same rules as words so that one
					// explicit-trigger migration covers both (spec #263).
					readTriggerSettings: options.readSettings
				});
	return [
		...[
			...(server === null ? [] : [server.source]),
			snippetCompletions({
				snippets: options.snippets,
				languageName: options.languageName,
			}),
			bufferWordCompletions({
				languageName: options.languageName,
				readSettings: options.readSettings,
				server: server?.coordinator ?? null,
			}),
		].map((source) => language.data.of({ autocomplete: source })),
		// The word source above is invisible inside a fenced block whose
		// nested language has loaded (the cursor resolves to that language),
		// so the fallback re-serves it exactly there and nowhere else. It reads
		// the same server coordinator, so fallback words inside a fence still
		// stand down while a server is answering.
		...fenceWordFallback({
			language,
			languageName: options.languageName,
			readSettings: options.readSettings,
			server: server?.coordinator ?? null,
		}),
	];
}

/**
 * The four rank tiers every source in the chain sits on, in popover order.
 * Exported so the composition suite asserts the tiers against these values
 * rather than restating the numbers.
 */
export const COMPLETION_RANK_TIERS = {
	/** The note sources carry no boost at all; they rank first at 0. */
	noteSources: 0,
	/**
	 * Server items tie the note tier on purpose. A boost below it would put them
	 * unconditionally behind the notes, which is a stronger claim than #263
	 * makes; tying means a server item is ordered against a note by how well its
	 * label matches, and both sit above every other tier.
	 */
	server: SERVER_RANKS_WITH_NOTE_SOURCES,
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
	 * of its own for the same reason, and neither does the server source.
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
