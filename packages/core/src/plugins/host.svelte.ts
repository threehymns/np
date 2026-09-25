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
	DuplicateEditorContributionIdError,
	DependencyCycleError,
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
import { SvelteMap } from 'svelte/reactivity';
import {
	createEditorContributionCompartments,
	applyDocumentEditOperation,
	type EditorContribution,
	type EditorContributionEntry,
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
	rebuildSidebarPanels,
	rebuildStatusBarItems,
	compareSidebarPanels,
	compareStatusBarItems,
	type SidebarPanelContribution,
	type StatusBarItemContribution,
	type StatusBarAlignment,
	type SidebarPanelTransformEntry,
	type StatusBarItemTransformEntry,
	type MountedContribution,
	type UIContributionRegistryLike
} from './ui-contributions';

interface AsyncLocalStorageLike<T> {
	run<R>(store: T, fn: () => R): R;
	getStore(): T | undefined;
}

const AsyncLocalStorageClass: (new <T>() => AsyncLocalStorageLike<T>) | undefined =
	(globalThis as any).AsyncLocalStorage ??
	(typeof process !== 'undefined' && typeof (process as any).getBuiltinModule === 'function'
		? (process as any).getBuiltinModule('node:async_hooks')?.AsyncLocalStorage
		: undefined);

const saveHookStorage: AsyncLocalStorageLike<ActiveHookContext> | undefined =
	AsyncLocalStorageClass ? new AsyncLocalStorageClass<ActiveHookContext>() : undefined;

export class PluginHost implements PluginHostInterface {
	readonly hostVersion = 0;
	readonly platform: PluginPlatform;

	// Internal state tracking
	private registrations = new Map<string, PluginRegistration>();
	// SvelteMap so UI derived state (e.g. SettingsModal plugin rows)
	// recomputes after activate/deactivate; a $state-wrapped plain Map does
	// not track .set/.delete mutations.
	private states = new SvelteMap<string, PluginState>();
	private deactivationReasons = new SvelteMap<string, string>();
	private cleanups = new Map<string, PluginCleanup>();
	private activationOrder = $state<string[]>([]);

	// Shared command registry: replayable transforms + materialized view.
	// Plugins contribute via registerCommands/registerCommandTransform during
	// setup; the host replays in order from an empty initial value on every
	// rebuild (ADR 0012). Palette and menus are views over this state.
	private commandTransforms: CommandTransformEntry[] = [];
	private commandMap = $state<Map<string, PluginCommand>>(new Map());
	private commandOwners = new Map<string, string>();
	private activePluginOperations = new Map<string, Set<Promise<unknown>>>();

	// Event handlers (ADR 0013: events observe, fire-and-forget)
	private eventHandlers = new Map<string, EventHandlerEntry[]>();

	// Operation hooks (ADR 0013: hooks participate)
	private beforeSaveHooks: BeforeSaveHookEntry[] = [];
	private afterSaveHooks: AfterSaveHookEntry[] = [];
	private activeSaveHook: ActiveHookContext | null = null;
	private readonly operationContext: PluginOperationContext;
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
	private services = new Map<string, unknown>();

	// Editor contribution contract (ADR 0016)
	readonly editorCompartments: EditorCompartments = createEditorContributionCompartments();
	editorRevision = $state(0);
	get editorContributionsRevision(): number {
		return this.editorRevision;
	}
	private editorContributions: EditorContributionEntry[] = [];
	private attachedEditors = new Map<string, AttachedEditor>();
	private documentSessions = new Map<string, DocumentSession>();

	/**
	 * Command registry facade with the same shape as the standalone
	 * CommandRegistry, so `AppState.commands` stays a drop-in view.
	 */
	// Shared settings schema registry: replayable transforms + materialized view (ADR 0012, ADR 0014).
	private settingSchemaTransforms: SettingSchemaTransformEntry[] = [];
	private settingSchemaMap = $state<Map<string, SettingNamespaceSchema>>(new Map());

