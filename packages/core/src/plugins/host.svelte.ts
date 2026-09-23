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

export class PluginHost implements PluginHostInterface {
	readonly hostVersion = 0;
	readonly platform: PluginPlatform;

	// Internal state tracking
	private registrations = new Map<string, PluginRegistration>();
	private states = $state<Map<string, PluginState>>(new Map());
	private deactivationReasons = $state<Map<string, string>>(new Map());
	private cleanups = new Map<string, PluginCleanup>();
	private activationOrder = $state<string[]>([]);

	constructor(options: PluginHostOptions = {}) {
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
				for (const [requiredIface, requiredVer] of Object.entries(manifest.dependsOn)) {
					const provider = interfaceProviders.get(requiredIface);
					if (!provider) {
						throw new MissingDependencyError(currentId, requiredIface, requiredVer);
					}

					if (provider.version !== requiredVer) {
						throw new InterfaceVersionMismatchError(
							requiredIface,
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

		// Find active plugins that depend on interfaces provided by this plugin (Cascade rule)
		const manifest = this.getManifest(id)!;
		const providedInterfaces = manifest.provides ? Object.keys(manifest.provides) : [];

		if (providedInterfaces.length > 0) {
			for (const otherId of this.activationOrder) {
				if (otherId === id || !this.isPluginActive(otherId)) continue;
				const otherManifest = this.getManifest(otherId)!;
				if (otherManifest.dependsOn) {
					const dependsOnThis = Object.keys(otherManifest.dependsOn).some((iface) =>
						providedInterfaces.includes(iface)
					);
					if (dependsOnThis) {
						// Cascade deactivate dependent first
						await this.deactivate(otherId, `${otherManifest.name} was disabled because ${manifest.name} was disabled.`);
					}
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
