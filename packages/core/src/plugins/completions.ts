import { DuplicateSnippetIdError } from './errors';

/**
 * Snippet contribution type (spec #194 sibling of `languages.ts`).
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
export interface SnippetContribution {
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
 * {@link rebuildSnippets} from the transform entry, never by the plugin, so
 * it stays truthful when ownership moves on replay.
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
	contributions: readonly SnippetContribution[]
): SnippetTransform {
	const snapshot = contributions.map((c) => ({ ...c }));
	return (previous) => {
		const next = new Map(previous);
		for (const contribution of snapshot) {
			// Owner is bound by the entry wrapper during rebuild, so the
			// transform stays pure and replayable from an empty initial value.
			next.set(contribution.id, {
				id: contribution.id,
				language: contribution.language,
				trigger: contribution.trigger,
				body: contribution.body,
				description: contribution.description,
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
 * An ID may be claimed by exactly one owner: the ID is the registry key, so
 * the later transform would otherwise silently replace the earlier plugin's
 * trigger and nothing would report why the snippet disappeared. Entries a
 * transform leaves untouched are skipped, so a duplicate is only ever raised
 * when a plugin actually writes the ID. Disabling a plugin drops its
 * transforms, which releases its IDs for the next replay.
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
			const previousOwner = owners.get(id);
			if (previousOwner !== undefined && previousOwner !== entry.pluginId) {
				throw new DuplicateSnippetIdError(id, previousOwner, entry.pluginId);
			}
			owners.set(id, entry.pluginId);
			next.set(id, { ...snippet, owner: entry.pluginId });
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