	readonly settings: SettingsRegistryLike = {
		registerTransform: (pluginId, transform) => this.registerSettingTransform(pluginId, transform),
		registerSchema: (pluginId, schema) => this.registerSettingSchema(pluginId, schema),
		removePlugin: (pluginId) => this.removePluginSettings(pluginId),
		rebuild: () => this.rebuildSettings(),
		refresh: () => this.refreshSettings(),
		getSchema: (namespace) => this.getSettingSchema(namespace),
		getAllSchemas: () => this.getSettingSchemas()
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
	private sidebarPanelsMap = $state<Map<string, SidebarPanelContribution>>(new Map());
	private statusBarItemsMap = $state<Map<string, StatusBarItemContribution>>(new Map());
	private mountedContributions = new Map<string, MountedContribution>();
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
		this.registerSettingSchema(CORE_SETTINGS_OWNER, EDITOR_SCHEMA);
		this.registerSettingSchema(CORE_SETTINGS_OWNER, UI_SCHEMA);
		this.platform = options.platform ?? (typeof window !== 'undefined' && (window as any).electronAPI ? 'desktop' : 'web');
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
		const visited = new Set<string>([id]);
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
		const owners = new Map<string, string>();
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
			operations = new Set();
			this.activePluginOperations.set(pluginId, operations);
		}
		operations.add(operation);
		void operation.then(
			() => this.finishPluginOperation(pluginId, operation),
			() => this.finishPluginOperation(pluginId, operation)
		);
		return operation;
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
	 * Orders transform owners deterministically: built-in core first, then
	 * active plugins in activation order, then any remaining owners
	 * alphabetically. Registered-but-inactive owners are excluded so a
	 * missed disposal can never leak commands.
	 */
	private orderedCommandTransforms(): CommandTransformEntry[] {
		const byOwner = new Map<string, CommandTransformEntry[]>();
		for (const entry of this.commandTransforms) {
			const list = byOwner.get(entry.pluginId);
			if (list) {
				list.push(entry);
			} else {
				byOwner.set(entry.pluginId, [entry]);
			}
		}

		const orderedOwners: string[] = [];
		if (byOwner.has(CORE_COMMANDS_OWNER)) {
			orderedOwners.push(CORE_COMMANDS_OWNER);
		}
		for (const id of this.activationOrder) {
			if (byOwner.has(id) && !orderedOwners.includes(id)) {
				orderedOwners.push(id);
			}
		}
		for (const id of [...byOwner.keys()].sort()) {
			if (!orderedOwners.includes(id)) {
				orderedOwners.push(id);
			}
		}

		const included = orderedOwners.filter(
			(id) => id === CORE_COMMANDS_OWNER || !this.registrations.has(id) || this.isPluginActive(id)
		);
		return included.flatMap((id) => byOwner.get(id)!);
	}

	// --------------------------------------------------------------------------
	// Event Observation Methods (ADR 0013: Events observe, fire-and-forget)
	// --------------------------------------------------------------------------

	/**
	 * Subscribes an event handler for observation.
	 * Handlers cannot mutate payload outcome, veto, or fail host operations.
	 */
	on<T = any>(event: string, handler: EventHandler<T>, pluginId?: string): () => void {
		let list = this.eventHandlers.get(event);
		if (!list) {
			list = [];
			this.eventHandlers.set(event, list);
		}
		const entry: EventHandlerEntry<T> = { pluginId, handler };
		list.push(entry);
		return () => {
			this.off(event, handler);
		};
	}

	off<T = any>(event: string, handler: EventHandler<T>): void {
		const list = this.eventHandlers.get(event);
		if (!list) return;
		const index = list.findIndex((e) => e.handler === handler);
		if (index !== -1) {
			list.splice(index, 1);
		}
		if (list.length === 0) {
			this.eventHandlers.delete(event);
		}
	}

