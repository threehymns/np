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
 * - `lsp:platform`: published by the desktop app. Process spawning and one
 *   filesystem question, the two capabilities a neutral host cannot have
 *   itself; see {@link LspPlatform}.
 * - `completion:coordinator`: published by a Core Plugin that can answer a
 *   completion query about a document — a language server today. The editor
 *   shell reads it to compose its sources, and knows only that *something* can
 *   answer; see {@link CompletionCoordinator}.
 * - `settings:reader`: published by the app composer (AppState). Resolved
 *   values for the settings schemas, which the schema registry deliberately
 *   does not carry — and, optionally, a subscription to those values changing,
 *   which is what lets a consumer act on a setting instead of waiting for an
 *   unrelated event. See {@link SettingsReader}.
 */

import type { FileOrigin } from '../storage';
import type { VCSAdapter } from '../project/vcs';
import type { Repository } from '../project/repository.svelte';
import type { LspBundledCommand } from './lsp-descriptors';

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
	/**
	 * The document the active tab is showing, or nothing when the active tab is
	 * not a document. Optional so a test double stays a workspace without
	 * having to know the question exists.
	 *
	 * Read structurally and for one reason: the mounted editor view is not
	 * plugin surface (ADR 0016), so this is the one generic answer to "which file
	 * is being edited" a plugin can get without a new host method.
	 */
	readonly activeDocument?: {
		readonly id: string;
		readonly origin: { readonly path?: string } | null;
	} | null;
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
export const LSP_PLATFORM_SERVICE_KEY = 'lsp:platform';

/**
 * The platform seam (spec #263, ADR 0020).
 *
 * Everything the LSP plugin needs that `@np/core` cannot have for itself is
 * named here and nothing else: spawning a process, and asking the filesystem
 * whether a file exists. It is a *platform* and not a transport because a
 * transport is how bytes move along a connection, which is one half of this; the
 * other half is a filesystem question that no connection carries. The host owns
 * the *capability names*, never the implementation — the desktop app supplies
 * both over IPC (spec #263 keeps web out of scope, so a web build simply
 * publishes nothing), and the plugin degrades to "no LSP" when the service is
 * absent. That is what lets a real process and a real filesystem be tested
 * without either leaking into neutral core, and it is the same
 * provider/consumer-by-key arrangement as the `git:ui-components` precedent.
 */
export interface LspSpawnOptions {
	readonly command: string;
	readonly args: readonly string[];
	/** The resolved project root. Servers inherit it as their working directory. */
	readonly cwd: string;
	/**
	 * Which packaged dependency this server ships as, when it ships as one. The
	 * descriptor declares it and the transport acts on it, so a platform that
	 * resolves commands out of `node_modules` needs no per-server map of its own
	 * — which is what makes the second bundled server configuration (spec #263,
	 * story 10). Absent means PATH.
	 */
	readonly bundled?: LspBundledCommand;
}

/**
 * Byte sink. Bytes only: the client frames a message as UTF-8 and hands over the
 * result, so a transport that accepted strings too would have to guess an
 * encoding, and the one guess available would be wrong for a binary payload.
 */
export interface LspWritableStream {
	write(chunk: Uint8Array): void;
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
	/** Server pid, reported so a disable can assert the process is actually gone. */
	readonly pid?: number;
	/**
	 * Client pid the server should watch as its parent, for `initialize`.
	 * Distinct from {@link pid}: the server exits when its parent dies, so it
	 * must be told the client, not itself.
	 */
	readonly parentPid?: number;
	/**
	 * Settles once the transport can name the parent, with its pid when it has
	 * one and `undefined` when it never will.
	 *
	 * Optional because a transport that spawns in-process knows the parent
	 * before `spawn` returns. The desktop one does not: the renderer has no
	 * process host, so the parent arrives over IPC two round trips later —
	 * which is why this is a separate fact from `parentPid` rather than a
	 * promise the getter makes on demand. The client waits for it before
	 * declaring `processId`, so a server is told the parent it should watch
	 * and can exit when it dies instead of lingering.
	 */
	readonly ready?: Promise<number | undefined>;
	readonly stdin: LspWritableStream;
	readonly stdout: LspReadableStream;
	readonly stderr: LspReadableStream;
	/** Settles once the process has exited, by exit code or by signal. */
	readonly exit: Promise<LspProcessExit>;
	/** Terminates the process. Must be safe to call more than once. */
	kill(): void;
}

export interface LspPlatform {
	/** Whether a root marker exists at an absolute path. */
	fileExists(path: string): Promise<boolean>;
	spawn(options: LspSpawnOptions): LspProcess;
	/**
	 * Resident memory of one running server, in bytes, or null when unknown.
	 *
	 * Optional because a transport that cannot observe its child (or a test
	 * double with nothing to observe) still starts servers: the status row
	 * then says "not reported" rather than showing a blank or a zero (ticket
	 * #282). The desktop transport reads the child's RSS; the test fixture
	 * reads `/proc` on Linux and answers null elsewhere.
	 */
	processMemory?(pid: number): Promise<number | null>;
}

