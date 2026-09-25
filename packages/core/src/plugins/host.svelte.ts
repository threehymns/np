import type {
	PluginCleanup,
	PluginHostInterface,
	PluginHostOptions,
	PluginManifest,
	PluginOperationContext,
	PluginPlatform,
	PluginRegistration,
	PluginState
} from './types';
import {
	DirectEditorViewAccessError,
	RawTransactionDispatchError,
	DocumentRevisionMismatchError,
	DependencyCycleError,
	DuplicateInterfaceProviderError,
	DuplicatePluginIdError,
	HookReentryError,
	InterfaceVersionMismatchError,
	MissingDependencyError,
	PluginActivationError,
	PluginNotFoundError,
	SaveCancelledError,
	UnsupportedPlatformError
} from './errors';
import type { DocumentSession } from "../document.svelte";
import type { KeymapBinding, KeymapRegistry, KeymapTransform } from '../keymap.svelte';
import type {
	FileIconTransform,
	ProductIconTransform,
	IconRegistryInterface
} from '../editor/icons-types';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import {
	createEditorContributionCompartments,
	createAddEditorContributionsTransform,
	rebuildEditorContributions,
	applyDocumentEditOperation,
	type EditorContribution,
	type EditorContributionEntry,
	type EditorContributionTransform,
	type EditorContributionTransformEntry,
	type EditorContributionType,
	type ApplyDocumentEditOptions,
	type DocumentEditResult,
	type AttachedEditor,
	type EditorCompartments
} from "./editor";
import {
	CORE_COMMANDS_OWNER,
	createAddCommandsTransform,
	rebuildCommands,
	type CommandRegistryLike,
	type CommandTransform,
	type CommandTransformEntry,
	type PluginCommand
} from './commands';
import type { EventHandler, EventHandlerEntry } from './events';
import {
	CORE_HOOKS_OWNER,
	type ActiveHookContext,
	type AfterSaveContext,
	type AfterSaveHook,
	type AfterSaveHookEntry,
	type BeforeSaveContext,
	type BeforeSaveHook,
	type BeforeSaveHookEntry,
	type BeforeSaveResult,
	type HookDocument,
	type WorkspaceOpenedContext,
	type WorkspaceOpenedHook,
	type WorkspaceOpenedHookEntry
} from './hooks';

import {
	CORE_SETTINGS_OWNER,
	EDITOR_SCHEMA,
	UI_SCHEMA,
	createAddSettingSchemaTransform,
	rebuildSettingSchemas,
	type SettingNamespaceSchema,
	type SettingSchemaTransform,
	type SettingSchemaTransformEntry,
	type SettingsRegistryLike
} from './settings';

import {
	CORE_UI_OWNER,
	createAddSidebarPanelsTransform,
	createAddStatusBarItemsTransform,
	createAddTabContentsTransform,
	rebuildSidebarPanels,
	rebuildStatusBarItems,
	rebuildTabContents,
	compareSidebarPanels,
	compareStatusBarItems,
	compareTabContents,
	type SidebarPanelContribution,
	type StatusBarItemContribution,
	type TabContentContribution,
	type StatusBarAlignment,
	type SidebarPanelTransformEntry,
	type StatusBarItemTransformEntry,
	type TabContentTransformEntry,
	type MountedContribution,
	type UIContributionProps,
	type UIContributionTarget,
	type UIContributionInstance,
	type UIContributionRegistryLike
} from './ui-contributions';

interface AsyncLocalStorageLike<T> {
	run<R>(store: T, fn: () => R): R;
	getStore(): T | undefined;
}

const AsyncLocalStorageClass: (new <T>() => AsyncLocalStorageLike<T>) | undefined =
	(globalThis as any).AsyncLocalStorage;

/**
 * Default bound on one plugin cleanup (ADR 0009). Cleanup is the last step
 * of disablement, so an unsettled cleanup must not be able to wedge the
 * plugin in `deactivating` or hang the caller forever.
 */
const DEFAULT_CLEANUP_TIMEOUT_MS = 5000;

/**
 * Default bound on how long a queued save waits for its turn when async
 * context propagation is unavailable. Long enough that a legitimately slow
 * hook never makes an unrelated save look like re-entry; short enough that
 * a hook that re-enters save surfaces as an error instead of a hang.
 */
const DEFAULT_SAVE_QUEUE_TIMEOUT_MS = 30000;

const saveHookStorage: AsyncLocalStorageLike<ActiveHookContext> | undefined =
	AsyncLocalStorageClass ? new AsyncLocalStorageClass<ActiveHookContext>() : undefined;

const PLUGIN_HOST_INTERFACE_KEYS = new SvelteSet(
	' hostVersion platform register registerAll unregister hasPlugin getManifest getManifests getPluginState isPluginActive getDeactivationReason getActiveDependents computeActivationOrder activate activateAll deactivate dispose registerCommandTransform registerCommands removePluginCommands rebuildCommands refreshCommands getCommand getCommands getCommandsByCategory executeCommand registerKeymapTransform registerKeymapBindings removePluginKeymaps registerFileIconTransform registerProductIconTransform removePluginIcons on off emit removePluginEvents registerBeforeSaveHook registerAfterSaveHook removePluginHooks runBeforeSave runAfterSave isExecutingSaveHook getActiveSaveHook checkSaveReentry runSaveExclusive registerWorkspaceOpenedHook removePluginWorkspaceHooks runWorkspaceOpened provideService getService settings registerSettingSchema registerSettingTransform removePluginSettings rebuildSettings refreshSettings getSettingSchema getSettingSchemas ui registerSidebarPanel registerSidebarPanels removePluginSidebarPanels getSidebarPanel getSidebarPanels registerStatusBarItem registerStatusBarItems removePluginStatusBarItems getStatusBarItem getStatusBarItems registerTabContent registerTabContents removePluginTabContents getTabContent getTabContents mountContribution unmountContribution rebuildUIContributions registerEditorContribution registerEditorContributionTransform registerEditorContributions removePluginEditorContributions rebuildEditorContributions getEditorContributions editorRevision editorContributionsRevision applyDocumentEdit '.split(/\s+/)
);

function createPluginHostInterface(host: PluginHost): PluginHostInterface {
	return new Proxy(Object.create(null), {
		get(_target, property) {
			if (typeof property !== 'string' || !PLUGIN_HOST_INTERFACE_KEYS.has(property)) {
				throw new DirectEditorViewAccessError(`host.${String(property)}`);
			}
			const value = Reflect.get(host, property, host);
			return typeof value === 'function' ? value.bind(host) : value;
		}
	});
}

function createHookDocumentView(document: HookDocument): HookDocument {
	return Object.freeze({
		get id() {
			return document.id;
		},
		get origin() {
			return document.origin;
		},
		get content() {
			return document.content;
		},
		get revision() {
			return document.revision;
		},
		get fileName() {
			return document.fileName;
		},
		get isModified() {
			return document.isModified;
		},
		get permissionState() {
			return document.permissionState;
		},
		get deletedOnDisk() {
			return document.deletedOnDisk;
		}
	});
}

export class PluginHost implements PluginHostInterface {
	readonly hostVersion = 0;
	readonly platform: PluginPlatform;

	// Internal state tracking
	private registrations = new SvelteMap<string, PluginRegistration>();
	// SvelteMap so UI derived state (e.g. SettingsModal plugin rows)
	// recomputes after activate/deactivate; a $state-wrapped plain Map does
	// not track .set/.delete mutations.
	private states = new SvelteMap<string, PluginState>();
	private deactivationReasons = new SvelteMap<string, string>();
	private cleanups = new SvelteMap<string, PluginCleanup>();
	private activationOrder = $state<string[]>([]);
	private disposed = false;
	private readonly cleanupTimeoutMs: number;
	private readonly saveQueueTimeoutMs: number;

	// Shared command registry: replayable transforms + materialized view.
	// Plugins contribute via registerCommands/registerCommandTransform during
	// setup; the host replays in order from an empty initial value on every
	// rebuild (ADR 0012). Palette and menus are views over this state.
	private commandTransforms: CommandTransformEntry[] = [];
	private commandMap = $state<Map<string, PluginCommand>>(new SvelteMap());
	private commandOwners = new SvelteMap<string, string>();
	private activePluginOperations = new SvelteMap<string, Set<Promise<unknown>>>();
	private attachedKeymapRegistry?: KeymapRegistry;
	private attachedIconRegistry?: IconRegistryInterface;

	// Event handlers (ADR 0013: events observe, fire-and-forget)
	private eventHandlers = new SvelteMap<string, EventHandlerEntry[]>();

	// Operation hooks (ADR 0013: hooks participate)
	private beforeSaveHooks: BeforeSaveHookEntry[] = [];
	private afterSaveHooks: AfterSaveHookEntry[] = [];
	private activeSaveHook: ActiveHookContext | null = null;
	private readonly operationContext: PluginOperationContext;
	private readonly pluginInterface: PluginHostInterface;
	private saveQueue: Promise<void> = Promise.resolve();
	private nextSaveId = 0;
	private currentSaveId = 0;
	lastHookError: { pluginId: string; error: unknown } | null = null;

