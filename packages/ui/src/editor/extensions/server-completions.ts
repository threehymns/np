import type { EditorState } from "@codemirror/state";
import type {
	Completion,
	CompletionContext,
	CompletionResult,
	CompletionSource,
} from "@codemirror/autocomplete";
import { insertCompletionText, pickedCompletion } from "@codemirror/autocomplete";
import {
	EDITOR_COMPLETION_DEFAULTS,
	type CompletionAnswer,
	type CompletionLspInsertMode,
	type CompletionQuery,
	type CompletionSuggestion,
} from "@np/core";
import {
	DEFAULT_BUFFER_WORD_SETTINGS,
	isMarkdownProse,
	resolveBufferWordPolicy,
	type BufferWordSettings,
} from "./buffer-words";
import { currentDocFacet } from "./wikilinks";

/**
 * Server completion items as one more source on the existing chain (spec #263,
 * ADR 0019).
 *
 * Three properties of this module are load-bearing and each one exists because
 * of something measured rather than chosen:
 *
 * - It is a **separate** language-data facet input, never merged into a
 *   neighbouring source. CodeMirror filters each source's options against that
 *   source's own `from`/`to` (`ActiveResult` carries them per source), so a
 *   merge would force one match range onto the wikilink source and break its
 *   bracket-aware matching.
 * - It ranks with `boost`, never with `section`/`rank`. `sortOptions` orders a
 *   ranked section strictly ahead of every unranked one before the fuzzy score
 *   is consulted, and the note sources are un-sectioned and frozen — so a
 *   numbered section would promote server items above them. At
 *   {@link SERVER_RANKS_WITH_NOTE_SOURCES} a server item ties the note tier on
 *   boost and is ordered by how well its label matches, which is what "in the
 *   composed order" means: above snippets and words, alongside the notes.
 * - The buffer-word source reads the server's answer through
 *   {@link ServerCompletionCoordinator} rather than being handed it. That is
 *   what makes `words: 'fallback'` a fallback rather than a guess: the words
 *   source cannot know whether a request will fail or time out until it has
 *   settled, and it is the only place that decision can honestly be made.
 */

/** Rank tier for server items: the note tier, so neither source is promoted. */
export const SERVER_RANKS_WITH_NOTE_SOURCES = 0;

/**
 * Completion `type` for a server item. `variable` is what
 * `@codemirror/lang-javascript`'s own local-variable source already uses in a
 * code file, and sharing it is deliberate: a server item and an identifier the
 * language found locally are the same kind of suggestion, so they should look
 * the same in the popover. (The snippet source went the other way for a
 * different reason — a snippet and a word are different things and must not be
 * confused for each other.)
 */
const SERVER_COMPLETION_TYPE = "variable";

/**
 * Asks whatever provider is published for one position's completions.
 *
 * Named for the question rather than for the technology answering it, so a
 * second provider is a second implementation of this one function and the shell
 * that wires it never has to learn a new name.
 */
export type CompletionFetch = (query: CompletionQuery) => Promise<CompletionAnswer>;

/** The four settings that shape server completions, already per language. */
export interface ServerCompletionSettings {
	/** `lsp`: gates server suggestions for this language. */
	readonly lsp: boolean;
	/** `lsp_fetch_timeout_ms`: `0` means no bound, which is the documented default. */
	readonly fetchTimeoutMs: number;
	/** `lsp_insert_mode`: which range an accepted item replaces. */
	readonly insertMode: CompletionLspInsertMode;
	/** `show_completion_documentation`: whether JSDoc reaches the popover. */
	readonly showDocumentation: boolean;
}

export const DEFAULT_SERVER_COMPLETION_SETTINGS: ServerCompletionSettings = {
	lsp: EDITOR_COMPLETION_DEFAULTS.lsp,
	fetchTimeoutMs: EDITOR_COMPLETION_DEFAULTS.lspFetchTimeoutMs,
	insertMode: EDITOR_COMPLETION_DEFAULTS.lspInsertMode,
	showDocumentation: EDITOR_COMPLETION_DEFAULTS.showCompletionDocumentation
};

/**
 * The one query the two sources share.
 *
 * CodeMirror runs the sources in chain order in a single pass, and this source
 * is registered first, so by the time the buffer-word source is asked the query
 * is already recorded — `begin` happens synchronously inside the server source,
 * before it returns the promise the words source will wait on. That ordering is
 * the whole mechanism, which is why the server source must not be moved after
 * the words source in the chain.
 *
 * `settled` is what keeps the no-server case synchronous. When nothing serves
 * the document the server source declines at once and hands back an answer
 * rather than a promise, so a document with no server — every Markdown note, and
 * every editor state built without an LSP runtime — pays nothing and the words
 * source keeps answering in the same tick it always did.
 */
