import type {
	PluginCleanup,
	PluginHostInterface,
	PluginHostOptions,
	PluginManifest,
	PluginPlatform,
	PluginRegistration,
	PluginState
} from './types';
import {
	DependencyCycleError,
	DuplicatePluginIdError,
	InterfaceVersionMismatchError,
	MissingDependencyError,
	PluginActivationError,
	PluginNotFoundError,
	UnsupportedPlatformError
} from './errors';
import {
	CORE_COMMANDS_OWNER,
	createAddCommandsTransform,
	rebuildCommands,
	type CommandRegistryLike,
	type CommandTransform,
	type CommandTransformEntry,
	type PluginCommand
} from './commands';

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

export class PluginHost implements PluginHostInterface {
	readonly hostVersion = 0;
	readonly platform: PluginPlatform;

	// Internal state tracking
	private registrations = new Map<string, PluginRegistration>();
	private states = $state<Map<string, PluginState>>(new Map());
	private deactivationReasons = $state<Map<string, string>>(new Map());
	private cleanups = new Map<string, PluginCleanup>();
	private activationOrder = $state<string[]>([]);

	// Shared command registry: replayable transforms + materialized view.
	// Plugins contribute via registerCommands/registerCommandTransform during
	// setup; the host replays in order from an empty initial value on every
	// rebuild (ADR 0012). Palette and menus are views over this state.
	private commandTransforms: CommandTransformEntry[] = [];
	private commandMap = $state<Map<string, PluginCommand>>(new Map());

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

	constructor(options: PluginHostOptions = {}) {
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
		this.removePluginSettings(id);
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
		this.commandMap = rebuildCommands(this.orderedCommandTransforms());
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
		if (command && (!command.isEnabled || command.isEnabled())) {
			return command.action(...args);
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

	/**
	 * Computes deterministic activation order using topological sort.
	 * Detects cycles and interface requirements.
	 */
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
		for (const id of targetIds) {
			adj.set(id, new Set<string>());
		}

		// Closure to add all transitive dependencies to the graph
		const queue = [...targetIds];
		const visitedForGraph = new Set<string>(targetIds);

		while (queue.length > 0) {
			const currentId = queue.shift()!;
			const manifest = this.registrations.get(currentId)!.manifest;

			if (manifest.dependsOn) {
				for (const [requiredKey, requiredVer] of Object.entries(manifest.dependsOn)) {
					// Direct plugin-ID dependency takes precedence over interface names.
					// This supports dependsOn entries like { 'plugin-b': 0 } where the
					// key names another registered plugin (e.g. for cycle detection),
					// while preserving interface resolution (e.g. { 'vcs': 0 }).
					const directTarget = this.registrations.get(requiredKey);
					if (directTarget) {
						if (directTarget.manifest.version !== requiredVer) {
							throw new InterfaceVersionMismatchError(
								requiredKey,
								currentId,
								requiredVer,
								requiredKey,
								directTarget.manifest.version
							);
						}

						adj.get(currentId)!.add(requiredKey);

						if (!visitedForGraph.has(requiredKey)) {
							visitedForGraph.add(requiredKey);
							adj.set(requiredKey, new Set<string>());
							queue.push(requiredKey);
						}
						continue;
					}

					const provider = interfaceProviders.get(requiredKey);
					if (!provider) {
						throw new MissingDependencyError(currentId, requiredKey, requiredVer);
					}

					if (provider.version !== requiredVer) {
						throw new InterfaceVersionMismatchError(
							requiredKey,
							currentId,
							requiredVer,
							provider.pluginId,
							provider.version
						);
					}

					adj.get(currentId)!.add(provider.pluginId);

					if (!visitedForGraph.has(provider.pluginId)) {
						visitedForGraph.add(provider.pluginId);
						adj.set(provider.pluginId, new Set<string>());
						queue.push(provider.pluginId);
					}
				}
			}
		}

		// Cycle detection and topological sort using Kahn's algorithm or DFS
		// To ensure deterministic tie-breaking (ADR 0017), sort nodes alphabetically
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

		// Find active plugins that depend on this plugin, either via interfaces
		// it provides or via a direct plugin-ID dependsOn entry (Cascade rule).
		const manifest = this.getManifest(id)!;
		const providedInterfaces = manifest.provides ? Object.keys(manifest.provides) : [];

		for (const otherId of [...this.activationOrder]) {
			if (otherId === id || !this.isPluginActive(otherId)) continue;
			const otherManifest = this.getManifest(otherId)!;
			if (otherManifest.dependsOn) {
				const dependsOnThis =
					Object.hasOwn(otherManifest.dependsOn, id) ||
					Object.keys(otherManifest.dependsOn).some((iface) => providedInterfaces.includes(iface));
				if (dependsOnThis) {
					// Cascade deactivate dependent first
					await this.deactivate(otherId, `${otherManifest.name} is off because ${manifest.name} is off.`);
				}
			}
		}

		this.states.set(id, 'deactivating');

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
		this.removePluginSettings(id);
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