	// Generic workspace-lifecycle hooks (#202): awaited participation in
	// folder open, ordered and filtered like save hooks.
	private workspaceOpenedHooks: WorkspaceOpenedHookEntry[] = [];

	// Generic application-service sharing (#202, ADR 0008): opaque
	// key-value publication. Keys are conventions owned by
	// provider/consumer pairs (see './services'); values are untyped here
	// so the host never names features.
	private services = new SvelteMap<string, unknown>();

	// Editor contribution contract (ADR 0016)
	readonly editorCompartments: EditorCompartments = createEditorContributionCompartments();
	editorRevision = $state(0);
	get editorContributionsRevision(): number {
		return this.editorRevision;
	}
	private editorContributionTransforms: EditorContributionTransformEntry[] = [];
	private editorContributions: EditorContributionEntry[] = [];
	private attachedEditors = new SvelteMap<string, AttachedEditor>();
	private documentSessions = new SvelteMap<string, DocumentSession>();
	private documentResolver?: (docId: string) => DocumentSession | undefined;

	/**
	 * Command registry facade with the same shape as the standalone
	 * CommandRegistry, so `AppState.commands` stays a drop-in view.
	 */
	// Shared settings schema registry: replayable transforms + materialized view (ADR 0012, ADR 0014).
	private settingSchemaTransforms: SettingSchemaTransformEntry[] = [];
	private settingSchemaMap = $state<Map<string, SettingNamespaceSchema>>(new SvelteMap());
	private settingsListeners = new SvelteSet<() => void>();

	readonly settings: SettingsRegistryLike = {
		registerTransform: (pluginId, transform) => this.registerSettingTransform(pluginId, transform),
		registerSchema: (pluginId, schema) => this.registerSettingSchema(pluginId, schema),
		removePlugin: (pluginId) => this.removePluginSettings(pluginId),
		rebuild: () => this.rebuildSettings(),
		refresh: () => this.refreshSettings(),
		getSchema: (namespace) => this.getSettingSchema(namespace),
		getAllSchemas: () => this.getSettingSchemas(),
		subscribe: (listener) => {
			this.settingsListeners.add(listener);
			return () => {
				this.settingsListeners.delete(listener);
			};
		}
	};

	readonly commands: CommandRegistryLike = {
		registerTransform: (pluginId, transform) => this.registerCommandTransform(pluginId, transform),
		registerCommands: (pluginId, commands) => this.registerCommands(pluginId, commands),
		removePlugin: (pluginId) => this.removePluginCommands(pluginId),
		rebuild: () => this.rebuildCommands(),
		refresh: () => this.refreshCommands(),
		get: (id) => this.getCommand(id),
		getAll: () => this.getCommands(),
		getByCategory: (category) => this.getCommandsByCategory(category),
		execute: (id, ...args) => this.executeCommand(id, ...args)
	};

	// Additive UI contribution registry: replayable transforms + materialized views (ADR 0010, ADR 0015).
	private sidebarPanelTransforms: SidebarPanelTransformEntry[] = [];
	private statusBarItemTransforms: StatusBarItemTransformEntry[] = [];
	private tabContentTransforms: TabContentTransformEntry[] = [];
	private sidebarPanelsMap = $state<Map<string, SidebarPanelContribution>>(new SvelteMap());
	private statusBarItemsMap = $state<Map<string, StatusBarItemContribution>>(new SvelteMap());
	private tabContentsMap = $state<Map<string, TabContentContribution>>(new SvelteMap());
	private mountedContributions = new SvelteMap<string, MountedContribution>();
	private nextMountedInstanceId = 1;

	/**
	 * UI contributions registry facade with the same shape as standalone UIContributionRegistry.
	 */
	readonly ui: UIContributionRegistryLike = {
		registerSidebarPanel: (pluginId, panel) => this.registerSidebarPanel(pluginId, panel),
		registerSidebarPanels: (pluginId, panels) => this.registerSidebarPanels(pluginId, panels),
		removePluginSidebarPanels: (pluginId) => this.removePluginSidebarPanels(pluginId),
		getSidebarPanel: (id) => this.getSidebarPanel(id),
		getSidebarPanels: () => this.getSidebarPanels(),

		registerStatusBarItem: (pluginId, item) => this.registerStatusBarItem(pluginId, item),
		registerStatusBarItems: (pluginId, items) => this.registerStatusBarItems(pluginId, items),
		removePluginStatusBarItems: (pluginId) => this.removePluginStatusBarItems(pluginId),
		getStatusBarItem: (id) => this.getStatusBarItem(id),
		getStatusBarItems: (alignment) => this.getStatusBarItems(alignment),

		registerTabContent: (pluginId, content) => this.registerTabContent(pluginId, content),
		registerTabContents: (pluginId, contents) => this.registerTabContents(pluginId, contents),
		removePluginTabContents: (pluginId) => this.removePluginTabContents(pluginId),
		getTabContent: (id) => this.getTabContent(id),
		getTabContents: () => this.getTabContents(),

		mountContribution: (pluginId, contributionId, target, props) =>
			this.mountContribution(pluginId, contributionId, target, props),
		unmountContribution: (instanceId) => this.unmountContribution(instanceId),
		unmountAllPluginContributions: (pluginId) => this.unmountAllPluginContributions(pluginId),
		getMountedContributions: (pluginId) => this.getMountedContributions(pluginId),

		rebuild: () => this.rebuildUIContributions(),
		removePlugin: (pluginId) => {
			this.removePluginUIContributions(pluginId);
		}
	};

	constructor(options: PluginHostOptions = {}) {
		this.operationContext = options.operationContext ?? (saveHookStorage
			? {
					propagation: 'async' as const,
					run: <T>(context: ActiveHookContext, callback: () => T) => saveHookStorage.run(context, callback),
					get: () => saveHookStorage.getStore()
				}
			: {
					propagation: 'none' as const,
					run: <T>(_context: ActiveHookContext, callback: () => T) => callback(),
					get: () => undefined
				});
		this.platform = options.platform ?? (typeof window !== 'undefined' && (window as any).electronAPI ? 'desktop' : 'web');
		this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
		this.saveQueueTimeoutMs = options.saveQueueTimeoutMs ?? DEFAULT_SAVE_QUEUE_TIMEOUT_MS;
		this.pluginInterface = createPluginHostInterface(this);
		this.registerSettingSchema(CORE_SETTINGS_OWNER, EDITOR_SCHEMA);
		this.registerSettingSchema(CORE_SETTINGS_OWNER, UI_SCHEMA);
		if (options.initialPlugins) {
			this.registerAll(options.initialPlugins);
		}
	}

	/**
	 * Registers a plugin registration.
	 * Rejects duplicate IDs with an actionable error (ADR 0007 / ADR 0017).
	 */
	register(plugin: PluginRegistration): void {
		const id = plugin.manifest.id;
		const existing = this.registrations.get(id);
		if (existing) {
			throw new DuplicatePluginIdError(id, existing.manifest, plugin.manifest);
		}

		this.registrations.set(id, plugin);
		this.states.set(id, 'inactive');
	}

	registerAll(plugins: readonly PluginRegistration[]): void {
		for (const plugin of plugins) {
			this.register(plugin);
		}
	}

	async unregister(id: string): Promise<void> {
		if (!this.registrations.has(id)) {
			return;
		}

		if (this.isPluginActive(id)) {
			await this.deactivate(id, 'Plugin unregistered');
		}

		this.registrations.delete(id);
		this.states.delete(id);
		this.deactivationReasons.delete(id);
		this.removePluginCommands(id);
		this.removePluginHooks(id);
		this.removePluginWorkspaceHooks(id);
		this.removePluginEvents(id);
		this.removePluginSettings(id);
		this.removePluginUIContributions(id);
		this.removePluginEditorContributions(id);
		this.removePluginKeymaps(id);
		this.removePluginIcons(id);
	}

	hasPlugin(id: string): boolean {
		return this.registrations.has(id);
	}

	/**
	 * Reads manifest metadata without loading plugin implementations.
	 */
	getManifest(id: string): PluginManifest | undefined {
		return this.registrations.get(id)?.manifest;
	}

	getManifests(): PluginManifest[] {
		return Array.from(this.registrations.values()).map((r) => r.manifest);
	}

	getPluginState(id: string): PluginState {
		return this.states.get(id) ?? 'inactive';
	}

	isPluginActive(id: string): boolean {
		return this.getPluginState(id) === 'active';
	}

	getDeactivationReason(id: string): string | undefined {
		return this.deactivationReasons.get(id);
	}

