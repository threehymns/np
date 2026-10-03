import { LanguageDescription } from '@codemirror/language';

/**
 * Language-mode contribution type (spec #194).
 *
 * Reuses the CodeMirror description shape: a stable identity (name +
 * aliases) with file matchers (extensions, filename patterns) and an
 * opaque lazy loader. The host folds extension case once, centrally —
 * plugins declare extensions in any case, the transform lowercases them.
 *
 * Anticipated future contribution types (completions, hover, diagnostics)
 * will join on `name`, so it must stay stable. Nothing in those layers
 * changes this registry shape.
 */
export interface LanguageContribution {
	/** Stable identity, e.g. 'svelte', 'TypeScript', 'Markdown'. */
	readonly name: string;
	/** Alternate names, e.g. ['sv'] for Svelte. */
	readonly aliases?: readonly string[];
	/** File extensions without the dot, e.g. ['svelte', 'ts']. Case-insensitive. */
	readonly extensions?: readonly string[];
	/**
	 * Filename pattern for extensionless names (Dockerfile, CMakeLists).
	 * Passed straight through to `LanguageDescription.of` as `filename`.
	 */
	readonly filename?: RegExp;
	/**
	 * Opaque zero-argument loader. Setup registers metadata plus this
	 * loader and performs no grammar import of its own — grammar packages
	 * are reachable only through a dynamic `import()` inside the loader,
	 * keeping every grammar in its own lazy chunk.
	 */
	readonly load: () => Promise<unknown>;
}

/**
 * A materialized language with its owning plugin. `description` is the
 * CodeMirror handle used for matching and loading; `extensions` is the
 * lowercased matcher list the host folded centrally at registration.
 */
export interface RegisteredLanguage {
	readonly name: string;
	readonly aliases: readonly string[];
	readonly extensions: readonly string[];
	readonly filename?: RegExp;
	readonly load: () => Promise<unknown>;
	readonly owner: string;
	readonly description: LanguageDescription;
}

/**
 * Deterministic-conflict diagnostic: two plugins claimed one extension.
 * Later registrations override earlier ones everywhere; this record names
 * both owners so the conflict is debuggable instead of silent.
 */
export interface LanguageConflict {
	readonly extension: string;
	readonly previousOwner: string;
	readonly previousLanguage: string;
	readonly newOwner: string;
	readonly newLanguage: string;
	/** The winner is always the later registration. */
	readonly winner: string;
	readonly winnerLanguage: string;
}

export type LanguageTransform = (
	previous: ReadonlyMap<string, RegisteredLanguage>
) => ReadonlyMap<string, RegisteredLanguage>;

export interface LanguageTransformEntry {
	readonly pluginId: string;
	readonly transform: LanguageTransform;
}

/** Host-owned seeded base (ADR 0012 lowest priority). */
export const CORE_LANGUAGES_OWNER = 'core.languages';

function toRegistered(contribution: LanguageContribution, owner: string): RegisteredLanguage {
	const extensions = [...(contribution.extensions ?? [])].map((e) => e.toLowerCase());
	const aliases = [...(contribution.aliases ?? [])];
	const description = LanguageDescription.of({
		name: contribution.name,
		alias: aliases,
		extensions,
		filename: contribution.filename,
		load: contribution.load as () => Promise<any>
	});
	return {
		name: contribution.name,
		aliases,
		extensions,
		filename: contribution.filename,
		load: contribution.load,
		owner,
		description
	};
}

/**
 * Additive transform for the common case: appends (or overrides by name)
 * contributed languages during replay.
 */
export function createAddLanguagesTransform(
	contributions: readonly LanguageContribution[]
): LanguageTransform {
	const snapshot = contributions.map((c) => ({ ...c }));
	return (previous) => {
		const next = new Map(previous);
		for (const contribution of snapshot) {
			// Owner is bound at registration time via the entry, not here;
			// the entry wrapper fills it in during rebuild. This keeps the
			// transform pure and replayable from an empty initial value.
			// Placeholder owner is replaced by rebuildLanguages below.
			next.set(contribution.name.toLowerCase(), {
				name: contribution.name,
				aliases: [...(contribution.aliases ?? [])],
				extensions: [...(contribution.extensions ?? [])].map((e) => e.toLowerCase()),
				filename: contribution.filename,
				load: contribution.load,
				owner: '',
				description: LanguageDescription.of({
					name: contribution.name,
					alias: [...(contribution.aliases ?? [])],
					extensions: [...(contribution.extensions ?? [])].map((e) => e.toLowerCase()),
					filename: contribution.filename,
					load: contribution.load as () => Promise<any>
				})
			});
		}
		return next;
	};
}