	emit<T = any>(event: string, payload?: T): void {
		const list = this.eventHandlers.get(event);
		if (!list || list.length === 0) return;

		for (const entry of [...list]) {
			try {
				const result = entry.handler(payload);
				if (result && typeof (result as Promise<any>).catch === 'function') {
					(result as Promise<any>).catch((err) => {
						console.error(
							`[PluginHost] Error in async event handler for "${event}"${entry.pluginId ? ` (plugin "${entry.pluginId}")` : ''}:`,
							err
						);
					});
				}
			} catch (err) {
				console.error(
					`[PluginHost] Error in event handler for "${event}"${entry.pluginId ? ` (plugin "${entry.pluginId}")` : ''}:`,
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
		this.checkSaveReentry('saveDocument', 'beforeSave hook');
		const prev = this.saveQueue;
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.saveQueue = prev.then(() => current);
		await prev;
		const prevSaveId = this.currentSaveId;
		this.currentSaveId = ++this.nextSaveId;
		try {
			return await fn();
		} finally {
			this.currentSaveId = prevSaveId;
			release();
		}
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
		try {
			return await this.operationContext.run(context, async () => await invoke());
		} finally {
			this.activeSaveHook = null;
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
					() => entry.hook(context)
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
					() => entry.hook(context)
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
	 * Orders hook entries deterministically: built-in core owners first,
	 * then registered active plugins in activation order, then
	 * non-registered owners alphabetically. Registered-but-inactive owners
	 * are excluded so a missed disposal can never leak hook behavior.
	 * Shared by save hooks and workspace-lifecycle hooks (#202).
	 */
	private orderOwnedHooks<T extends { pluginId: string }>(hooks: T[]): T[] {
		const byOwner = new Map<string, T[]>();
		for (const hook of hooks) {
			const list = byOwner.get(hook.pluginId);
			if (list) {
				list.push(hook);
			} else {
				byOwner.set(hook.pluginId, [hook]);
			}
		}

		const orderedOwners: string[] = [];

		// Core / built-in hooks first
		for (const id of Array.from(byOwner.keys()).sort()) {
			if (id === CORE_HOOKS_OWNER || id.startsWith('core:')) {
				if (!orderedOwners.includes(id)) {
					orderedOwners.push(id);
				}
			}
		}

		// Registered active plugins in activation order
		const registeredActiveIds = Array.from(byOwner.keys()).filter(
			(id) => this.registrations.has(id) && this.isPluginActive(id)
		);

		let sortedRegisteredIds: string[] = [];
		if (registeredActiveIds.length > 0) {
			try {
				sortedRegisteredIds = this.computeActivationOrder(registeredActiveIds);
			} catch {
				sortedRegisteredIds = this.activationOrder.filter((id) => registeredActiveIds.includes(id));
			}
		}

		for (const id of sortedRegisteredIds) {
			if (byOwner.has(id) && !orderedOwners.includes(id)) {
				orderedOwners.push(id);
			}
		}

		// Non-registered owners in alphabetical order
		for (const id of Array.from(byOwner.keys()).sort()) {
			if (!orderedOwners.includes(id) && !this.registrations.has(id)) {
				orderedOwners.push(id);
			}
		}

		const included = orderedOwners.filter(
			(id) =>
				id === CORE_HOOKS_OWNER ||
				id.startsWith('core:') ||
				!this.registrations.has(id) ||
				this.isPluginActive(id)
		);

		return included.flatMap((id) => byOwner.get(id)!);
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

	removePluginUIContributions(pluginId: string): void {
		this.unmountAllPluginContributions(pluginId);
		const keptPanels = this.sidebarPanelTransforms.filter((entry) => entry.pluginId !== pluginId);
		const keptStatus = this.statusBarItemTransforms.filter((entry) => entry.pluginId !== pluginId);
		const panelsChanged = keptPanels.length !== this.sidebarPanelTransforms.length;
		const statusChanged = keptStatus.length !== this.statusBarItemTransforms.length;
		if (panelsChanged || statusChanged) {
			this.sidebarPanelTransforms = keptPanels;
			this.statusBarItemTransforms = keptStatus;
			this.rebuildUIContributions();
		}
	}

	rebuildUIContributions(): void {
		const nextPanelMap = rebuildSidebarPanels(this.orderedSidebarPanelTransforms());
		const nextStatusMap = rebuildStatusBarItems(this.orderedStatusBarItemTransforms());
		this.sidebarPanelsMap = nextPanelMap;
		this.statusBarItemsMap = nextStatusMap;
	}

	private orderedSidebarPanelTransforms(): SidebarPanelTransformEntry[] {
		return this.orderTransformsByOwner(this.sidebarPanelTransforms);
	}

	private orderedStatusBarItemTransforms(): StatusBarItemTransformEntry[] {
		return this.orderTransformsByOwner(this.statusBarItemTransforms);
	}

	private orderTransformsByOwner<T extends { pluginId: string }>(transforms: T[]): T[] {
		const byOwner = new Map<string, T[]>();
		for (const entry of transforms) {
			const list = byOwner.get(entry.pluginId);
			if (list) {
				list.push(entry);
			} else {
				byOwner.set(entry.pluginId, [entry]);
			}
		}

		const orderedOwners: string[] = [];
		if (byOwner.has(CORE_UI_OWNER)) {
			orderedOwners.push(CORE_UI_OWNER);
		}
		for (const id of this.activationOrder) {
			if (byOwner.has(id) && !orderedOwners.includes(id)) {
				orderedOwners.push(id);
			}
		}
		for (const id of [...byOwner.keys()].sort()) {
			if (!orderedOwners.includes(id)) {
				orderedOwners.push(id);
			}
		}

		const included = orderedOwners.filter(
			(id) => id === CORE_UI_OWNER || !this.registrations.has(id) || this.isPluginActive(id)
		);
		return included.flatMap((id) => byOwner.get(id)!);
	}

	mountContribution(
		pluginId: string,
		contributionId: string,
		target: any,
		props?: Record<string, any>
	): MountedContribution {
		const panel = this.sidebarPanelsMap.get(contributionId);
		const statusItem = this.statusBarItemsMap.get(contributionId);
		const contribution = panel ?? statusItem;

		if (!contribution) {
			throw new Error(`UI contribution "${contributionId}" not found in registry.`);
		}
		if (contribution.pluginId !== pluginId) {
			throw new Error(
				`UI contribution "${contributionId}" belongs to "${contribution.pluginId}", not "${pluginId}".`
			);
		}

		const kind: 'sidebar-panel' | 'status-bar-item' = panel ? 'sidebar-panel' : 'status-bar-item';
		const mergedProps = { ...(contribution.props ?? {}), ...(props ?? {}) };
		let instance: any = null;

		if (typeof contribution.component === 'function') {
			try {
				instance = contribution.component(target, mergedProps);
			} catch (err) {
				instance = { component: contribution.component, target, props: mergedProps, error: err };
			}
		} else if (contribution.component && typeof contribution.component.mount === 'function') {
			instance = contribution.component.mount(target, mergedProps);
		} else {
			instance = { component: contribution.component, target, props: mergedProps };
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
			update: (newProps: Record<string, any>) => {
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
		const byOwner = new Map<string, SettingSchemaTransformEntry[]>();
		for (const entry of this.settingSchemaTransforms) {
			const list = byOwner.get(entry.pluginId);
			if (list) {
				list.push(entry);
			} else {
				byOwner.set(entry.pluginId, [entry]);
			}
		}

		const orderedOwners: string[] = [];
		if (byOwner.has(CORE_SETTINGS_OWNER)) {
			orderedOwners.push(CORE_SETTINGS_OWNER);
		}
		for (const id of this.activationOrder) {
			if (byOwner.has(id) && !orderedOwners.includes(id)) {
				orderedOwners.push(id);
			}
		}
		for (const id of [...byOwner.keys()].sort()) {
			if (!orderedOwners.includes(id)) {
				orderedOwners.push(id);
			}
		}

		const included = orderedOwners.filter(
			(id) => id === CORE_SETTINGS_OWNER || !this.registrations.has(id) || this.isPluginActive(id)
		);
		return included.flatMap((id) => byOwner.get(id)!);
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
			? Array.from(new Set(pluginIds))
			: Array.from(this.registrations.keys());

		// Verify existence
		for (const id of targetIds) {
			if (!this.registrations.has(id)) {
				throw new PluginNotFoundError(id);
			}
		}

		// Map interface name to providing plugin ID
		const interfaceProviders = new Map<string, { pluginId: string; version: number }>();
		for (const [id, reg] of this.registrations.entries()) {
			if (reg.manifest.provides) {
				for (const [iface, ver] of Object.entries(reg.manifest.provides)) {
					interfaceProviders.set(iface, { pluginId: id, version: ver });
				}
			}
		}

		// Build dependency adjacency list: id -> list of plugin IDs it depends on
		const adj = new Map<string, Set<string>>();
		const visitedForGraph = new Set<string>();

		const collectDeps = (id: string, path: string[]) => {
			if (visitedForGraph.has(id)) return;
			visitedForGraph.add(id);

			const reg = this.registrations.get(id);
			if (!reg) return;

			const deps = new Set<string>();
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
		const inDegree = new Map<string, number>();
		const reverseAdj = new Map<string, string[]>(); // dependency -> dependents

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
	 */
	async activate(id: string): Promise<void> {
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
	 */
	async activateAll(): Promise<void> {
		const order = this.computeActivationOrder();
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
				const cleanupResult: unknown = await setupFn(this);
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
		} catch (error) {
			this.states.set(id, 'error');
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

		// Execute cleanup if present
		const cleanup = this.cleanups.get(id);
		if (cleanup) {
			try {
				await cleanup();
			} catch (error) {
				console.error(`[PluginHost] Error during cleanup of plugin "${id}":`, error);
			} finally {
				this.cleanups.delete(id);
			}
		}

		this.states.set(id, 'inactive');
		this.deactivationReasons.set(id, reason);
		this.activationOrder = this.activationOrder.filter((item) => item !== id);
		this.removePluginCommands(id);
		this.removePluginHooks(id);
		this.removePluginWorkspaceHooks(id);
		this.removePluginEvents(id);
		this.removePluginSettings(id);
		this.removePluginUIContributions(id);
		this.removePluginEditorContributions(id);
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

	registerEditorContributions(pluginId: string, contributions: readonly EditorContribution[]): void {
		for (const incoming of contributions) {
			const existing = this.editorContributions.find((e) => e.contribution.id === incoming.id);
			if (existing) {
				if (existing.pluginId !== pluginId) {
					throw new DuplicateEditorContributionIdError(incoming.id, existing.pluginId, pluginId);
				}
				// Same plugin re-registering: replace with fresh contribution
				this.editorContributions = this.editorContributions.filter((e) => e.contribution.id !== incoming.id);
			}
			this.editorContributions.push({ pluginId, contribution: incoming });
		}
		this.editorRevision++;
	}

	removePluginEditorContributions(pluginId: string): void {
		this.editorContributions = this.editorContributions.filter((e) => e.pluginId !== pluginId);
		this.editorRevision++;
	}

	getEditorContributions(type?: EditorContributionType): readonly EditorContributionEntry[] {
		if (!type) return [...this.editorContributions];
		return this.editorContributions.filter((e) => e.contribution.type === type);
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
			targetDoc = this.documentSessions.get(options.documentId);
		}
		if (!targetDoc) {
			throw new Error("Target document must be specified in ApplyDocumentEditOptions (doc or documentId).");
		}
		const attached = this.attachedEditors.get(targetDoc.id);
		return applyDocumentEditOperation(options, targetDoc, attached);
	}

	/**
	 * Disposes all active plugins in reverse activation order.
	 */
	async dispose(): Promise<void> {
		const reverseOrder = [...this.activationOrder].reverse();
		for (const id of reverseOrder) {
			await this.deactivate(id, 'Host disposed');
		}
	}
}