	/**
	 * Lists active plugins that depend on the given plugin, directly or
	 * transitively, in cascade order (dependents before dependencies).
	 * A dependent matches either via a direct plugin-ID dependsOn entry or
	 * via an interface this plugin provides (Cascade rule, ADR 0017).
	 */
	getActiveDependents(id: string): string[] {
		const result: string[] = [];
		const visited = new SvelteSet<string>([id]);
		const queue: string[] = [id];
		while (queue.length > 0) {
			const current = queue.shift()!;
			for (const dependent of this.directActiveDependents(current)) {
				if (!visited.has(dependent)) {
					visited.add(dependent);
					result.push(dependent);
					queue.push(dependent);
				}
			}
		}
		return result;
	}

	private directActiveDependents(id: string): string[] {
		const manifest = this.getManifest(id);
		if (!manifest) return [];
		const providedInterfaces = manifest.provides ? Object.keys(manifest.provides) : [];
		const dependents: string[] = [];
		for (const otherId of this.activationOrder) {
			if (otherId === id || !this.isPluginActive(otherId)) continue;
			const otherManifest = this.getManifest(otherId);
			if (otherManifest?.dependsOn) {
				const dependsOnThis =
					Object.hasOwn(otherManifest.dependsOn, id) ||
					Object.keys(otherManifest.dependsOn).some((iface) => providedInterfaces.includes(iface));
				if (dependsOnThis) {
					dependents.push(otherId);
				}
			}
		}
		return dependents;
	}

	// --------------------------------------------------------------------------
	// Command Registry Methods (ADR 0012, ADR 0015)
	// --------------------------------------------------------------------------

	/**
	 * Contributes a command transform for one owner and rebuilds by
	 * replaying all transforms in order from an empty initial value.
	 * Called by plugins during setup (ADR 0015: commands register where
	 * they are implemented).
	 */
	registerCommandTransform(pluginId: string, transform: CommandTransform): void {
		this.commandTransforms.push({ pluginId, transform });
		this.rebuildCommands();
	}

	/**
	 * Convenience for the common additive case: appends commands to the
	 * accumulated state during replay.
	 */
	registerCommands(pluginId: string, commands: readonly PluginCommand[]): void {
		this.registerCommandTransform(pluginId, createAddCommandsTransform(commands));
	}

	/**
	 * Drops one owner's transforms and rebuilds without them
	 * (Reactivation). Runs automatically on deactivate/unregister.
	 */
	removePluginCommands(pluginId: string): void {
		const kept = this.commandTransforms.filter((entry) => entry.pluginId !== pluginId);
		if (kept.length !== this.commandTransforms.length) {
			this.commandTransforms = kept;
			this.rebuildCommands();
		}
	}

	/**
	 * Replays current transforms from an empty initial value.
	 * Idempotent: same transforms always yield the same registry.
	 */
	rebuildCommands(): void {
		const owners = new SvelteMap<string, string>();
		this.commandMap = rebuildCommands(this.orderedCommandTransforms(), owners);
		this.commandOwners = owners;
	}

	/** Reload alias for rebuild (Reload terminology). */
	refreshCommands(): void {
		this.rebuildCommands();
	}

	getCommand(id: string): PluginCommand | undefined {
		return this.commandMap.get(id);
	}

	getCommands(): PluginCommand[] {
		return Array.from(this.commandMap.values());
	}

	getCommandsByCategory(category: string): PluginCommand[] {
		return this.getCommands().filter((command) => command.category === category);
	}

	executeCommand(id: string, ...args: any[]): any {
		const command = this.getCommand(id);
		if (!command || (command.isEnabled && !command.isEnabled())) return;

		const owner = this.commandOwners.get(id);
		const pluginId = owner && this.registrations.has(owner) ? owner : undefined;
		if (pluginId && !this.isPluginActive(pluginId)) return;

		if (!pluginId) return command.action(...args);

		const result = command.action(...args);
		if (!result || typeof result.then !== 'function') return result;

		const operation = Promise.resolve(result);
		let operations = this.activePluginOperations.get(pluginId);
		if (!operations) {
			operations = new SvelteSet();
			this.activePluginOperations.set(pluginId, operations);
		}
		operations.add(operation);
		void operation.then(
			() => this.finishPluginOperation(pluginId, operation),
			() => this.finishPluginOperation(pluginId, operation)
		);
		return operation;
	}

	registerKeymapTransform(pluginId: string, transform: KeymapTransform): void {
		this.attachedKeymapRegistry?.registerKeymapTransform(pluginId, transform);
	}

	registerKeymapBindings(pluginId: string, bindings: readonly KeymapBinding[]): void {
		this.attachedKeymapRegistry?.registerKeymapBindings(pluginId, bindings);
	}

	removePluginKeymaps(pluginId: string): void {
		this.attachedKeymapRegistry?.removePluginKeymaps(pluginId);
	}

	registerFileIconTransform(pluginId: string, transform: FileIconTransform): void {
		this.attachedIconRegistry?.registerFileIconTransform(pluginId, transform);
	}

	registerProductIconTransform(pluginId: string, transform: ProductIconTransform): void {
		this.attachedIconRegistry?.registerProductIconTransform(pluginId, transform);
	}

	removePluginIcons(pluginId: string): void {
		this.attachedIconRegistry?.removePluginIcons(pluginId);
	}

	private finishPluginOperation(pluginId: string, operation: Promise<unknown>): void {
		const operations = this.activePluginOperations.get(pluginId);
		if (!operations) return;
		operations.delete(operation);
		if (operations.size === 0) this.activePluginOperations.delete(pluginId);
	}

	private async waitForPluginOperations(pluginId: string): Promise<void> {
		while (this.activePluginOperations.has(pluginId)) {
			const operations = this.activePluginOperations.get(pluginId);
			if (!operations) break;
			await Promise.allSettled([...operations]);
		}
	}

	/**
	 * Runs one plugin's cleanup under a time bound. Cleanup is the final step
	 * of disablement (and of activation rollback), so an unsettled cleanup
	 * must not be able to hold the plugin in `deactivating` or hang the
	 * caller: it is reported against the owning plugin and the caller
	 * continues (ADR 0009). The plugin's own promise is left running, so a
	 * late rejection is absorbed rather than surfacing as an unhandled one.
	 */
	private async runPluginCleanup(
		pluginId: string,
		cleanup: PluginCleanup,
		phase: 'disablement' | 'activation rollback'
	): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const settled = Promise.resolve(cleanup()).then(() => 'settled' as const);
		const expiry = new Promise<'timedOut'>((resolve) => {
			timer = setTimeout(() => resolve('timedOut'), this.cleanupTimeoutMs);
		});

