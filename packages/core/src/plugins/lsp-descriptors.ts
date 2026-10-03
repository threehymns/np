import { DuplicateLspDescriptorIdError } from './errors';

/**
 * Server descriptor contribution type (spec #263).
 *
 * A plugin declares *where a language server lives* and *which files it
 * serves*: an executable, its arguments, the markers that identify a project
 * root, and the languages it answers for. Joining happens on the language
 * identity the language registry already publishes, so a descriptor must name
 * a language another contribution registered: a server for a language nothing
 * can open a document as is unreachable.
 *
 * This registry is the whole of host core's knowledge of language servers. It
 * is a sibling *data* registry mirroring `languages.ts` and `completions.ts`,
 * not an `EditorContributionType`: `EditorContribution.extension` is a bare
 * CodeMirror `Extension`, and "start this process against this root" is not
 * one. The client, the process, the protocol, and the log buffers all live in
 * the LSP Core Plugin (ADR 0019), so the host stays free of feature-specific
 * machinery and adding the second server is configuration alone.
 */
export interface LspDescriptorContribution {
	/** Stable identity, unique across every registered plugin. */
	readonly id: string;
	/** Executable, resolved against PATH or a bundled package by the transport. */
	readonly command: string;
	/** Arguments passed to the command, e.g. `['--stdio']`. */
	readonly args: readonly string[];
	/**
	 * Files that identify a project root, ORDERED most specific first. The
	 * order selects the root, so it is data rather than a set: see
	 * `findProjectRoot` in the LSP plugin for the resolution rule.
	 */
	readonly rootMarkers: readonly string[];
	/** Languages this server serves, joined on language identity. Case-insensitive. */
	readonly languages: readonly string[];
}

/**
 * A materialized descriptor with its owning plugin. `owner` is bound by
 * {@link rebuildLspDescriptors} — stamped from the transform entry when the
 * transform claims the record with an empty owner, and preserved when it
 * re-emits one that already carries an owner — never by the plugin itself, so
 * it stays truthful when ownership moves on replay.
 */
export interface RegisteredLspDescriptor {
	readonly id: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly rootMarkers: readonly string[];
	readonly languages: readonly string[];
	readonly owner: string;
}

export type LspTransform = (
	previous: ReadonlyMap<string, RegisteredLspDescriptor>
) => ReadonlyMap<string, RegisteredLspDescriptor>;

export interface LspTransformEntry {
	readonly pluginId: string;
	readonly transform: LspTransform;
}

/**
 * Additive transform for the common case: appends (or overrides by id)
 * contributed descriptors during replay.
 */
export function createAddLspDescriptorsTransform(
	contributions: readonly LspDescriptorContribution[]
): LspTransform {
	const snapshot = contributions.map((c) => ({ ...c }));
	return (previous) => {
		const next = new Map(previous);
		for (const contribution of snapshot) {
			// Owner is bound by the entry wrapper during rebuild, so the
			// transform stays pure and replayable from an empty initial value.
			next.set(contribution.id, {
				id: contribution.id,
				command: contribution.command,
				args: [...contribution.args],
				rootMarkers: [...contribution.rootMarkers],
				languages: [...contribution.languages],
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
 * Ownership follows `rebuildSnippets` exactly: a record that arrives with an
 * empty owner is being claimed by the transform that emitted it and is stamped
 * with that plugin, while a record that already carries an owner keeps it.
 * Preserving the pre-bound owner is what makes a refresh transform safe — one
 * that re-emits a record it did not change, with a new object identity, stays
 * the original plugin's record instead of being re-attributed to whoever ran
 * last (and, worse, tripping the duplicate check below against the plugin
 * that actually wrote it).
 *
 * An ID may be claimed by exactly one owner: the ID is the registry key, and
 * two plugins claiming one server ID would leave two processes racing over the
 * same files with nothing reporting which descriptor won. Entries a transform
 * leaves untouched are never treated as a claim, so a duplicate is only ever
 * raised when a plugin actually claims the ID. Disabling a plugin drops its
 * transforms, which releases its IDs for the next replay.
 */
export function rebuildLspDescriptors(
	transforms: readonly LspTransformEntry[]
): RegisteredLspDescriptor[] {
	let state = new Map<string, RegisteredLspDescriptor>();
	const owners = new Map<string, string>();

	for (const entry of transforms) {
		const input = new Map(state);
		const next = new Map<string, RegisteredLspDescriptor>();

		for (const [id, descriptor] of entry.transform(input)) {
			if (input.get(id) === descriptor) {
				next.set(id, descriptor);
				continue;
			}
			const owned: RegisteredLspDescriptor =
				descriptor.owner === ''
					? { ...descriptor, owner: entry.pluginId }
					: { ...descriptor, owner: descriptor.owner || entry.pluginId };

			const previousOwner = owners.get(id);
			if (previousOwner !== undefined && previousOwner !== owned.owner) {
				throw new DuplicateLspDescriptorIdError(id, previousOwner, owned.owner);
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
 * Descriptors that serve one language identity, case-insensitively and in
 * registration order. Matching folds case here rather than at registration so
 * a pack can declare `'TypeScript'` and still find `'typescript'`, the same way
 * `getContributionsForType` matches a language-filtered editor contribution.
 *
 * More than one result is a conflict, not a preference: two descriptors both
 * claiming a file means two servers would index it, so the caller reports it
 * (ADR 0019) instead of picking one.
 */
export function getLspDescriptorsForLanguage(
	descriptors: readonly RegisteredLspDescriptor[],
	language: string
): RegisteredLspDescriptor[] {
	const lowered = language.toLowerCase();
	return descriptors.filter((d) => d.languages.some((l) => l.toLowerCase() === lowered));
}
