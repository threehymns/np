/**
 * Well-known generic host service keys (#202, ADR 0008).
 *
 * The plugin host is a neutral meeting point: the app publishes opaque
 * services and plugins consume them by key with their own types. Keys and
 * value shapes are conventions owned by provider/consumer pairs, never by
 * the host, so no feature-specific methods accumulate on the host
 * interface. A second contributor (e.g. an exporter plugin) reuses the
 * same keys with no host change.
 *
 * - `workspace`: published by the Workspace itself on construction (and on
 *   setPluginHost). Lets feature plugins own per-workspace resources
 *   without the host naming any feature.
 * - `dialogs`: published by the app composer (AppState). Generic
 *   alert/confirm capability; consumers fall back to no-op/false when
 *   absent, matching the pre-plugin behavior of dialog-less contexts.
 * - `diffNavigator`: published by the app composer (AppState). Provider for
 *   the currently mounted diff view's hunk navigator, if any.
 * - `lsp:transport`: published by the desktop app. Process spawning and one
 *   filesystem question, the two capabilities a neutral host cannot have
 *   itself; see {@link LspTransport}.
 */

import type { FileOrigin } from '../storage';
import type { VCSAdapter } from '../project/vcs';
import type { Repository } from '../project/repository.svelte';

export interface ProjectLike {
	readonly rootOrigin: FileOrigin | null;
	readonly hasRootPermission: boolean;
	repository: Repository | null;
	/**
	 * Owning contributor for the published repository slot (generic, no
	 * feature names). Set alongside `repository` by whichever contributor
	 * publishes it; the project exposes repository state only while the
	 * owner is active, so a slot left behind by a bounded-cleanup timeout
	 * stays inert in the UI.
	 */
	repositoryOwnerId: string | null;
	readonly vcsFactory: (rootOrigin: FileOrigin) => VCSAdapter;
	readonly projectTree: {
		scan(origin: FileOrigin): Promise<void>;
	};
}

export interface WorkspaceLike {
	readonly project: ProjectLike;
	tabs: Array<{
		id: string;
		type: 'document' | 'diff';
		pluginId?: string;
	}>;
	activeTabId: string;
	closeTab(id: string): void;
	saveFolderState(folderUri: string): Promise<void>;
}

export const WORKSPACE_SERVICE_KEY = 'workspace';
export const DIALOGS_SERVICE_KEY = 'dialogs';
export const DIFF_NAVIGATOR_SERVICE_KEY = 'diffNavigator';
export const PLUGIN_UI_LOADER_SERVICE_KEY = 'plugin-ui-loader';
export const LSP_TRANSPORT_SERVICE_KEY = 'lsp:transport';

/**
 * Language-server transport seam (spec #263, ADR 0019).
 *
 * Everything the LSP plugin needs that `@np/core` cannot have for itself is
 * named here and nothing else: spawning a process, and asking the filesystem
 * whether a root marker exists. The host owns the *capability names*, never the
 * implementation — the desktop app supplies both over IPC (spec #263 keeps web
 * out of scope, so a web build simply publishes nothing), and the plugin
 * degrades to "no LSP" when the service is absent. That is what lets a real
 * process and a real filesystem be tested without either leaking into neutral
 * core, and it is the same provider/consumer-by-key arrangement as the `git:
 * ui-components` precedent.
 */
export interface LspSpawnOptions {
	readonly command: string;
	readonly args: readonly string[];
	/** The resolved project root. Servers inherit it as their working directory. */
	readonly cwd: string;
}

/** Byte sink. A string chunk is encoded as UTF-8 by the transport. */
export interface LspWritableStream {
	write(chunk: Uint8Array | string): void;
	/** Closes the sink. Servers treat end-of-input as "the client is gone". */
	end(): void;
}

/**
 * Byte source. Exposed as a subscribe function rather than a Node or DOM event
 * target so neither platform's stream type leaks into the plugin's contract.
 */
export interface LspReadableStream {
	/** Subscribes to chunks and returns the unsubscribe function. */
	onData(listener: (chunk: Uint8Array) => void): () => void;
}

export interface LspProcessExit {
	readonly code: number | null;
	readonly signal: string | null;
	/** Why it died, when the transport knows more than an exit code does. */
	readonly error?: string;
}

/** One running server: its pipes, its pid, and its termination. */
export interface LspProcess {
	/** Reported so a disable can assert the process is actually gone. */
	readonly pid?: number;
	readonly stdin: LspWritableStream;
	readonly stdout: LspReadableStream;
	readonly stderr: LspReadableStream;
	/** Settles once the process has exited, by exit code or by signal. */
	readonly exit: Promise<LspProcessExit>;
	/** Terminates the process. Must be safe to call more than once. */
	kill(): void;
}

export interface LspTransport {
	/** Whether a root marker exists at an absolute path. */
	fileExists(path: string): Promise<boolean>;
	spawn(options: LspSpawnOptions): LspProcess;
}

export interface PluginUILoader {
	load(pluginId: string): Promise<void>;
}

/**
 * Minimal hunk-navigation surface published by the mounted diff view.
 * Structural match for the app-level navigator type; defined here so
 * plugins can consume it without importing app modules.
 */
export interface DiffNavigatorLike {
	nextHunk(): void;
	prevHunk(): void;
}

/**
 * Provider for the currently mounted diff view's navigator, if any.
 * The app composer publishes one instance; plugins resolve it lazily so
 * activation order (before/after app construction) does not matter.
 */
export interface DiffNavigatorProvider {
	getCurrentNavigator(): DiffNavigatorLike | undefined;
}