		try {
			const outcome = await Promise.race([settled, expiry]);
			if (outcome === 'timedOut') {
				settled.catch(() => {});
				console.error(
					`[PluginHost] Cleanup for plugin "${pluginId}" did not finish within ${this.cleanupTimeoutMs}ms; ` +
						`continuing ${phase} without it.\nAction: Inspect the "${pluginId}" plugin's cleanup function: it must settle ` +
						`within ${this.cleanupTimeoutMs}ms and must not await a promise that never resolves.`
				);
			}
		} catch (error) {
			console.error(`[PluginHost] Error during cleanup of plugin "${pluginId}":`, error);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	/**
	 * Deterministic owner ordering shared by every replayed registry and
	 * every ordered hook list (ADR 0012): built-in core owners first, then
	 * registered active plugins in computed activation order, then
	 * non-registered owners alphabetically. Registered-but-inactive owners
	 * are excluded so a missed disposal can never leak a contribution.
	 *
	 * The computed order is a pure function of the manifest graph, so a
	 * rebuild mid-session replays in the same sequence a clean build does.
	 * Toggle history (`activationOrder`) is deliberately not a sort key: it
	 * reorders as plugins are disabled and re-enabled, which would make a
	 * refreshed registry differ from a freshly built one.
	 */
	private orderedRegistryOwners(
		ownerIds: readonly string[],
		isCoreOwner: (id: string) => boolean
	): string[] {
		const present = new SvelteSet(ownerIds);
		const ordered: string[] = [];
		const push = (id: string) => {
			if (present.has(id) && !ordered.includes(id)) ordered.push(id);
		};

		// Built-in core owners first, in a stable order among themselves.
		for (const id of ownerIds.filter(isCoreOwner).sort()) {
			push(id);
		}

		const registeredActiveIds = ownerIds.filter(
			(id) => !isCoreOwner(id) && this.registrations.has(id) && this.isPluginActive(id)
		);
		if (registeredActiveIds.length > 0) {
			try {
				for (const id of this.computeActivationOrder(registeredActiveIds)) {
					push(id);
				}
			} catch {
				// An inconsistent manifest graph (cycle, missing or
				// mismatched dependency) is surfaced at activation and
				// startup; ordering still falls back to registration order
				// so a replay stays deterministic.
				for (const id of Array.from(this.registrations.keys())) {
					push(id);
				}
			}
		}

		// Non-registered owners alphabetically.
		for (const id of [...ownerIds].sort()) {
			if (!this.registrations.has(id)) {
				push(id);
			}
		}

		return ordered;
	}

	/**
	 * Orders transform owners deterministically: built-in core first, then
	 * active plugins in computed activation order, then any remaining owners
	 * alphabetically. Registered-but-inactive owners are excluded so a
	 * missed disposal can never leak commands.
	 */
	private orderedCommandTransforms(): CommandTransformEntry[] {
		const byOwner = new SvelteMap<string, CommandTransformEntry[]>();
		for (const entry of this.commandTransforms) {
			const list = byOwner.get(entry.pluginId);
			if (list) {
				list.push(entry);
			} else {
				byOwner.set(entry.pluginId, [entry]);
			}
		}

		const orderedOwners = this.orderedRegistryOwners(
			Array.from(byOwner.keys()),
			(id) => id === CORE_COMMANDS_OWNER
		);
		return orderedOwners.flatMap((id) => byOwner.get(id)!);
	}

	// --------------------------------------------------------------------------
	// Event Observation Methods (ADR 0013: Events observe, fire-and-forget)
	// --------------------------------------------------------------------------

	/**
	 * Every registered handler and hook names the plugin that owns it, and
	 * removal is by owner id. An unregistered owner would therefore be
	 * accepted and then retained forever, outliving every deactivate of the
	 * plugin that actually registered it, so the owner is checked at
	 * registration instead (ADR 0013, ADR 0009).
	 */
	private assertRegistrationOwner(pluginId: string, kind: string): void {
		if (!pluginId) {
			throw new Error(`${kind} must declare an owning plugin id.`);
		}
		if (!this.registrations.has(pluginId)) {
			throw new Error(
				`${kind} owner "${pluginId}" is not registered.\n` +
					`Action: pass the id from the manifest of the plugin calling this registration ` +
					`(host.getManifests().map((m) => m.id) lists the registered ids).`
			);
		}
	}

	/**
	 * Subscribes an event handler for observation.
	 * Handlers cannot mutate payload outcome, veto, or fail host operations.
	 */
	on<T = unknown>(event: string, handler: EventHandler<T>, pluginId: string): () => void {
		this.assertRegistrationOwner(pluginId, 'Event handler');
		let list = this.eventHandlers.get(event);
		if (!list) {
			list = [];
			this.eventHandlers.set(event, list);
		}
		const entry: EventHandlerEntry<T> = { pluginId, handler };
		list.push(entry);
		return () => {
			this.removeEventEntry(event, entry);
		};
	}

	off<T = unknown>(event: string, handler: EventHandler<T>, pluginId: string): void {
		const list = this.eventHandlers.get(event);
		if (!list) return;
		const index = list.findIndex((e) => e.handler === handler && e.pluginId === pluginId);
		if (index !== -1) {
			list.splice(index, 1);
		}
		if (list.length === 0) {
			this.eventHandlers.delete(event);
		}
	}

	private removeEventEntry<T>(event: string, entry: EventHandlerEntry<T>): void {
		const list = this.eventHandlers.get(event);
		if (!list) return;
		const index = list.indexOf(entry as EventHandlerEntry);
		if (index !== -1) {
			list.splice(index, 1);
		}
		if (list.length === 0) {
			this.eventHandlers.delete(event);
		}
	}

	emit<T = unknown>(event: string, payload?: T): void {
		const list = this.eventHandlers.get(event);
		if (!list || list.length === 0) return;

		for (const entry of [...list]) {
			if (!this.registrations.has(entry.pluginId) || !this.isPluginActive(entry.pluginId)) {
				continue;
			}
			try {
				const result = entry.handler(payload);
				if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
					void Promise.resolve(result).catch((err) => {
						console.error(
							`[PluginHost] Error in async event handler for "${event}" (plugin "${entry.pluginId}"):`,
							err
						);
					});
				}
			} catch (err) {
				console.error(
					`[PluginHost] Error in event handler for "${event}" (plugin "${entry.pluginId}"):`,
					err
				);
			}
		}
	}

	removePluginEvents(pluginId: string): void {
		for (const [event, list] of this.eventHandlers.entries()) {
			const filtered = list.filter((e) => e.pluginId !== pluginId);
			if (filtered.length === 0) {
				this.eventHandlers.delete(event);
			} else {
				this.eventHandlers.set(event, filtered);
			}
		}
	}

	// --------------------------------------------------------------------------
	// Document Save Hooks (ADR 0013: Hooks participate)
	// --------------------------------------------------------------------------

	/**
	 * Registers a before-save hook.
	 * Runs sequentially in plugin activation order and is always awaited.
	 */
	registerBeforeSaveHook(pluginId: string, hook: BeforeSaveHook): () => void {
		this.assertRegistrationOwner(pluginId, 'Before-save hook');
		const entry: BeforeSaveHookEntry = { pluginId, hook };
		this.beforeSaveHooks.push(entry);
		return () => {
			const idx = this.beforeSaveHooks.indexOf(entry);
			if (idx !== -1) {
				this.beforeSaveHooks.splice(idx, 1);
			}
		};
	}

	/**
	 * Registers an after-save hook.
	 * Runs after save finishes and is awaited.
	 */
	registerAfterSaveHook(pluginId: string, hook: AfterSaveHook): () => void {
		this.assertRegistrationOwner(pluginId, 'After-save hook');
		const entry: AfterSaveHookEntry = { pluginId, hook };
		this.afterSaveHooks.push(entry);
		return () => {
			const idx = this.afterSaveHooks.indexOf(entry);
			if (idx !== -1) {
				this.afterSaveHooks.splice(idx, 1);
			}
		};
	}

	removePluginHooks(pluginId: string): void {
		this.beforeSaveHooks = this.beforeSaveHooks.filter((e) => e.pluginId !== pluginId);
		this.afterSaveHooks = this.afterSaveHooks.filter((e) => e.pluginId !== pluginId);
	}

	isExecutingSaveHook(): boolean {
		return this.activeSaveHook !== null;
	}

	getActiveSaveHook(): ActiveHookContext | null {
		const store = this.operationContext.get();
		if (store && (!store.host || store.host === this)) {
			return store;
		}
		return this.activeSaveHook;
	}

	checkSaveReentry(operation = 'saveDocument', phase = 'beforeSave hook'): void {
		const store = this.operationContext.get();
		if (store && (!store.host || store.host === this)) {
			if (this.currentSaveId === 0 || store.saveId === undefined || store.saveId === this.currentSaveId) {
				throw new HookReentryError(
					store.pluginId,
					operation,
					store.phase ?? phase
				);
			}
			return;
		}

		// Fallback for environments without AsyncLocalStorage
		if (this.operationContext.propagation !== 'none' || !this.activeSaveHook) return;
		throw new HookReentryError(
			this.activeSaveHook.pluginId,
			operation,
			this.activeSaveHook.phase ?? phase
		);
	}

	/**
	 * Serializes independent saves so concurrent Workspace.saveDocument calls
	 * wait instead of being misidentified as hook re-entry. Re-entrant calls
	 * from the same save's hook still throw via checkSaveReentry before queuing,
	 * avoiding deadlock.
	 */
	async runSaveExclusive<T>(fn: () => Promise<T>): Promise<T> {
		// Precise re-entry detection needs async context. Without it the only
		// signal is "a hook is running somewhere on this host", which is also
		// true for an unrelated caller, so the check is deferred to the
		// bounded queue wait below instead of rejecting it here.
		if (this.operationContext.propagation === 'async') {
			this.checkSaveReentry('saveDocument', 'beforeSave hook');
		}
		const prev = this.saveQueue;
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.saveQueue = prev.then(() => current);
		await this.awaitSaveTurn(prev);
		const prevSaveId = this.currentSaveId;
		this.currentSaveId = ++this.nextSaveId;
		try {
			return await fn();
		} finally {
			this.currentSaveId = prevSaveId;
			release();
		}
	}

	/**
	 * Waits for this save's turn in the save queue.
	 *
	 * With async context a re-entrant call never reaches here: it is rejected
	 * up front by checkSaveReentry. Without async context the host cannot
	 * separate a caller inside the in-flight save's own hook from an unrelated
	 * caller, so the queued save waits — an independent save must never be
	 * refused because some hook happens to be running. A hook that re-enters
	 * save can never release the turn it is itself waiting on, so a turn that
	 * stays blocked while a hook is still active is reported as re-entry
	 * against that hook's plugin instead of deadlocking forever.
	 */
	private async awaitSaveTurn(prev: Promise<void>): Promise<void> {
		if (this.operationContext.propagation === 'async') {
			await prev;
			return;
		}

		let timer: ReturnType<typeof setTimeout> | undefined;
		const expiry = new Promise<'timedOut'>((resolve) => {
			timer = setTimeout(() => resolve('timedOut'), this.saveQueueTimeoutMs);
		});
		const outcome = await Promise.race([prev.then(() => 'acquired' as const), expiry]);
		if (timer !== undefined) clearTimeout(timer);
		if (outcome === 'acquired') return;

		const holder = this.activeSaveHook;
		if (!holder) {
			// No hook is holding the turn: the in-flight save is simply slow,
			// which is not re-entry. Keep waiting.
			await prev;
			return;
		}
		throw new HookReentryError(
			holder.pluginId,
			'saveDocument',
			holder.phase ?? 'beforeSave hook'
		);
	}