export interface ServerCompletionQuery {
	readonly position: number;
	/** The answer, when there already is one. Null while the request is in flight. */
	readonly settled: CompletionAnswer | null;
	readonly outcome: Promise<CompletionAnswer>;
}

/** Where the words source reads the server's answer from. */
export interface ServerOutcomeReader {
	/** The query in flight for `position`, or null when none was asked. */
	queryFor(position: number): ServerCompletionQuery | null;
}

export class ServerCompletionCoordinator implements ServerOutcomeReader {
	private current: ServerCompletionQuery | null = null;

	/**
	 * Records the query this source is about to make. Called synchronously, so
	 * the words source sees it in the same pass over the chain.
	 */
	begin(position: number, outcome: Promise<CompletionAnswer>): ServerCompletionQuery {
		const query: ServerCompletionQuery = { position, settled: null, outcome };
		this.current = query;
		return query;
	}

	/**
	 * Records an answer that needs no round trip: nothing serves this document,
	 * or the language's server completions are off. Without this the words
	 * source would have to wait a microtask for every note in the workspace.
	 *
	 * The condition on {@link queryFor} is what carries most of that weight, and
	 * the recording is what carries the rest. Recording *over* whatever is there is
	 * the part that matters: a query still in flight at this same position is a
	 * different request, and reading its answer as this query's would both make the
	 * words source wait on a request this query never made and let a `serving`
	 * answer to that one stand words down for this one — the fallback's own rule
	 * applied to the wrong query.
	 */
	settleNow(position: number, outcome: CompletionAnswer): void {
		this.current = { position, settled: outcome, outcome: Promise.resolve(outcome) };
	}

	queryFor(position: number): ServerCompletionQuery | null {
		const query = this.current;
		return query && query.position === position ? query : null;
	}
}

/**
 * What the host supplies. The language name is deliberately not here: the chain
 * owns it, because it is the same name the snippet and word sources are built
 * from, and a second copy of it is a second thing to keep in step.
 */
export interface ServerCompletionSourceOptions {
	readonly fetch: CompletionFetch;
	/** Defaults to {@link DEFAULT_SERVER_COMPLETION_SETTINGS}. */
	readonly readSettings?: () => ServerCompletionSettings;
	/**
	 * The trigger rules, which are the buffer-word settings rather than anything
	 * of this source's own. Read per query and for the same reason the words
	 * source reads its own: a settings change must not need an editor
	 * reconfiguration.
	 *
	 * Defaults to {@link DEFAULT_BUFFER_WORD_SETTINGS}, which is what an editor
	 * built without any settings reader gets.
	 */
	readonly readTriggerSettings?: () => BufferWordSettings;
	/**
	 * Read per query, so a server started since the last keystroke is honored.
	 * Defaults to no triggers before the handshake.
	 */
	readonly readTriggerCharacters?: () => readonly string[];
}

function staticServerSettings(): ServerCompletionSettings {
	return DEFAULT_SERVER_COMPLETION_SETTINGS;
}

function staticTriggerSettings(): BufferWordSettings {
	return DEFAULT_BUFFER_WORD_SETTINGS;
}

function staticNoTriggers(): readonly string[] {
	return [];
}

/**
 * The typed trigger character, when the character just before the cursor is a
 * live server trigger. Null otherwise — including for the explicit trigger,
 * which is the user asking rather than a character asking.
 */
function triggerCharacterBefore(
	context: CompletionContext,
	triggerCharacters: readonly string[]
): string | null {
	if (context.explicit || triggerCharacters.length === 0 || context.pos <= 0) return null;
	const char = context.state.doc.sliceString(context.pos - 1, context.pos);
	return triggerCharacters.includes(char) ? char : null;
}

/** Why a query may not reach the server, or null when it may. */
interface TriggerDecline {
	readonly reason: string;
}

/**
 * Whether this query is one a source may answer on a typing trigger.
 *
 * Delegates the decision to `resolveBufferWordPolicy` — the single place that
 * decides what a query may offer — and reports only the reasons. A declined
 * query is `'inactive'` rather than a failure: nothing was wrong, the rules
 * said no, and the buffer-word source is entitled to answer exactly as it did
 * before any server existed.
 */
