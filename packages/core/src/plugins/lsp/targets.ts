import { lspLanguageId, type RegisteredLspDescriptor } from '../lsp-descriptors';
import { ConflictingLspDescriptorError } from '../errors';
import { WORKSPACE_SERVICE_KEY, type LspPlatform, type WorkspaceLike } from '../services';
import type { PluginHostInterface } from '../types';
import type { LspLogStore } from './logs';
import { dirnameOf, findProjectRoot } from './root';

/**
 * Which server a document belongs to (spec #263, ADR 0020).
 *
 * A server is identified by `<descriptor id>@<project root>`: one descriptor
 * runs one process per project root, so a monorepo with three TypeScript
 * projects gets three servers and each one is restarted and stopped on its own.
 * The key is both the identity used for that and the name every log line,
 * status row and diagnostics entry carries, so it is defined next to the thing
 * it identifies rather than inside the runtime that starts them.
 */
export function lspServerKey(descriptorId: string, root: string): string {
	return `${descriptorId}@${root}`;
}

/** Enough recent files to cover a working session without growing forever. */
const MAX_RESOLVED_TARGETS = 128;

/**
 * Which server a document belongs to: the descriptor that claims its language
 * and the project root the walk landed on.
 *
 * Resolution is three questions in order — which language the document is, which
 * descriptor claims it, and which root the markers name — and none of them
 * starts a process or touches the protocol. Split out of `lifecycle.ts` because
 * resolution changes for one reason (a descriptor, a marker list, a boundary)
 * while starting a server changes for another, and the first is answerable with
 * no process in the room at all.
 */
export interface LspTarget {
	readonly descriptor: RegisteredLspDescriptor;
	readonly root: string;
	readonly marker: string | null;
}

/** The document facts resolution needs, structurally as the events deliver them. */
export interface LspTargetInput {
	/** Absolute path, or null for a document with no file yet. */
	readonly path: string | null;
	readonly fileName: string;
	readonly language?: string | null;
}

export interface LspTargetResolverOptions {
	readonly host: PluginHostInterface;
	readonly logs: LspLogStore;
	/**
	 * Resolves the platform, called per resolution rather than captured once: an
	 * app that publishes the seam after the plugin is active still gets it.
	 */
	readonly platform: () => LspPlatform | undefined;
}

export class LspTargetResolver {
	/**
	 * Resolved target per file path, keyed by the registry revision it was
	 * resolved against. Every keystroke arrives as a full-content change, and
	 * re-resolving one means a language match plus a marker walk that stats a
	 * file per level; the answer cannot change while the registry and the files
	 * on disk do not, and the registry's own revision counter says so.
	 */
	private readonly memo = new Map<string, { revision: number; target: LspTarget | null }>();

	constructor(private readonly options: LspTargetResolverOptions) {}

	/** The memoized target for a file, re-resolved whenever the registry moves. */
	async resolve(input: LspTargetInput): Promise<LspTarget | null> {
		if (!input.path) return null;
		const revision = this.options.host.lspRevision;
		const memo = this.memo.get(input.path);
		if (memo && memo.revision === revision) return memo.target;
		const target = await this.resolveNow(input);
		// Bounded rather than unbounded: a session that opens more files than
		// this has cleared every entry, and re-resolving a handful of them costs
		// one marker walk each.
		if (this.memo.size >= MAX_RESOLVED_TARGETS) this.memo.clear();
		this.memo.set(input.path, { revision, target });
		return target;
	}

	clear(): void {
		this.memo.clear();
	}

	/**
	 * The protocol's `languageId` for a document this descriptor serves.
	 *
	 * The two vocabularies meet here and nowhere else: the registry names the
	 * language, the descriptor maps that name to the id its server answers to,
	 * and a served name with no mapping lowercases — right for `TypeScript`,
	 * wrong for `TSX`, which is why the mapping is descriptor data (see
	 * `LspDescriptorContribution.languageIds`).
	 */
	languageIdFor(descriptor: RegisteredLspDescriptor, input: LspTargetInput): string {
		return lspLanguageId(descriptor, this.languageNameFor(input));
	}

	/** The language the app already resolved, or the registry's answer for the name. */
	languageNameFor(input: LspTargetInput): string | null {
		return (
			input.language ?? this.options.host.getLanguageForFile(input.fileName)?.name ?? null
		);
	}

	private async resolveNow(input: LspTargetInput): Promise<LspTarget | null> {
		if (!input.path) return null;
		const language = this.languageNameFor(input);
		if (!language) return null;
		const descriptors = this.options.host.getLspDescriptorsForLanguage(language);
		if (descriptors.length === 0) return null;
		if (descriptors.length > 1) {
			// Two servers would index the same file. Resolving it by registration
			// order would make the answer depend on which plugin enabled first, so
			// the conflict is reported instead and no server starts for this file.
			throw new ConflictingLspDescriptorError(
				input.path,
				descriptors.map((d) => d.id)
			);
		}
		const descriptor = descriptors[0];
		// Resolved after the descriptor check on purpose: a note that no server
		// serves must not report a missing platform, or every Markdown file in
		// the session would log one.
		const platform = this.options.platform();
		if (!platform) {
			// Recorded against the server this file would have used. Only a served
			// file reaches here, so a web session never logs it — a note must not
			// report a missing platform just because it has no server.
			this.options.logs.appendServerNote(
				lspServerKey(descriptor.id, dirnameOf(input.path)),
				'info',
				'No LSP platform is published, so this server cannot start. On web no platform exists by design (spec #263); elsewhere the desktop app failed to publish one.'
			);
			return null;
		}
		const resolution = await findProjectRoot({
			startDir: dirnameOf(input.path),
			markers: descriptor.rootMarkers,
			// The walk needs one question answered — does this marker exist — and the
			// platform is where that question goes. Adapting at the call site keeps
			// the walk's own dependency the one method it actually uses.
			probe: { fileExists: (path) => platform.fileExists(path) },
			boundary: this.workspaceRoot()
		});
		return { descriptor, root: resolution.root, marker: resolution.marker };
	}

	private workspaceRoot(): string | null {
		return (
			this.options.host.getService<WorkspaceLike>(WORKSPACE_SERVICE_KEY)?.project.rootOrigin
				?.path ?? null
		);
	}
}