	private async invokeSaveHook<T>(
		pluginId: string,
		phase: string,
		invoke: () => T | Promise<T>
	): Promise<T> {
		const context: ActiveHookContext = {
			pluginId,
			operation: 'saveDocument',
			phase,
			saveId: this.currentSaveId,
			host: this
		};
		this.activeSaveHook = context;
		// Track per-plugin so deactivate waits for active writes (ADR 0009)
		// before running cleanup, matching command operation tracking.
		const execution = this.operationContext.run(context, async () => await invoke());
		const tracked = Promise.resolve(execution);
		let operations = this.activePluginOperations.get(pluginId);
		if (!operations) {
			operations = new SvelteSet();
			this.activePluginOperations.set(pluginId, operations);
		}
		operations.add(tracked);
		try {
			return await tracked as T;
		} finally {
			this.activeSaveHook = null;
			this.finishPluginOperation(pluginId, tracked);
		}
	}

	/**
	 * Runs before-save hooks sequentially in plugin activation order.
	 * A throwing hook is logged against its plugin and never vetos save.
	 * Can cancel save if a hook returns `{ cancel: true, reason }` or throws `SaveCancelledError`.
	 */
	async runBeforeSave(context: BeforeSaveContext): Promise<BeforeSaveResult> {
		this.checkSaveReentry('saveDocument', 'beforeSave hook');

		const ordered = this.getOrderedBeforeSaveHooks();

		for (const entry of ordered) {
			try {
				const result = await this.invokeSaveHook(
					entry.pluginId,
					'beforeSave hook',
					() => entry.hook({ ...context, document: createHookDocumentView(context.document) })
				);
				if (result && typeof result === 'object' && result.cancel) {
					return {
						cancel: true,
						reason: result.reason ?? 'Save cancelled by plugin'
					};
				}
			} catch (error) {
				if (error instanceof SaveCancelledError) {
					return {
						cancel: true,
						reason: error.reason
					};
				}
				this.lastHookError = { pluginId: entry.pluginId, error };
				console.error(`[PluginHost] Error in beforeSave hook for plugin "${entry.pluginId}":`, error);
			}
		}

		return { cancel: false };
	}

	/**
	 * Runs after-save hooks in plugin activation order.
	 * Errors are caught and logged against the contributing plugin.
	 * No re-entry check on entry: an independent save must not fail after
	 * its document has already been written; re-entry from within an
	 * afterSave hook is still rejected via Workspace.saveDocument's check.
	 */
	async runAfterSave(context: AfterSaveContext): Promise<void> {
		const ordered = this.getOrderedAfterSaveHooks();

		for (const entry of ordered) {
			try {
				await this.invokeSaveHook(
					entry.pluginId,
					'afterSave hook',
					() => entry.hook({ ...context, document: createHookDocumentView(context.document) })
				);
			} catch (error) {
				this.lastHookError = { pluginId: entry.pluginId, error };
				console.error(`[PluginHost] Error in afterSave hook for plugin "${entry.pluginId}":`, error);
			}
		}
	}

	private getOrderedBeforeSaveHooks(): BeforeSaveHookEntry[] {
		return this.orderOwnedHooks(this.beforeSaveHooks);
	}

	private getOrderedAfterSaveHooks(): AfterSaveHookEntry[] {
		return this.orderOwnedHooks(this.afterSaveHooks);
	}

	private getOrderedWorkspaceOpenedHooks(): WorkspaceOpenedHookEntry[] {
		return this.orderOwnedHooks(this.workspaceOpenedHooks);
	}

	/**
	 * Orders hook entries deterministically via the shared registry owner
	 * order (ADR 0012). Shared by save hooks and workspace-lifecycle hooks
	 * (#202).
	 */
	private orderOwnedHooks<T extends { pluginId: string }>(hooks: T[]): T[] {
		const byOwner = new SvelteMap<string, T[]>();
		for (const hook of hooks) {
			const list = byOwner.get(hook.pluginId);
			if (list) {
				list.push(hook);
			} else {
				byOwner.set(hook.pluginId, [hook]);
			}
		}

		const orderedOwners = this.orderedRegistryOwners(
			Array.from(byOwner.keys()),
			(id) => id === CORE_HOOKS_OWNER || id.startsWith('core:')
		);
		return orderedOwners.flatMap((id) => byOwner.get(id)!);
	}

	// --------------------------------------------------------------------------
	// Generic workspace-lifecycle hooks (#202, ADR 0013 extension)
	// --------------------------------------------------------------------------

	/**
	 * Registers a workspace-opened hook. The workspace awaits registered
	 * hooks after the root is set and permission granted, before it
	 * proceeds (tree scan, session restore), so feature plugins can own
	 * per-workspace resources with no hardwired core path.
	 */
	registerWorkspaceOpenedHook(pluginId: string, hook: WorkspaceOpenedHook): () => void {
		this.assertRegistrationOwner(pluginId, 'Workspace-opened hook');
		const entry: WorkspaceOpenedHookEntry = { pluginId, hook };
		this.workspaceOpenedHooks.push(entry);
		return () => {
			const idx = this.workspaceOpenedHooks.indexOf(entry);
			if (idx !== -1) {
				this.workspaceOpenedHooks.splice(idx, 1);
			}
		};
	}

	removePluginWorkspaceHooks(pluginId: string): void {
		this.workspaceOpenedHooks = this.workspaceOpenedHooks.filter((e) => e.pluginId !== pluginId);
	}

	/**
	 * Runs workspace-opened hooks sequentially in activation order and
	 * awaits each. Per ADR 0013 a throwing hook is contained, logged
	 * against its plugin, and never an implicit veto: remaining hooks
	 * still run and folder open proceeds (tree scan, session restore).
	 * Hooks of inactive plugins are skipped.
	 *
	 * Explicit repository decision: the workspace clears its slot BEFORE
	 * running these hooks, so when the owning hook fails the slot stays
	 * in the safe empty state (null) rather than showing stale
	 * branch/changes for the new folder. The host never clears or
	 * republishes the slot itself; whatever a hook managed to publish
	 * before failing is left for its owner's disposal path. Failures are
	 * recorded on `lastHookError` and logged with plugin attribution plus
	 * an action, so the message is sufficient to prompt an AI fix.
	 */
	async runWorkspaceOpened(context: WorkspaceOpenedContext): Promise<void> {
		for (const entry of this.getOrderedWorkspaceOpenedHooks()) {
			try {
				await entry.hook(context);
			} catch (error) {
				this.lastHookError = { pluginId: entry.pluginId, error };
				console.error(
					`[PluginHost] Error in workspaceOpened hook for plugin "${entry.pluginId}" during folder open:`,
					error,
					`\nAction: Inspect the "${entry.pluginId}" plugin's workspace-opened hook; folder open proceeded without its contribution.`
				);
			}
		}
	}

	// --------------------------------------------------------------------------
	// Generic application-service sharing (#202, ADR 0008)
	// --------------------------------------------------------------------------

	/**
	 * Publishes an opaque application service under a well-known key (see
	 * './services'). Last write wins; the host never inspects values.
	 */
	provideService(key: string, service: unknown): void {
		this.services.set(key, service);
	}

	/**
	 * Resolves a published service, or undefined when absent. Plugins
	 * resolve lazily (at action time, not setup time) so activation order
	 * relative to app construction does not matter.
	 */
	getService<T = unknown>(key: string): T | undefined {
		return this.services.get(key) as T | undefined;
	}

	// ------------------------------------------------------------------------
	// Additive UI Contributions (ADR 0010, ADR 0015)
	// ------------------------------------------------------------------------

	registerSidebarPanel(pluginId: string, panel: SidebarPanelContribution): void {
		this.registerSidebarPanels(pluginId, [panel]);
	}

	registerSidebarPanels(pluginId: string, panels: readonly SidebarPanelContribution[]): void {
		const entry = {
			pluginId,
			transform: createAddSidebarPanelsTransform(panels, pluginId)
		};
		const nextTransforms = [...this.sidebarPanelTransforms, entry];
		const nextPanelMap = rebuildSidebarPanels(this.orderTransformsByOwner(nextTransforms));
		const nextStatusMap = rebuildStatusBarItems(this.orderedStatusBarItemTransforms());
		this.sidebarPanelTransforms = nextTransforms;
		this.sidebarPanelsMap = nextPanelMap;
		this.statusBarItemsMap = nextStatusMap;
	}