function declinedByTriggerRules(
	context: CompletionContext,
	languageName: string | null,
	settings: BufferWordSettings,
	typed: { readonly text: string },
): TriggerDecline | null {
	// The explicit trigger is the user asking, so it is never gated.
	if (context.explicit) return null;
	const policy = resolveBufferWordPolicy(
		languageName,
		settings,
		context.state.doc,
		context.pos,
	);
	if (!policy.automatic) {
		return {
			reason:
				isMarkdownProse(languageName) && !settings.wordsOverridden
					? "Prose is quiet on a typing trigger; ask explicitly to reach a server."
					: "Automatic suggestions are off for this language; ask explicitly to reach a server.",
		};
	}
	if (typed.text.length < policy.minWordLength) {
		return {
			reason: `A typed prefix of at least ${policy.minWordLength} characters may summon suggestions.`
		};
	}
	return null;
}

export interface ServerCompletionChain {
	readonly source: CompletionSource;
	readonly coordinator: ServerCompletionCoordinator;
}

/**
 * Builds the server source and the coordinator the words source reads.
 *
 * They come back together on purpose: a source with a coordinator nobody reads
 * would answer every query and hide a failing server behind silence, which is
 * the failure mode `fallback` exists to remove.
 */
export function serverCompletions(
	options: ServerCompletionSourceOptions & { readonly languageName: string | null }
): ServerCompletionChain {
	const { languageName, fetch, readSettings = staticServerSettings } = options;
	const readTriggerSettings = options.readTriggerSettings ?? staticTriggerSettings;
	const readTriggerCharacters = options.readTriggerCharacters ?? staticNoTriggers;
	const coordinator = new ServerCompletionCoordinator();

	const source: CompletionSource = (context: CompletionContext) => {
		const settings = readSettings();
		// No language means nothing can claim the document, and `lsp: false` means
		// the user turned servers off for it. Both are 'inactive' rather than an
		// error: words answering here is the documented behaviour, not a fallback.
		if (!languageName || !settings.lsp) {
			coordinator.settleNow(context.pos, {
				state: "inactive",
				reason: !languageName
					? "This document has no language, so no server can serve it."
					: "Server completions are off for this language.",
			});
			return null;
		}

		const document = context.state.facet(currentDocFacet);
		const path = document?.origin?.path ?? null;
		if (!path) {
			coordinator.settleNow(context.pos, {
				state: "inactive",
				reason: "An untitled document has no file for a server to serve.",
			});
			return null;
		}

		const requestWith = (trigger: { kind: 1 } | { kind: 2; character: string }) => {
			const line = context.state.doc.lineAt(context.pos);
			const outcome = fetch({
				document: {
					path,
					fileName: document?.fileName ?? path,
					content: context.state.doc.toString(),
					language: languageName
				},
				line: line.number - 1,
				character: context.pos - line.from,
				timeoutMs: normalizeFetchTimeout(settings.fetchTimeoutMs),
				trigger
			});
			// Registered before returning the promise: the words source runs later in
			// this same pass and waits on exactly this.
			coordinator.begin(context.pos, outcome);

			// The popover range is the word alone, not the dotted path that gated
			// the query: `foo.bar` completes `bar`, so receiver+dot survive accept.
			const word = context.matchBefore(/[A-Za-z0-9_$]*/);
			const resultFrom = word ? word.from : context.pos;
			return outcome.then((answer) =>
				answer.state === "serving" && answer.items.length > 0
					? serverResult(answer, resultFrom, context.pos, settings)
					: null
			);
		};

		// Trigger character before the cursor asks the server even on an empty
		// prefix; prose+disabled brakes still apply. Union of live triggers.
		const triggerChar = triggerCharacterBefore(context, readTriggerCharacters());
		if (triggerChar !== null) {
			const triggerSettings = readTriggerSettings();
			const policy = resolveBufferWordPolicy(
				languageName,
				triggerSettings,
				context.state.doc,
				context.pos
			);
			if (!policy.automatic) {
				coordinator.settleNow(context.pos, {
					state: "inactive",
					reason:
						isMarkdownProse(languageName) && !triggerSettings.wordsOverridden
							? "Prose is quiet on a typing trigger; ask explicitly to reach a server."
							: "Automatic suggestions are off for this language; ask explicitly to reach a server."
				});
				return null;
			}
			return requestWith({ kind: 2, character: triggerChar });
		}

		const typed = context.matchBefore(/[A-Za-z0-9_$.]*/);
		if (!typed || typed.from === context.pos) {
			coordinator.settleNow(context.pos, {
				state: "inactive",
				reason: "There is no typed prefix for a server to extend.",
			});
			return null;
		}

		// The same three brakes the buffer-word source obeys, decided by the same
		// policy, so the explicit-trigger migration covers both sources at once
		// (spec #263): the explicit trigger always answers, a typing trigger is
		// gated by the popup's own rules — prose silence, `words: 'disabled'`, and
		// the minimum typed length. Only the global `automatic_completions` gate
		// sits above both sources, because it is a property of the popup rather
		// than of any one of them.
		const declined = declinedByTriggerRules(context, languageName, readTriggerSettings(), typed);
		if (declined) {
			coordinator.settleNow(context.pos, { state: "inactive", reason: declined.reason });
			return null;
		}

		return requestWith({ kind: 1 });
	};

	return { source, coordinator };
}

