import type {
	Completion,
	CompletionContext,
	CompletionResult,
	CompletionSource,
} from "@codemirror/autocomplete";
import { EditorState, type Extension, type Text } from "@codemirror/state";
import type { Language } from "@codemirror/language";
import {
	EDITOR_COMPLETION_DEFAULTS,
	type CompletionAnswer,
	type CompletionWordsMode,
} from "@np/core";
import type { ServerOutcomeReader } from "./server-completions";

/**
 * Per-query knobs for the buffer-word source. Read through an injected reader
 * on every query instead of being captured when the source is built, so a
 * settings change never needs an editor reconfiguration.
 */
export interface BufferWordSettings {
	/**
	 * Shortest typed prefix before words trigger *automatically*. It says
	 * nothing about the vocabulary: on the explicit path the user asked, so
	 * every word-shaped token in the document that extends what they typed is
	 * offered however short it is — `fo` + Ctrl-Space completes `for`.
	 */
	readonly minWordLength: number;
	/**
	 * Gates automatic offers only. `'disabled'` means quiet, not unavailable:
	 * the explicit trigger still answers, in every language. `'fallback'` is
	 * different: it stands words down for as long as a server is answering,
	 * on both triggers, which is what makes them the path behind a failing one.
	 */
	readonly words: CompletionWordsMode;
	/**
	 * Whether {@link words} came from this language's own `editor.languages`
	 * entry rather than from the editor-level value. Needed because prose
	 * silence is a *default* an explicit override may reverse, and both cases
	 * arrive here as the same `'enabled'`.
	 */
	readonly wordsOverridden: boolean;
}