	removePluginSidebarPanels(pluginId: string): void {
		const kept = this.sidebarPanelTransforms.filter((entry) => entry.pluginId !== pluginId);
		if (kept.length !== this.sidebarPanelTransforms.length) {
			this.sidebarPanelTransforms = kept;
			this.rebuildUIContributions();
		}
	}

	getSidebarPanel(id: string): SidebarPanelContribution | undefined {
		return this.sidebarPanelsMap.get(id);
	}

	getSidebarPanels(): SidebarPanelContribution[] {
		return Array.from(this.sidebarPanelsMap.values()).sort(compareSidebarPanels);
	}

	registerStatusBarItem(pluginId: string, item: StatusBarItemContribution): void {
		this.registerStatusBarItems(pluginId, [item]);
	}

	registerStatusBarItems(pluginId: string, items: readonly StatusBarItemContribution[]): void {
		const entry = {
			pluginId,
			transform: createAddStatusBarItemsTransform(items, pluginId)
		};
		const nextTransforms = [...this.statusBarItemTransforms, entry];
		const nextStatusMap = rebuildStatusBarItems(this.orderTransformsByOwner(nextTransforms));
		const nextPanelMap = rebuildSidebarPanels(this.orderedSidebarPanelTransforms());
		this.statusBarItemTransforms = nextTransforms;
		this.statusBarItemsMap = nextStatusMap;
		this.sidebarPanelsMap = nextPanelMap;
	}

	removePluginStatusBarItems(pluginId: string): void {
		const kept = this.statusBarItemTransforms.filter((entry) => entry.pluginId !== pluginId);
		if (kept.length !== this.statusBarItemTransforms.length) {
			this.statusBarItemTransforms = kept;
			this.rebuildUIContributions();
		}
	}

	getStatusBarItem(id: string): StatusBarItemContribution | undefined {
		return this.statusBarItemsMap.get(id);
	}

	getStatusBarItems(alignment?: StatusBarAlignment): StatusBarItemContribution[] {
		const items = Array.from(this.statusBarItemsMap.values());
		const filtered = alignment ? items.filter((i) => i.alignment === alignment) : items;
		return filtered.sort(compareStatusBarItems);
	}

	registerTabContent(pluginId: string, content: TabContentContribution): void {
		this.registerTabContents(pluginId, [content]);
	}

	registerTabContents(pluginId: string, contents: readonly TabContentContribution[]): void {
		const entry = {
			pluginId,
			transform: createAddTabContentsTransform(contents, pluginId)
		};
		const nextTransforms = [...this.tabContentTransforms, entry];
		const nextTabContentMap = rebuildTabContents(this.orderedTabContentTransforms(nextTransforms));
		this.tabContentTransforms = nextTransforms;
		this.tabContentsMap = nextTabContentMap;
	}

	removePluginTabContents(pluginId: string): void {
		const kept = this.tabContentTransforms.filter((entry) => entry.pluginId !== pluginId);
		if (kept.length !== this.tabContentTransforms.length) {
			this.tabContentTransforms = kept;
			this.rebuildUIContributions();
		}
	}

	getTabContent(id: string): TabContentContribution | undefined {
		const direct = this.tabContentsMap.get(id);
		if (direct) return direct;
		return this.getTabContents().find((content) => content.pluginId === id);
	}

	getTabContents(): TabContentContribution[] {
		return Array.from(this.tabContentsMap.values()).sort(compareTabContents);
	}

	removePluginUIContributions(pluginId: string): void {
		this.unmountAllPluginContributions(pluginId);
		const keptPanels = this.sidebarPanelTransforms.filter((entry) => entry.pluginId !== pluginId);
		const keptStatus = this.statusBarItemTransforms.filter((entry) => entry.pluginId !== pluginId);
		const keptTabs = this.tabContentTransforms.filter((entry) => entry.pluginId !== pluginId);
		const panelsChanged = keptPanels.length !== this.sidebarPanelTransforms.length;
		const statusChanged = keptStatus.length !== this.statusBarItemTransforms.length;
		const tabsChanged = keptTabs.length !== this.tabContentTransforms.length;
		if (panelsChanged || statusChanged || tabsChanged) {
			this.sidebarPanelTransforms = keptPanels;
			this.statusBarItemTransforms = keptStatus;
			this.tabContentTransforms = keptTabs;
			this.rebuildUIContributions();
		}
	}

	rebuildUIContributions(): void {
		const nextPanelMap = rebuildSidebarPanels(this.orderedSidebarPanelTransforms());
		const nextStatusMap = rebuildStatusBarItems(this.orderedStatusBarItemTransforms());
		const nextTabContentMap = rebuildTabContents(this.orderedTabContentTransforms());
		this.sidebarPanelsMap = nextPanelMap;
		this.statusBarItemsMap = nextStatusMap;
		this.tabContentsMap = nextTabContentMap;
	}

	private orderedSidebarPanelTransforms(): SidebarPanelTransformEntry[] {
		return this.orderTransformsByOwner(this.sidebarPanelTransforms);
	}

	private orderedStatusBarItemTransforms(): StatusBarItemTransformEntry[] {
		return this.orderTransformsByOwner(this.statusBarItemTransforms);
	}

	private orderedTabContentTransforms(
		transforms: TabContentTransformEntry[] = this.tabContentTransforms
	): TabContentTransformEntry[] {
		return this.orderTransformsByOwner(transforms);
	}

	private orderTransformsByOwner<T extends { pluginId: string }>(transforms: T[]): T[] {
		const byOwner = new SvelteMap<string, T[]>();
		for (const entry of transforms) {
			const list = byOwner.get(entry.pluginId);
			if (list) {
				list.push(entry);
			} else {
				byOwner.set(entry.pluginId, [entry]);
			}
		}

		const orderedOwners = this.orderedRegistryOwners(
			Array.from(byOwner.keys()),
			(id) => id === CORE_UI_OWNER
		);
		return orderedOwners.flatMap((id) => byOwner.get(id)!);
	}

	mountContribution(
		pluginId: string,
		contributionId: string,
		target: UIContributionTarget,
		props?: UIContributionProps
	): MountedContribution {
		const panel = this.sidebarPanelsMap.get(contributionId);
		const statusItem = this.statusBarItemsMap.get(contributionId);
		const tabContent = this.tabContentsMap.get(contributionId) ?? this.getTabContent(contributionId);
		const contribution = panel ?? statusItem ?? tabContent;

		if (!contribution) {
			throw new Error(`UI contribution "${contributionId}" not found in registry.`);
		}
		if (contribution.pluginId !== pluginId) {
			throw new Error(
				`UI contribution "${contributionId}" belongs to "${contribution.pluginId}", not "${pluginId}".`
			);
		}

		const kind: 'sidebar-panel' | 'status-bar-item' | 'tab-content' = panel
			? 'sidebar-panel'
			: statusItem
				? 'status-bar-item'
				: 'tab-content';
		const mergedProps = { ...(contribution.props ?? {}), ...(props ?? {}) };
		const mountable = contribution.component as unknown as {
			mount?: (target: UIContributionTarget, props: UIContributionProps) => UIContributionInstance;
		};
		let instance: UIContributionInstance = {
			component: contribution.component,
			target,
			props: mergedProps
		};

		if (typeof contribution.component === 'function') {
			try {
				const render = contribution.component as unknown as (
					target: UIContributionTarget,
					props: UIContributionProps
				) => UIContributionInstance;
				instance = render(target, mergedProps);
			} catch (err) {
				instance = { component: contribution.component, target, props: mergedProps, error: err };
			}
		} else if (typeof mountable === 'object' && typeof mountable.mount === 'function') {
			instance = mountable.mount(target, mergedProps);
		}

		const instanceId = `inst-${this.nextMountedInstanceId++}`;
		const mounted: MountedContribution = {
			instanceId,
			contributionId,
			pluginId,
			kind,
			target,
			instance,
			props: mergedProps,
			update: (newProps: UIContributionProps) => {
				Object.assign(mounted.props, newProps);
				if (instance && typeof instance.update === 'function') {
					instance.update(newProps);
				}
			},
			unmount: () => {
				this.unmountContribution(instanceId);
			}
		};

		this.mountedContributions.set(instanceId, mounted);
		return mounted;
	}

	unmountContribution(instanceId: string): void {
		const mounted = this.mountedContributions.get(instanceId);
		if (!mounted) return;

		this.mountedContributions.delete(instanceId);
		if (mounted.instance) {
			if (typeof mounted.instance.unmount === 'function') {
				mounted.instance.unmount();
			} else if (typeof mounted.instance.destroy === 'function') {
				mounted.instance.destroy();
			} else if (typeof mounted.instance.$destroy === 'function') {
				mounted.instance.$destroy();
			}
		}
	}