/**
 * `0` means *no bound*, which is the setting's documented default and Zed's; any
 * other value is a real bound. Passing `0` straight through as a timer would
 * make the default an instant failure, which is the opposite of what it says.
 */
function normalizeFetchTimeout(ms: number): number | undefined {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return undefined;
	return Math.trunc(ms);
}

/**
 * The popover result for one answer: the provider's items, ranked against the
 * note tier and applied under this language's insert mode.
 */
function serverResult(
	list: { readonly items: readonly CompletionSuggestion[]; readonly incomplete: boolean },
	from: number,
	to: number,
	settings: ServerCompletionSettings
): CompletionResult {
	return {
		from,
		// `replace_suffix` deliberately keeps the range CodeMirror filters
		// against, so the popover opens for the suffix the user typed. Under
		// `replace_range` the named range is applied at accept time instead,
		// inside the option's own `apply`.
		to,
		options: list.items.map((item) => serverOption(item, settings)),
		// No `validFor` and no `filter: false`, both deliberately. `validFor` means
		// "this list is still right, do not ask again" — the buffer-word source's
		// reason for having one and the opposite of what a server wants, since an
		// `isIncomplete` list is the protocol saying "ask me again as the user
		// keeps typing". `filter: false` sounds right for the same reason and is
		// wrong for a ranking one: CodeMirror puts unfiltered options at the *top*
		// of the popover, which would promote server items above the note tier
		// this whole module exists to leave alone.
	};
}

function serverOption(
	item: CompletionSuggestion,
	settings: ServerCompletionSettings
): Completion {
	return {
		label: item.label,
		type: SERVER_COMPLETION_TYPE,
		boost: SERVER_RANKS_WITH_NOTE_SOURCES,
		detail: item.detail ?? undefined,
		// `show_completion_documentation: false` drops the docs but keeps the
		// signature: the signature is the popover's shape, not documentation.
		info: settings.showDocumentation ? item.documentation ?? undefined : undefined,
		apply: serverApply(item, settings.insertMode)
	};
}

/**
 * Inserts `item.insertText` over the range the insert mode names.
 *
 * `replace_suffix` replaces the `from..to` CodeMirror hands the apply, which is
 * the range it filtered the label against — the suffix the user typed, and
 * nothing a server did not ask to be replaced. `replace_range` uses the range
 * the server named instead; without one it degrades to the suffix, because
 * silently replacing an unknown range is worse than replacing less.
 */
function serverApply(
	item: CompletionSuggestion,
	insertMode: CompletionLspInsertMode
): NonNullable<Completion["apply"]> {
	return (view, completion, applyFrom, applyTo) => {
		const range =
			insertMode === "replace_range" && item.replaceRange !== null
				? serverRangeToOffsets(view.state, item.replaceRange)
				: { from: applyFrom, to: applyTo };
		view.dispatch({
			...insertCompletionText(view.state, item.insertText, range.from, range.to),
			annotations: pickedCompletion.of(completion)
		});
	};
}

/**
 * Converts a server range to document offsets. A range the server computed
 * against an older revision of the document can point past its end, and every
 * consumer of an out-of-bounds offset would throw, so it is clamped into the
 * document rather than trusted.
 */
function serverRangeToOffsets(
	state: EditorState,
	range: NonNullable<CompletionSuggestion["replaceRange"]>
): { from: number; to: number } {
	const clamp = (line: number, character: number): number => {
		const clampedLine = Math.max(1, Math.min(Math.trunc(line) + 1, state.doc.lines));
		const text = state.doc.line(clampedLine);
		return Math.min(text.from + Math.max(0, Math.trunc(character)), text.from + text.length);
	};
	return {
		from: clamp(range.start.line, range.start.character),
		to: clamp(range.end.line, range.end.character)
	};
}