export const COMPLETION_COORDINATOR_SERVICE_KEY = 'completion:coordinator';

/**
 * Whoever can answer a hover query about a document (spec #280).
 *
 * Generic like its completion sibling: the editor shell asks about a position
 * and receives Markdown, without naming what is answering. A language server
 * is the first such provider.
 */
export const HOVER_COORDINATOR_SERVICE_KEY = 'hover:coordinator';

/**
 * Whoever can resolve what a first completion reply withheld (spec #280).
 *
 * Generic like the fetch it completes: the shell hands back the suggestion
 * it was given with its opaque `data`, and receives the same suggestion with
 * docs/detail filled (and confirm-time edits/command kept for later).
 */
export const COMPLETION_RESOLVE_SERVICE_KEY = 'completion:resolve';

export const SETTINGS_READER_SERVICE_KEY = 'settings:reader';

/**
 * Resolved settings values, for a plugin that has to act on one.
 *
 * The host's own `settings` surface is `SettingsRegistryLike`, and it is
 * schemas and nothing else: the schemas a plugin contributes, the transforms
 * that replay over them, and the materialized view. Resolved *values* live in
 * `SettingsResolver`, behind `SettingsManager`, which the plugin host does not
 * hold — and should not, because resolution is a consumer of the schemas rather
 * than part of the registry (ADR 0012, ADR 0014).
 *
 * So this is the seam instead. A plugin that must decide something *at runtime*
 * — whether to spawn a process, whether to sync a document — cannot have it
 * handed down by the editor shell, because the decision belongs to whichever
 * layer owns the document and the process, and passing it down would put the
 * feature's setting names in the shell. Reaching for the resolved value through
 * the host's own service registry keeps the shell naming no feature and lets the
 * plugin degrade: an app that publishes no reader gets the documented defaults,
 * which is the same answer "no platform published" already gives.
 *
 * The reader resolves one key at a time and does not know about languages.
 * Per-language scoping is a separate pure fold over `editor.languages`
 * (`editorSettingsForLanguage`), applied by whoever owns the document — because
 * the axis is per language and only the holder of the document knows which one it
 * is.
 */
export interface SettingsReader {
	/**
	 * The resolved value of one key: layered default < user < workspace, with the
	 * schema's default applied when nothing overrides it. `unknown` because the
	 * schema is the only thing that knows a key's type, and this reads across
	 * namespaces; narrowing is the caller's job, as it is wherever a setting is
	 * read.
	 */
	read(namespace: string, key: string): unknown;
	/**
	 * Subscribes to *value* changes and returns the unsubscribe function.
	 *
	 * Optional, because an app that publishes a reader has no obligation to have a
	 * signal to give — and because a consumer whose only job is to read a value on
	 * use has nothing to observe. A consumer that has to *act* on a setting cannot
	 * get a change any other way: it is not the host's `settings` surface, which
	 * notifies schema registration and not the values behind the schemas, and it
	 * cannot wait for the next document event, because a switch that takes effect on
	 * the next keystroke is a switch the user has learned to distrust. Absent, such a
	 * consumer goes on re-reading on the events it already had.
	 *
	 * Notified on the manager's own change signal, which fires for a mutation of
	 * *any* setting — so a listener must be cheap, must not assume the change was
	 * its own, and must re-read what it cares about rather than trust the
	 * notification to mean anything about its keys.
	 */
	subscribe?: SettingsSubscribe;
}

/** Subscribes to resolved-value changes; returns the unsubscribe function. */
export type SettingsSubscribe = (listener: () => void) => () => void;

/**
 * The read signature on its own, for a resolver written as a pure function of it.
 *
 * The editor's completion settings take this shape too, and deliberately so: two
 * readers that resolve `editor.languages` per language must be given the same
 * value for the same key, and a pure function is the easiest way to assert that
 * without a settings store in the room.
 */
export type SettingsRead = SettingsReader['read'];

/**
 * What a document is, as a completion query states it.
 *
 * Nested rather than flat because a query is about a *position* in a document and
 * the position means nothing without it — which is also what lets the shell hand
 * the same shape to any provider.
 */
export interface CompletionQueryDocument {
	/** Absolute path, or null for a document with no file yet. */
	readonly path: string | null;
	readonly fileName: string;
	readonly content: string;
	/** The language name the editor already resolved, when it has one. */
	readonly language?: string | null;
}