	unmountAllPluginContributions(pluginId: string): void {
		for (const [id, mounted] of Array.from(this.mountedContributions.entries())) {
			if (mounted.pluginId === pluginId) {
				this.unmountContribution(id);
			}
		}
	}

	getMountedContributions(pluginId?: string): MountedContribution[] {
		const all = Array.from(this.mountedContributions.values());
		return pluginId ? all.filter((m) => m.pluginId === pluginId) : all;
	}


	// --------------------------------------------------------------------------
	// Settings Registry Methods (ADR 0012, ADR 0014)
	// --------------------------------------------------------------------------

	registerSettingTransform(pluginId: string, transform: SettingSchemaTransform): void {
		this.settingSchemaTransforms.push({ pluginId, transform });
		this.rebuildSettings();
	}

	registerSettingSchema(pluginId: string, schema: SettingNamespaceSchema): void {
		this.registerSettingTransform(pluginId, createAddSettingSchemaTransform(schema));
	}

	removePluginSettings(pluginId: string): void {
		const kept = this.settingSchemaTransforms.filter((entry) => entry.pluginId !== pluginId);
		if (kept.length !== this.settingSchemaTransforms.length) {
			this.settingSchemaTransforms = kept;
			this.rebuildSettings();
		}
	}

	rebuildSettings(): void {
		this.settingSchemaMap = rebuildSettingSchemas(this.orderedSettingTransforms());
		for (const listener of this.settingsListeners) listener();
	}

	refreshSettings(): void {
		this.rebuildSettings();
	}

	getSettingSchema(namespace: string): SettingNamespaceSchema | undefined {
		return this.settingSchemaMap.get(namespace);
	}

	getSettingSchemas(): SettingNamespaceSchema[] {
		return Array.from(this.settingSchemaMap.values());
	}

	private orderedSettingTransforms(): SettingSchemaTransformEntry[] {
		const byOwner = new SvelteMap<string, SettingSchemaTransformEntry[]>();
		for (const entry of this.settingSchemaTransforms) {
			const list = byOwner.get(entry.pluginId);
			if (list) {
				list.push(entry);
			} else {
				byOwner.set(entry.pluginId, [entry]);
			}
		}

		const orderedOwners = this.orderedRegistryOwners(
			Array.from(byOwner.keys()),
			(id) => id === CORE_SETTINGS_OWNER
		);
		return orderedOwners.flatMap((id) => byOwner.get(id)!);
	}

	// --------------------------------------------------------------------------
	// Topological Sort & Lifecycle
	// --------------------------------------------------------------------------

	/**
	 * Computes deterministic activation order using topological sort.
	 * Detects cycles and interface requirements.
	 */
	computeActivationOrder(pluginIds?: string[]): string[] {
		const targetIds = pluginIds
			? Array.from(new SvelteSet(pluginIds))
			: Array.from(this.registrations.keys());

		// Verify existence
		for (const id of targetIds) {
			if (!this.registrations.has(id)) {
				throw new PluginNotFoundError(id);
			}
		}

		// Map interface name to providing plugin ID
		const interfaceProviders = new SvelteMap<string, { pluginId: string; version: number }>();
		for (const [id, reg] of this.registrations.entries()) {
			if (reg.manifest.provides) {
				for (const [iface, ver] of Object.entries(reg.manifest.provides)) {
					const existing = interfaceProviders.get(iface);
					if (existing !== undefined && existing.pluginId !== id) {
						throw new DuplicateInterfaceProviderError(iface, existing.pluginId, id);
					}
					interfaceProviders.set(iface, { pluginId: id, version: ver });
				}
			}
		}

		// Build dependency adjacency list: id -> list of plugin IDs it depends on
		const adj = new SvelteMap<string, Set<string>>();
		const visitedForGraph = new SvelteSet<string>();

		const collectDeps = (id: string, path: string[]) => {
			if (visitedForGraph.has(id)) return;
			visitedForGraph.add(id);

			const reg = this.registrations.get(id);
			if (!reg) return;

			const deps = new SvelteSet<string>();
			adj.set(id, deps);

			if (reg.manifest.dependsOn) {
				for (const [depName, requiredVersion] of Object.entries(reg.manifest.dependsOn)) {
					let targetPluginId: string | undefined;

					// Direct plugin ID dependency
					if (this.registrations.has(depName)) {
						targetPluginId = depName;
						const targetManifest = this.registrations.get(depName)!.manifest;
						if (targetManifest.version !== requiredVersion) {
							throw new InterfaceVersionMismatchError(
								depName,
								id,
								requiredVersion,
								targetPluginId,
								targetManifest.version
							);
						}
					}
					// Interface provider dependency
					else if (interfaceProviders.has(depName)) {
						const provider = interfaceProviders.get(depName)!;
						targetPluginId = provider.pluginId;
						if (provider.version !== requiredVersion) {
							throw new InterfaceVersionMismatchError(
								depName,
								id,
								requiredVersion,
								provider.pluginId,
								provider.version
							);
						}
					} else {
						throw new MissingDependencyError(id, depName, requiredVersion);
					}

					if (targetPluginId) {
						deps.add(targetPluginId);
						collectDeps(targetPluginId, [...path, id]);
					}
				}
			}
		};

		for (const id of targetIds) {
			collectDeps(id, []);
		}

		// Kahn's algorithm for topological sorting
		const inDegree = new SvelteMap<string, number>();
		const reverseAdj = new SvelteMap<string, string[]>(); // dependency -> dependents

		for (const node of visitedForGraph) {
			inDegree.set(node, 0);
			reverseAdj.set(node, []);
		}

		for (const [node, deps] of adj.entries()) {
			inDegree.set(node, deps.size);
			for (const dep of deps) {
				reverseAdj.get(dep)!.push(node);
			}
		}

		// Priority queue (sorted array) of nodes with in-degree 0
		const ready: string[] = [];
		for (const [node, deg] of inDegree.entries()) {
			if (deg === 0) {
				ready.push(node);
			}
		}
		ready.sort(); // Lexicographical deterministic tie-break

		const result: string[] = [];

		while (ready.length > 0) {
			const current = ready.shift()!;
			result.push(current);

			const dependents = reverseAdj.get(current) ?? [];
			// Sort dependents for determinism
			dependents.sort();

			for (const dependent of dependents) {
				const currentDeg = inDegree.get(dependent)! - 1;
				inDegree.set(dependent, currentDeg);
				if (currentDeg === 0) {
					ready.push(dependent);
					ready.sort();
				}
			}
		}

		if (result.length < visitedForGraph.size) {
			// Find cycle participants
			const cycleNodes = Array.from(visitedForGraph).filter((node) => (inDegree.get(node) ?? 0) > 0);
			throw new DependencyCycleError(cycleNodes);
		}

		return result;
	}

	/**
	 * Activates a single plugin and any required dependencies.
	 * Rejected after dispose (ADR 0009: disabling/enabling only while running normally).
	 */
	async activate(id: string): Promise<void> {
		if (this.disposed) {
			throw new Error(`Cannot activate plugin "${id}": host is disposed (shutdown).`);
		}
		if (!this.registrations.has(id)) {
			throw new PluginNotFoundError(id);
		}

		if (this.isPluginActive(id)) {
			return;
		}

		const order = this.computeActivationOrder([id]);
		for (const pluginId of order) {
			if (!this.isPluginActive(pluginId)) {
				await this.executeActivation(pluginId);
			}
		}
	}

	/**
	 * Activates all registered plugins that support current platform.
	 * Rejected after dispose (ADR 0009 shutdown).
	 */
	async activateAll(): Promise<void> {
		if (this.disposed) {
			throw new Error('Cannot activate plugins: host is disposed (shutdown).');
		}		const order = this.computeActivationOrder();
		for (const id of order) {
			const manifest = this.getManifest(id);
			if (manifest && (!manifest.platforms || manifest.platforms.includes(this.platform))) {
				if (!this.isPluginActive(id)) {
					await this.executeActivation(id);
				}
			}
		}
	}

