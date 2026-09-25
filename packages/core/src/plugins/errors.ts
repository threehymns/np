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
 * Actionable diagnostic error thrown when two plugins declare the same
 * interface in their manifests (ADR 0008, ADR 0017).
 *
 * Interface names are the addressing scheme dependents bind to, so one name
 * may have exactly one provider. Silently keeping the last registration would
 * bind consumers to whichever plugin registered last and blame the wrong
 * plugin in any later version mismatch.
 */
export class DuplicateInterfaceProviderError extends Error {
	readonly interfaceName: string;
	readonly existingPluginId: string;
	readonly incomingPluginId: string;

	constructor(interfaceName: string, existingPluginId: string, incomingPluginId: string) {
		super(
			`Interface "${interfaceName}" is provided by both "${existingPluginId}" and "${incomingPluginId}".\n` +
				`Action: An interface name must have exactly one provider. Remove "${interfaceName}" from the ` +
				`"provides" map of one of the two manifests, or rename the interface so each provider owns a distinct name.`
		);
		this.name = 'DuplicateInterfaceProviderError';
		this.interfaceName = interfaceName;
		this.existingPluginId = existingPluginId;
		this.incomingPluginId = incomingPluginId;
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

/**
 * Error thrown when a plugin hook re-enters its own operation (ADR 0013).
 */
export class HookReentryError extends Error {
	readonly pluginId: string;
	readonly operation: string;
	readonly phase: string;

	constructor(pluginId: string, operation = 'saveDocument', phase = 'beforeSave hook') {
		super(
			`Plugin "${pluginId}" re-entered ${operation} during ${phase}.\n` +
				`Action: Avoid calling save operations from within a save hook. Use events or deferred background operations instead.`
		);
		this.name = 'HookReentryError';
		this.pluginId = pluginId;
		this.operation = operation;
		this.phase = phase;
	}
}

/**
 * Error thrown to explicitly cancel an operation with a user-visible reason (ADR 0013).
 */
export class SaveCancelledError extends Error {
	readonly reason: string;

	constructor(reason: string) {
		super(`Save cancelled: ${reason}`);
		this.name = 'SaveCancelledError';
		this.reason = reason;
	}
}

/**
 * Actionable diagnostic error thrown when plugin code attempts to access
 * the CodeMirror EditorView directly (ADR 0016).
 */
export class DirectEditorViewAccessError extends Error {
	readonly accessor: string;

	constructor(accessor = "view") {
		super(
			`Direct editor view access via "${accessor}" is strictly rejected (ADR 0016).\n` +
				`Action: Plugins touch the editor only through host-composed contributions ` +
				`(gutters, decorations, editor-scoped keybindings) and host document-edit operations.`
		);
		this.name = "DirectEditorViewAccessError";
		this.accessor = accessor;
	}
}

/**
 * Actionable diagnostic error thrown when plugin code attempts to dispatch
 * raw transactions directly rather than using host document edit operations (ADR 0016).
 */
export class RawTransactionDispatchError extends Error {
	constructor(details?: string) {
		const detailStr = details ? `\n  Details: ${details}` : "";
		super(
			`Raw transaction dispatch from plugin code is strictly rejected (ADR 0016).${detailStr}\n` +
				`Action: Plugins must use host document-edit operations (host.applyDocumentEdit) ` +
				`with structured changes and revision checks.`
		);
		this.name = "RawTransactionDispatchError";
	}
}

/**
 * Actionable diagnostic error thrown when applying a document edit against
 * an outdated or mismatched document revision (ADR 0016).
 */
export class DocumentRevisionMismatchError extends Error {
	readonly expectedRevision: number;
	readonly actualRevision: number;
	readonly documentId?: string;

	constructor(expectedRevision: number, actualRevision: number, documentId?: string) {
		const docStr = documentId ? ` for document "${documentId}"` : "";
		super(
			`Document revision mismatch${docStr}: expected revision ${expectedRevision}, but document is at revision ${actualRevision}.\n` +
				`Action: Re-read the document state and revision before applying edits to avoid clobbering concurrent changes.`
		);
		this.name = "DocumentRevisionMismatchError";
		this.expectedRevision = expectedRevision;
		this.actualRevision = actualRevision;
		this.documentId = documentId;
	}
}

/**
 * Actionable diagnostic error thrown when duplicate editor contribution IDs are registered (ADR 0007, ADR 0016).
 */
export class DuplicateEditorContributionIdError extends Error {
	readonly contributionId: string;
	readonly existingPluginId: string;
	readonly incomingPluginId: string;

	constructor(contributionId: string, existingPluginId: string, incomingPluginId: string) {
		super(
			`Duplicate editor contribution ID "${contributionId}" registered by both "${existingPluginId}" and "${incomingPluginId}".\n` +
				`Action: Every editor contribution must declare a unique "id". Rename the contribution ID or remove the conflicting plugin.`
		);
		this.name = "DuplicateEditorContributionIdError";
		this.contributionId = contributionId;
		this.existingPluginId = existingPluginId;
		this.incomingPluginId = incomingPluginId;
	}
}
