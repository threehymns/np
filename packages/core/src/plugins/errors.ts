import type { PluginManifest, PluginPlatform } from './types';

/**
 * Actionable diagnostic error thrown when attempting to register a plugin
 * with an ID that is already registered (ADR 0007, ADR 0017).
 */
export class DuplicatePluginIdError extends Error {
	readonly id: string;
	readonly existingManifest?: PluginManifest;
	readonly incomingManifest?: PluginManifest;

	constructor(id: string, existingManifest?: PluginManifest, incomingManifest?: PluginManifest) {
		const details =
			existingManifest && incomingManifest
				? `\n  Existing: "${existingManifest.name}" (version ${existingManifest.version})\n  Incoming: "${incomingManifest.name}" (version ${incomingManifest.version})`
				: '';
		super(
			`Duplicate plugin ID "${id}" detected.${details}\n` +
				`Action: Every plugin must declare a unique "id" in its manifest module. ` +
				`Rename the incoming plugin ID or unregister the conflicting plugin first.`
		);
		this.name = 'DuplicatePluginIdError';
		this.id = id;
		this.existingManifest = existingManifest;
		this.incomingManifest = incomingManifest;
	}
}

/**
 * Error thrown when requesting an operation on an unregistered plugin ID.
 */
export class PluginNotFoundError extends Error {
	readonly id: string;

	constructor(id: string, availableIds: readonly string[] = []) {
		const available = availableIds.length > 0 ? ` Registered plugins: [${availableIds.join(', ')}].` : '';
		super(
			`Plugin "${id}" is not registered.${available}\n` +
				`Action: Ensure the plugin is registered with the host before attempting to activate or configure it.`
		);
		this.name = 'PluginNotFoundError';
		this.id = id;
	}
}

/**
 * Error thrown when a dependency cycle is detected (ADR 0017).
 */
export class DependencyCycleError extends Error {
	readonly cycle: readonly string[];

	constructor(cycle: readonly string[]) {
		super(
			`Plugin dependency cycle detected: ${cycle.join(' -> ')}.\n` +
				`Action: Remove cyclic dependencies between plugins. In-process plugins must form a directed acyclic graph.`
		);
		this.name = 'DependencyCycleError';
		this.cycle = cycle;
	}
}

/**
 * Error thrown when a required dependency or interface is missing (ADR 0017).
 */
export class MissingDependencyError extends Error {
	readonly pluginId: string;
	readonly dependency: string;
	readonly requiredVersion: number;

	constructor(pluginId: string, dependency: string, requiredVersion: number) {
		super(
			`Plugin "${pluginId}" requires missing interface/dependency "${dependency}" (version ${requiredVersion}).\n` +
				`Action: Register and enable a plugin that provides interface "${dependency}" (v${requiredVersion}) before activating "${pluginId}".`
		);
		this.name = 'MissingDependencyError';
		this.pluginId = pluginId;
		this.dependency = dependency;
		this.requiredVersion = requiredVersion;
	}
}

/**
 * Error thrown when an interface version mismatch occurs between provider and consumer (ADR 0017).
 */
export class InterfaceVersionMismatchError extends Error {
	readonly interfaceName: string;
	readonly consumerId: string;
	readonly requiredVersion: number;
	readonly providerId: string;
	readonly providedVersion: number;

	constructor(
		interfaceName: string,
		consumerId: string,
		requiredVersion: number,
		providerId: string,
		providedVersion: number
	) {
		super(
			`Interface version mismatch for "${interfaceName}":\n` +
				`  Consumer: "${consumerId}" requires version ${requiredVersion}\n` +
				`  Provider: "${providerId}" provides version ${providedVersion}\n` +
				`Action: Interface versions must match exactly (ADR 0017). Update "${consumerId}" or "${providerId}" so their interface versions match.`
		);
		this.name = 'InterfaceVersionMismatchError';
		this.interfaceName = interfaceName;
		this.consumerId = consumerId;
		this.requiredVersion = requiredVersion;
		this.providerId = providerId;
		this.providedVersion = providedVersion;
	}
}

/**
 * Error thrown when a plugin is activated on an unsupported platform (ADR 0006).
 */
export class UnsupportedPlatformError extends Error {
	readonly pluginId: string;
	readonly currentPlatform: PluginPlatform;
	readonly supportedPlatforms: readonly PluginPlatform[];

	constructor(pluginId: string, currentPlatform: PluginPlatform, supportedPlatforms: readonly PluginPlatform[]) {
		super(
			`Plugin "${pluginId}" cannot run on platform "${currentPlatform}".\n` +
				`Supported platforms: [${supportedPlatforms.join(', ')}].\n` +
				`Action: Only activate "${pluginId}" on supported platforms or add support for "${currentPlatform}".`
		);
		this.name = 'UnsupportedPlatformError';
		this.pluginId = pluginId;
		this.currentPlatform = currentPlatform;
		this.supportedPlatforms = supportedPlatforms;
	}
}

/**
 * Error thrown when plugin activation fails.
 */
export class PluginActivationError extends Error {
	readonly pluginId: string;
	readonly cause?: unknown;

	constructor(pluginId: string, messageOrCause?: string | unknown, cause?: unknown) {
		const message =
			typeof messageOrCause === 'string'
				? messageOrCause
				: messageOrCause instanceof Error
					? messageOrCause.message
					: String(messageOrCause ?? 'Unknown activation failure');
		const actualCause = cause ?? (typeof messageOrCause !== 'string' ? messageOrCause : undefined);
		super(
			`Failed to activate plugin "${pluginId}": ${message}\n` +
				`Action: Inspect the plugin setup logic and ensure runtime dependencies are initialized.`
		);
		this.name = 'PluginActivationError';
		this.pluginId = pluginId;
		this.cause = actualCause;
	}
}

/**
 * Error thrown when plugin deactivation fails.
 */
export class PluginDeactivationError extends Error {
	readonly pluginId: string;
	readonly cause?: unknown;

	constructor(pluginId: string, messageOrCause?: string | unknown, cause?: unknown) {
		const message =
			typeof messageOrCause === 'string'
				? messageOrCause
				: messageOrCause instanceof Error
					? messageOrCause.message
					: String(messageOrCause ?? 'Unknown deactivation failure');
		const actualCause = cause ?? (typeof messageOrCause !== 'string' ? messageOrCause : undefined);
		super(
			`Failed to deactivate plugin "${pluginId}": ${message}\n` +
				`Action: Check plugin cleanup handlers for uncaught exceptions or hanging promises.`
		);
		this.name = 'PluginDeactivationError';
		this.pluginId = pluginId;
		this.cause = actualCause;
	}
}