	private async executeActivation(id: string): Promise<void> {
		const registration = this.registrations.get(id);
		if (!registration) {
			throw new PluginNotFoundError(id);
		}

		const manifest = registration.manifest;

		// Platform gating check
		if (manifest.platforms && !manifest.platforms.includes(this.platform)) {
			throw new UnsupportedPlatformError(id, this.platform, manifest.platforms);
		}

		this.states.set(id, 'activating');

		try {
			// Resolve setup function: synchronous setup or lazy load (ADR 0011)
			let setupFn = registration.setup;

			if (!setupFn && registration.load) {
				const loadedModule: any = await registration.load();
				if (typeof loadedModule.setup === 'function') {
					setupFn = loadedModule.setup;
				} else if (loadedModule.default && typeof loadedModule.default.setup === 'function') {
					setupFn = loadedModule.default.setup;
				} else if (typeof loadedModule.default === 'function') {
					setupFn = loadedModule.default;
				}
			}

			if (setupFn) {
				const cleanupResult: unknown = await setupFn(this.pluginInterface);
				if (typeof cleanupResult === 'function') {
					this.cleanups.set(id, cleanupResult as PluginCleanup);
				} else if (
					cleanupResult &&
					typeof cleanupResult === 'object' &&
					'dispose' in cleanupResult &&
					typeof (cleanupResult as { dispose: unknown }).dispose === 'function'
				) {
					this.cleanups.set(id, () => (cleanupResult as { dispose: () => void }).dispose());
				}
			}

			this.states.set(id, 'active');
			this.deactivationReasons.delete(id);
			if (!this.activationOrder.includes(id)) {
				this.activationOrder.push(id);
			}
			// Setup ran while this plugin was 'activating', so its transforms
			// were excluded from intermediate rebuilds. Rebuild now that it
			// is active to materialize its contributions in order.
			this.rebuildCommands();
			this.rebuildSettings();
			this.rebuildUIContributions();
			this.rebuildEditorContributions();
		} catch (error) {
			this.states.set(id, 'error');
			this.removePluginCommands(id);
			this.removePluginHooks(id);
			this.removePluginWorkspaceHooks(id);
			this.removePluginEvents(id);
			this.removePluginSettings(id);
			this.removePluginUIContributions(id);
			this.removePluginEditorContributions(id);
			this.removePluginKeymaps(id);
			this.removePluginIcons(id);
			const cleanup = this.cleanups.get(id);
			if (cleanup) {
				try {
					await this.runPluginCleanup(id, cleanup, 'activation rollback');
				} finally {
					this.cleanups.delete(id);
				}
			}
			throw new PluginActivationError(id, error);
		}
	}

	/**
	 * Deactivates a plugin. Unloads active dependents first (ADR 0017 cascade).
	 * Runs cleanup on disable.
	 */
	async deactivate(id: string, reason = 'Disabled'): Promise<void> {
		if (!this.registrations.has(id)) {
			throw new PluginNotFoundError(id);
		}

		if (!this.isPluginActive(id)) {
			return;
		}

		if (this.disposed) {
			throw new Error(`Cannot deactivate plugin "${id}": host is disposed (shutdown).`);
		}

		// Cascade: unload active dependents first (ADR 0017). Each recursive
		// call handles its own transitive dependents, so already-unloaded
		// plugins are skipped.
		const manifest = this.getManifest(id)!;
		const dependentIds = this.getActiveDependents(id);
		this.states.set(id, 'deactivating');

		for (const dependentId of dependentIds) {
			if (!this.isPluginActive(dependentId)) continue;
			const dependentManifest = this.getManifest(dependentId)!;
			await this.deactivate(
				dependentId,
				`${dependentManifest.name} is off because ${manifest.name} is off.`
			);
		}

		await this.waitForPluginOperations(id);

		this.removePluginCommands(id);
		this.removePluginHooks(id);
		this.removePluginWorkspaceHooks(id);
		this.removePluginEvents(id);
		this.removePluginSettings(id);
		this.removePluginUIContributions(id);
		this.removePluginEditorContributions(id);
		this.removePluginKeymaps(id);
		this.removePluginIcons(id);

		// Execute cleanup if present
		const cleanup = this.cleanups.get(id);
		if (cleanup) {
			try {
				await this.runPluginCleanup(id, cleanup, 'disablement');
			} finally {
				this.cleanups.delete(id);
			}
		}

		this.states.set(id, 'inactive');
		this.deactivationReasons.set(id, reason);
		this.activationOrder = this.activationOrder.filter((item) => item !== id);
	}

	// -------------------------------------------------------------------------
	// Editor contribution & mediated contract (ADR 0016)
	// -------------------------------------------------------------------------

	/**
	 * Direct view access from plugin code is strictly rejected (ADR 0016).
	 */
	get view(): never {
		throw new DirectEditorViewAccessError("host.view");
	}

	get editorView(): never {
		throw new DirectEditorViewAccessError("host.editorView");
	}

	getActiveEditorView(): never {
		throw new DirectEditorViewAccessError("host.getActiveEditorView()");
	}

	/**
	 * Direct raw transaction dispatch is strictly rejected (ADR 0016).
	 */
	dispatch(): never {
		throw new RawTransactionDispatchError(
			"Direct dispatch on PluginHost is rejected. Use host.applyDocumentEdit() instead."
		);
	}

	dispatchTransaction(): never {
		throw new RawTransactionDispatchError(
			"Direct dispatchTransaction on PluginHost is rejected. Use host.applyDocumentEdit() instead."
		);
	}

	registerEditorContribution(pluginId: string, contribution: EditorContribution): void {
		this.registerEditorContributions(pluginId, [contribution]);
	}

	registerEditorContributionTransform(pluginId: string, transform: EditorContributionTransform): void {
		const nextTransforms = [...this.editorContributionTransforms, { pluginId, transform }];
		const nextContributions = rebuildEditorContributions(this.orderTransformsByOwner(nextTransforms));
		this.editorContributionTransforms = nextTransforms;
		this.editorContributions = nextContributions;
		this.editorRevision++;
	}

	registerEditorContributions(pluginId: string, contributions: readonly EditorContribution[]): void {
		this.registerEditorContributionTransform(
			pluginId,
			createAddEditorContributionsTransform(contributions, pluginId)
		);
	}

	removePluginEditorContributions(pluginId: string): void {
		const kept = this.editorContributionTransforms.filter((entry) => entry.pluginId !== pluginId);
		if (kept.length === this.editorContributionTransforms.length) return;
		const nextContributions = rebuildEditorContributions(this.orderTransformsByOwner(kept));
		this.editorContributionTransforms = kept;
		this.editorContributions = nextContributions;
		this.editorRevision++;
	}

	rebuildEditorContributions(): void {
		this.editorContributions = rebuildEditorContributions(
			this.orderTransformsByOwner(this.editorContributionTransforms)
		);
		this.editorRevision++;
	}

	getEditorContributions(type?: EditorContributionType): readonly EditorContributionEntry[] {
		if (!type) return [...this.editorContributions];
		return this.editorContributions.filter((e) => e.contribution.type === type);
	}

	attachKeymapRegistryInternal(registry: KeymapRegistry): void {
		this.attachedKeymapRegistry = registry;
	}

	attachIconRegistryInternal(registry: IconRegistryInterface): void {
		this.attachedIconRegistry = registry;
	}

	/**
	 * Internal host shell hook to resolve a document id to the session the app
	 * has open, so a plugin can address a document by the id it read from a
	 * tab instead of being handed a session. Attached by the app composer,
	 * which owns both the host and the workspace. NEVER exposed to plugin
	 * manifests or public plugin APIs (ADR 0016).
	 */
	attachDocumentResolverInternal(resolve: (docId: string) => DocumentSession | undefined): void {
		this.documentResolver = resolve;
	}

	/**
	 * Internal host shell hook to bind an active editor view to a document session.
	 * NEVER exposed to plugin manifests or public plugin APIs.
	 */
	attachEditorInternal(docId: string, editor: AttachedEditor, language?: string): void {
		this.attachedEditors.set(docId, editor);
	}

	detachEditorInternal(docId: string): void {
		this.attachedEditors.delete(docId);
	}

	getAttachedEditorInternal(docId: string): AttachedEditor | undefined {
		return this.attachedEditors.get(docId);
	}

	registerDocumentSession(doc: DocumentSession): void {
		this.documentSessions.set(doc.id, doc);
	}

	unregisterDocumentSession(docId: string): void {
		this.documentSessions.delete(docId);
	}

	getDocumentSession(docId: string): DocumentSession | undefined {
		return this.documentSessions.get(docId);
	}

	/**
	 * Document text changes go through a host operation applied as one
	 * undo transaction with revision checks (ADR 0016).
	 */
	applyDocumentEdit(options: ApplyDocumentEditOptions): DocumentEditResult {
		let targetDoc = options.doc;
		if (!targetDoc && options.documentId) {
			// An explicitly registered session wins; otherwise resolve the id
			// against the documents the app currently has open.
			targetDoc =
				this.documentSessions.get(options.documentId) ??
				this.documentResolver?.(options.documentId);
		}
		if (!targetDoc) {
			throw new Error("Target document must be specified in ApplyDocumentEditOptions (doc or documentId).");
		}
		const attached = this.attachedEditors.get(targetDoc.id);
		return applyDocumentEditOperation(options, targetDoc, attached);
	}

	/**
	 * Disposes all active plugins in reverse activation order (ADR 0009 shutdown).
	 * Sets shutdown state so later activation is rejected.
	 */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		const reverseOrder = [...this.activationOrder].reverse();
		for (const id of reverseOrder) {
			await this.deactivate(id, 'Host disposed');
		}
		this.disposed = true;
	}
}
