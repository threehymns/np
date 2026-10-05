import { DuplicateSnippetIdError } from './errors';

/**
 * One record in a plugin's Snippet Pack (spec #194 sibling of `languages.ts`).
 *
 * A plugin declares a set of typed triggers paired with the plain text that
 * replaces them. Joining happens on the language identity the language
 * registry already publishes, so a snippet pack must name a language another
 * contribution registered: the editor has no language target to attach a
 * completion source to otherwise.
 *
 * This is a sibling data registry rather than a new `EditorContributionType`
 * because `EditorContribution.extension` is a bare CodeMirror `Extension` and
 * a completion source is not one until it has a `Language` to attach to. The
 * host holds the registry; the editor turns the materialized records into a
 * completion source (see `packages/ui/src/editor/extensions/snippets.ts`).
 *
 * Bodies are plain text with no placeholders and no snippet variables:
 * expanding `$1` or tab stops is out of scope, so `body` is inserted
 * verbatim on accept.
 */
export interface SnippetRecord {
	/** Stable identity, unique across every registered plugin. */
	readonly id: string;
	/** Joins on language identity, e.g. 'svelte'. Case-insensitive. */
	readonly language: string;
	/** The typed prefix that summons the snippet. */
	readonly trigger: string;
	/** Plain text inserted on accept, no placeholders. */
	readonly body: string;
	/** Short human description, shown next to the option. */
	readonly description: string;
}

/**
 * A materialized snippet with its owning plugin. `owner` is bound by
 * {@link rebuildSnippets} — stamped from the transform entry when the
 * transform claims the record with an empty owner, and preserved when it
 * re-emits one that already carries an owner — never by the plugin itself,
 * so it stays truthful when ownership moves on replay.
 */
export interface RegisteredSnippet {
	readonly id: string;
	readonly language: string;
	readonly trigger: string;
	readonly body: string;
	readonly description: string;
	readonly owner: string;
}

export type SnippetTransform = (
	previous: ReadonlyMap<string, RegisteredSnippet>
) => ReadonlyMap<string, RegisteredSnippet>;

export interface SnippetTransformEntry {
	readonly pluginId: string;
	readonly transform: SnippetTransform;
}

/**
 * Additive transform for the common case: appends (or overrides by id)
 * contributed snippets during replay.
 */
export function createAddSnippetsTransform(
	records: readonly SnippetRecord[]
): SnippetTransform {
	const snapshot = records.map((c) => ({ ...c }));
	return (previous) => {
		const next = new Map(previous);
		for (const record of snapshot) {
			// Owner is bound by the entry wrapper during rebuild, so the
			// transform stays pure and replayable from an empty initial value.
			next.set(record.id, {
				id: record.id,
				language: record.language,
				trigger: record.trigger,
				body: record.body,
				description: record.description,
				owner: ''
			});
		}
		return next;
	};
}

/**
 * Replays transforms from an empty initial value (ADR 0012), in the owner
 * order the host computes, binding each materialized record's owner.
 *
 * Ownership follows `rebuildLanguages` exactly: a record that arrives with an
 * empty owner is being claimed by the transform that emitted it and is
 * stamped with that plugin, while a record that already carries an owner
 * keeps it. Preserving the pre-bound owner is what makes a refresh
 * transform safe — one that re-emits a record it did not change, with a new
 * object identity, stays the original plugin's record instead of being
 * re-attributed to whoever ran last (and, worse, tripping the duplicate
 * check below against the plugin that actually wrote it).
 *
 * An ID may be claimed by exactly one owner: the ID is the registry key, so
 * a later claim would otherwise silently replace the earlier plugin's trigger
 * and nothing would report why the snippet disappeared. Entries a transform
 * leaves untouched — same identity, or the same already-owned record — are
 * never treated as a claim, so a duplicate is only ever raised when a plugin
 * actually claims the ID. Disabling a plugin drops its transforms, which
 * releases its IDs for the next replay.
 */
export function rebuildSnippets(transforms: readonly SnippetTransformEntry[]): RegisteredSnippet[] {
	let state = new Map<string, RegisteredSnippet>();
	const owners = new Map<string, string>();

	for (const entry of transforms) {
		const input = new Map(state);
		const next = new Map<string, RegisteredSnippet>();

		for (const [id, snippet] of entry.transform(input)) {
			if (input.get(id) === snippet) {
				next.set(id, snippet);
				continue;
			}
			const owned: RegisteredSnippet = { ...snippet, owner: snippet.owner || entry.pluginId };

			const previousOwner = owners.get(id);
			if (previousOwner !== undefined && previousOwner !== owned.owner) {
				throw new DuplicateSnippetIdError(id, previousOwner, owned.owner);
			}
			owners.set(id, owned.owner);
			next.set(id, owned);
		}

		for (const id of state.keys()) {
			if (!next.has(id)) owners.delete(id);
		}

		state = next;
	}

	return [...state.values()];
}

/**
 * Snippets joining on one language identity, case-insensitively and in
 * registration order. Matching folds case here rather than at registration
 * so a pack can declare `'Svelte'` and still find `'svelte'`, the same way
 * `getContributionsForType` matches a language-filtered editor contribution.
 */
export function getSnippetsForLanguage(
	snippets: readonly RegisteredSnippet[],
	language: string
): RegisteredSnippet[] {
	const lowered = language.toLowerCase();
	return snippets.filter((s) => s.language.toLowerCase() === lowered);
}