/** One position's completion query, as a completion source states it. */
export interface CompletionQuery {
	readonly document: CompletionQueryDocument;
	/** Zero-based line of the cursor. */
	readonly line: number;
	/** UTF-16 offset of the cursor within that line. */
	readonly character: number;
	/** How long a provider may hold this query up. Absent means no bound. */
	readonly timeoutMs?: number;
}

/** The range an accepted suggestion replaces, when the provider named one. */
export interface CompletionSuggestionRange {
	readonly start: { readonly line: number; readonly character: number };
	readonly end: { readonly line: number; readonly character: number };
}

/**
 * One suggestion, in the shape every provider's items are read as.
 *
 * Deliberately not any provider's wire format: the shell renders these, so it
 * must not have to know what any one protocol calls them.
 */
export interface CompletionSuggestion {
	readonly label: string;
	readonly insertText: string;
	/** One-line signature, for the popover's right-hand column. */
	readonly detail: string | null;
	/** Documentation as one string: JSDoc, a signature, or a rendered blob. */
	readonly documentation: string | null;
	readonly kind: number | null;
	/** Only meaningful for a provider whose settings name a range replace. */
	readonly replaceRange: CompletionSuggestionRange | null;
	/**
	 * Opaque provider data for a later resolve round trip (spec #280).
	 *
	 * Generic on purpose: a language server keeps its `data` here so a
	 * `completionItem/resolve` can ask for what the first reply withheld,
	 * and any other provider with a two-phase answer uses the same slot.
	 * Absent means nothing was withheld.
	 */
	readonly data?: unknown;
	/**
	 * Edits beyond the primary insert, applied at confirm time in a separate
	 * transaction (spec #280, Zed contract #292). Absent means none.
	 */
	readonly additionalTextEdits?: readonly CompletionAdditionalEdit[] | null;
	/** Command to run after the edits land, gated on the provider offering it. */
	readonly command?: CompletionSuggestionCommand | null;
}

/** One extra edit a resolved item carries, applied after the primary insert. */
export interface CompletionAdditionalEdit {
	readonly range: CompletionSuggestionRange;
	readonly newText: string;
}

/** A command a resolved item asks to run at confirm time. */
export interface CompletionSuggestionCommand {
	readonly command: string;
	readonly args?: readonly unknown[];
}

/**
 * The three-way answer a completion provider gives, and the whole of the
 * vocabulary a source needs to use one.
 *
 * `'inactive'` is not a failure: nothing was ever meant to answer, and any other
 * source answering there is the pre-provider behaviour rather than a degradation.
 * `'unavailable'` is a failure, and is the case a fallback source exists behind.
 */
export type CompletionAnswer =
	| { readonly state: 'inactive'; readonly reason: string }
	| {
			readonly state: 'serving';
			readonly items: readonly CompletionSuggestion[];
			/** Whether the provider wants to be asked again as the user keeps typing. */
			readonly incomplete: boolean;
	  }
	| { readonly state: 'unavailable'; readonly provider: string; readonly reason: string };

/**
 * Completion coordination, published by whoever can answer a query about a
 * document (ADR 0008, ADR 0020).
 *
 * Generic on purpose and generic in the only sense that matters: the editor shell
 * asks a question about a position and receives suggestions, without naming what
 * is answering. A language server is the first provider; a second one, or an
 * index of the user's own repository, is the same seam with a different
 * implementation behind it. Nothing here is protocol vocabulary, which is what
 * lets `Editor.svelte` read a provider without knowing one exists by name.
 */
export interface CompletionCoordinator {
	fetch(query: CompletionQuery): Promise<CompletionAnswer>;
}

/** One position's hover query, as the hover source states it. */
export interface HoverQuery {
	readonly document: CompletionQueryDocument;
	readonly line: number;
	readonly character: number;
	readonly timeoutMs?: number;
}

/** One hover answer: Markdown to render, or null when there is none. */
export interface HoverResult {
	readonly contents: string;
}

/**
 * The three-way answer a hover provider gives.
 *
 * `'serving'` with a null hover is still serving: the provider answered and
 * reported nothing, which hovers to nothing rather than to an error.
 */
export type HoverAnswer =
	| { readonly state: 'inactive'; readonly reason: string }
	| { readonly state: 'serving'; readonly hover: HoverResult | null }
	| { readonly state: 'unavailable'; readonly provider: string; readonly reason: string };

/** Hover coordination, published by whoever can answer a hover query. */
export interface HoverCoordinator {
	fetchHover(query: HoverQuery): Promise<HoverAnswer>;
}

/** Resolve coordination, published by whoever withholds docs until asked. */
export interface CompletionResolveCoordinator {
	resolveItem(item: CompletionSuggestion, document: CompletionQueryDocument, timeoutMs?: number): Promise<CompletionSuggestion>;
	runCommand(command: string, args: readonly unknown[] | undefined, document: CompletionQueryDocument): void;
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