export const DEFAULT_BUFFER_WORD_SETTINGS: BufferWordSettings = {
	minWordLength: EDITOR_COMPLETION_DEFAULTS.minWordLength,
	words: EDITOR_COMPLETION_DEFAULTS.words,
	wordsOverridden: false,
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
	/** Shortest typed prefix that may summon words automatically. */
	readonly minWordLength: number;
	/**
	 * Whether words answer at all, on either trigger. Only `'fallback'` can
	 * turn this off, and only while a server is answering: `'disabled'` means
	 * quiet on a keystroke, not unavailable.
	 */
	readonly offered: boolean;
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
 * A Markdown code fence: three or more backticks or tildes, indented by up to
 * three spaces. An *opening* fence may carry an info string (the language name);
 * a *closing* fence carries nothing after it.
 */
const CODE_FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Whether `pos` sits inside a fenced code block.
 *
 * Silence is per prose, not per document: a note holding a code block is a note
 * *and* a code file, and #259 asks for quiet in the prose and automatic words in
 * the code file. The rule is the fence itself rather than the syntax tree,
 * because a text scan is a predicate a reader can predict without a parsed tree,
 * it needs no parser installed for the question to be answerable, and it degrades
 * the way Markdown does — a fence nobody closed yet still opens a block, because
 * the block is still being written.
 *
 * Deliberately not "any code": an indented (four-space) block and an inline code
 * span stay prose. Both are hard to tell from ordinary prose, and quiet-by-
 * default is the safer error for a rule that has to guess.
 */
function insideCodeFence(doc: Text, pos: number): boolean {
	let open: string | null = null;

	for (let line = 1; line <= doc.lineAt(pos).number; line++) {
		const match = CODE_FENCE_PATTERN.exec(doc.line(line).text);
		if (!match) continue;
		const [, fence, info] = match;
		if (open === null) {
			open = fence;
		} else if (
			fence[0] === open[0] &&
			fence.length >= open.length &&
			info.trim() === ""
		) {
			open = null;
		}
	}

	return open !== null;
}

/**
 * The single place deciding what a query may offer, so the trigger split, the
 * settings, the fence rule and the server fallback all land here instead of in
 * the source bodies.
 *
 * Three independent brakes on the automatic path, and none of them touches the
 * explicit one:
 *
 * - Markdown prose is quiet on a typing trigger by default. A note is prose
 *   being written, not code being recalled, and words fire constantly while
 *   writing. #259 asks for that silence; the explicit trigger stays available
 *   so prose is never worse off than before. It is a *default*, not a hard
 *   rule: a `{ "Markdown": { "words": "enabled" } }` entry in `editor.languages`
 *   reverses it, because the settings UI offers exactly that edit and an edit
 *   that does nothing is worse than no edit at all. It is per prose and not per
 *   document: a fenced code block inside the note is code the user is writing,
 *   so it gets the automatic offers a code file gets.
 * - `words: 'disabled'` silences the automatic path in every language. Off
 *   means quiet, not unavailable.
 *
 * `server` speaks only for `'fallback'`, and a serving server closes both
 * paths: `offered` because a server that answered owns the popover, and
 * `automatic` because there is no separate "automatic" server behaviour to
 * consult — the global popup gate already covers the trigger, and there is no
 * automatic trigger on the server side to gate. A server that errored or timed
 * out answers neither way, which is the whole point of the mode.
 */
export function resolveBufferWordPolicy(
	languageName: string | null,
	settings: BufferWordSettings,
	doc: Text,
	pos: number,
	server: CompletionAnswer | null = null,
): BufferWordPolicy {
	const proseQuiet =
		isMarkdownProse(languageName) &&
		!settings.wordsOverridden &&
		!insideCodeFence(doc, pos);
	const fallbackQuiet = settings.words === "fallback" && server?.state === "serving";
	return {
		automatic: settings.words !== "disabled" && !proseQuiet && !fallbackQuiet,
		minWordLength: normalizeMinWordLength(settings.minWordLength),
		offered: !fallbackQuiet,
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
	/**
	 * Where the server source's answer for this query comes from. Optional, and
	 * omitted whenever the chain has no server source — a document with no
	 * server, or an editor state built without an LSP runtime.
	 */
	readonly server?: ServerOutcomeReader | null;
}

function staticDefaultSettings(): BufferWordSettings {
	return DEFAULT_BUFFER_WORD_SETTINGS;
}

/** A reader that has never been asked anything, so nothing is in flight. */
const NO_SERVER_QUERIES: ServerOutcomeReader = { queryFor: () => null };

/**
 * Current-document words, ranked behind every other completion source.
 *
 * Offered on the explicit trigger in every language and file type, and on a
 * typing trigger wherever {@link resolveBufferWordPolicy} allows it — code
 * files only, and only past the minimum *typed* length.
 *
 * The vocabulary is the open document and nothing else: there is no index
 * behind it, so every query re-reads `context.state.doc` and no staleness rule
 * is needed. It carries no length floor, because the setting is a trigger
 * threshold and not a vocabulary rule.
 *
 * The query may return a promise, and that is new: deciding synchronously would
 * have to guess whether an in-flight server request will succeed, and a guess
 * wrong in the direction of "serving" is the silence `fallback` exists to
 * remove. When nothing is in flight — every note, and every editor state built
 * without an LSP runtime — the answer is immediate and nothing changes.
 */
export function bufferWordCompletions(options: BufferWordSourceOptions): CompletionSource {
	const { languageName, readSettings = staticDefaultSettings, server = null } = options;

	return (
		context: CompletionContext,
	): CompletionResult | null | Promise<CompletionResult | null> => {
		const query = (server ?? NO_SERVER_QUERIES).queryFor(context.pos);
		const decide = (outcome: CompletionAnswer | null): CompletionResult | null => {
			const settings = readSettings();
			const policy = resolveBufferWordPolicy(
				languageName,
				settings,
				context.state.doc,
				context.pos,
				outcome,
			);
			if (!policy.offered) return null;

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
			const labels = bufferVocabulary(context.state.doc.toString(), typed.from).filter((label) =>
				label.toLowerCase().startsWith(prefix),
			);

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

		if (query && query.settled === null) return query.outcome.then(decide);
		return decide(query?.settled ?? null);
	};
}

export interface FenceWordFallbackOptions extends BufferWordSourceOptions {
	/** Active language the chain registered its sources on. */
	readonly language: Language | null;
}

/**
 * The word source for fenced code blocks whose nested language has loaded.
 *
 * Once a fence's language loads, the fence parses as nested language content
 * and `languageDataAt` at the cursor resolves to that language alone, so the
 * word source the chain registered on the note's language is no longer
 * consulted there. Whether the nested language has loaded is process-wide
 * memoization (`LanguageDescription.load`), which is why the same note offers
 * words in a fresh process and goes quiet later: completion sources must be
 * reachable wherever the cursor can be, not just where the top language is.
 *
 * This provider fills exactly that shadow and nothing else. It stays silent
 * wherever the top language is still active at the cursor (so it never
 * double-serves a position the chain already covers) and everywhere outside a
 * fence (so prose silence, the explicit trigger, and every non-Markdown
 * language behave exactly as the chain alone defines them). The served source
 * is the same buffer-word source, so its policy — threshold, disabled words,
 * prose quiet — still decides every query.
 */
export function fenceWordFallback(options: FenceWordFallbackOptions): Extension[] {
	const { language, languageName } = options;
	if (!language || !isMarkdownProse(languageName)) return [];
	const source = bufferWordCompletions(options);
	return [
		EditorState.languageData.of((state, pos, side) => {
			if (language.isActiveAt(state, pos, side)) return [];
			if (!insideCodeFence(state.doc, pos)) return [];
			return [{ autocomplete: source }];
		}),
	];
}

/**
 * Distinct tokens in document order, first occurrence winning. Document order
 * is the only ranking a reader of the buffer can predict — nothing here has a
 * corpus behind it, so frequency would make the list jump as the file grows.
 * The token under the cursor is skipped: it is the prefix being typed.
 */
function bufferVocabulary(text: string, typedFrom: number): string[] {
	const seen = new Set<string>();
	const labels: string[] = [];
	// matchAll clones the pattern, so the shared regex keeps its position.
	for (const match of text.matchAll(BUFFER_WORD_PATTERN)) {
		const start = match.index;
		if (start === typedFrom) continue;
		const label = match[0];
		if (seen.has(label)) continue;
		seen.add(label);
		labels.push(label);
	}
	return labels;
}