/**
 * Seed transform for the host-owned base table (e.g. `@codemirror/language-data`).
 * Takes ready-made descriptions so the host can seed without re-declaring
 * every language as a contribution.
 */
export function createSeedLanguagesTransform(descriptions: readonly LanguageDescription[]) {
	const snapshot = [...descriptions];
	return (_previous: ReadonlyMap<string, RegisteredLanguage>) => {
		const next = new Map<string, RegisteredLanguage>();
		for (const description of snapshot) {
			next.set(description.name.toLowerCase(), {
				name: description.name,
				aliases: [...((description as unknown as { alias?: readonly string[] }).alias ?? [])],
				extensions: [...description.extensions].map((e) => e.toLowerCase()),
				filename: (description as unknown as { filename?: RegExp }).filename,
				load: description.load.bind(description),
				owner: CORE_LANGUAGES_OWNER,
				description
			});
		}
		return next;
	};
}

export interface RebuiltLanguages {
	readonly languages: RegisteredLanguage[];
	readonly conflicts: LanguageConflict[];
}

/**
 * Replays transforms from an empty initial value (ADR 0012). Later
 * registrations override earlier ones by language name; extension-level
 * conflicts resolve the same way (later wins for file resolution) and are
 * recorded as diagnostics naming both owners. Disabling a plugin drops its
 * transforms so the next-latest owner shows through again on rebuild.
 */
export function rebuildLanguages(transforms: readonly LanguageTransformEntry[]): RebuiltLanguages {
	let state = new Map<string, RegisteredLanguage>();
	const extensionOwners = new Map<string, { owner: string; language: string }>();
	const conflicts: LanguageConflict[] = [];

	for (const entry of transforms) {
		const input = new Map(state);
		const raw = entry.transform(input);
		const next = new Map<string, RegisteredLanguage>();

		for (const [key, value] of raw) {
			const owned: RegisteredLanguage =
				value.owner === ''
					? toRegistered(
							{
								name: value.name,
								aliases: value.aliases,
								extensions: value.extensions,
								filename: value.filename,
								load: value.load
							},
							entry.pluginId
						)
					: value.owner === CORE_LANGUAGES_OWNER
						? value
						: { ...value, owner: value.owner || entry.pluginId };
			// Track extension conflicts: later wins, diagnostic names both.
			for (const ext of owned.extensions) {
				const prior = extensionOwners.get(ext);
				if (prior && prior.owner !== owned.owner) {
					conflicts.push({
						extension: ext,
						previousOwner: prior.owner,
						previousLanguage: prior.language,
						newOwner: owned.owner,
						newLanguage: owned.name,
						winner: owned.owner,
						winnerLanguage: owned.name
					});
				}
				extensionOwners.set(ext, { owner: owned.owner, language: owned.name });
			}
			next.set(key, owned);
		}

		state = next;
	}

	return { languages: [...state.values()], conflicts };
}

/**
 * Resolves a filename through the registry with the single precedence rule:
 * later registrations override earlier ones. The input list is in
 * registration order (seeded base first); matching runs latest-first so the
 * deterministic winner is found. Extension case is folded centrally —
 * callers pass the raw filename, this retries with a lowercased extension.
 * Unmapped files resolve to null (plain text), never to Markdown.
 */
export function matchLanguageForFile(
	languages: readonly RegisteredLanguage[],
	filename: string
): RegisteredLanguage | null {
	if (languages.length === 0) return null;
	// Latest-first so later registrations win.
	const ordered = [...languages].reverse().map((l) => l.description);
	const exact = LanguageDescription.matchFilename(ordered, filename);
	if (exact) {
		return [...languages].reverse().find((l) => l.description === exact) ?? null;
	}
	// language-data matching is case-sensitive; retry with a lowercased
	// extension so APP.TS resolves to TypeScript. Never fall back to
	// Markdown: unknown and extensionless files stay null (plain text).
	const dot = filename.lastIndexOf('.');
	if (dot >= 0 && dot < filename.length - 1) {
		const lowered = filename.slice(0, dot + 1) + filename.slice(dot + 1).toLowerCase();
		if (lowered !== filename) {
			const retry = LanguageDescription.matchFilename(ordered, lowered);
			if (retry) {
				return [...languages].reverse().find((l) => l.description === retry) ?? null;
			}
		}
	}
	return null;
}
