export type PluginPlatform = 'web' | 'desktop';

export type PluginState = 'inactive' | 'activating' | 'active' | 'deactivating' | 'error';

/**
 * Static manifest module metadata for a plugin (ADR 0011, ADR 0017).
 * Must remain dependency-free and readable without loading plugin implementation.
 */
export interface PluginManifest {
	/**
	 * Unique identifier for the plugin (e.g. 'hello', 'git').
	 */
	readonly id: string;

	/**
	 * Human-readable display name.
	 */
	readonly name: string;

	/**
	 * Exact-match integer version starting at 0 (ADR 0017).
	 */
	readonly version: number;

	/**
	 * Short description of the plugin's purpose.
	 */
	readonly description?: string;

	/**
	 * Supported platforms. If omitted, defaults to all platforms (web and desktop).
	 */
	readonly platforms?: readonly PluginPlatform[];

	/**
	 * Interface dependencies mapped to required integer versions.
	 * e.g. { 'vcs': 0 }
	 */
	readonly dependsOn?: Readonly<Record<string, number>>;

	/**
	 * Interfaces provided by this plugin mapped to provided integer versions.
	 * e.g. { 'vcs': 0 }
	 */
	readonly provides?: Readonly<Record<string, number>>;
}

export type PluginCleanup = () => void | Promise<void>;

export type PluginSetup = (host: PluginHostInterface) => PluginCleanup | void | Promise<PluginCleanup | void>;

export interface PluginDefinition {
	readonly manifest: PluginManifest;
	readonly setup: PluginSetup;
}

export type PluginLoader = () => Promise<
	PluginDefinition | { setup: PluginSetup } | { default: PluginDefinition | { setup: PluginSetup } } | { setup?: PluginSetup }
>;

/**
 * Registration entry for a plugin.
 * Pairs a static manifest with either a synchronous setup or a lazy loader (ADR 0011).
 */
export interface PluginRegistration {
	readonly manifest: PluginManifest;
	readonly setup?: PluginSetup;
	readonly load?: PluginLoader;
}

export interface PluginHostOptions {
	platform?: PluginPlatform;
	initialPlugins?: readonly PluginRegistration[];
}

export interface PluginHostInterface {
	readonly hostVersion: number;
	readonly platform: PluginPlatform;

	register(plugin: PluginRegistration): void;
	registerAll(plugins: readonly PluginRegistration[]): void;
	unregister(id: string): Promise<void>;

	hasPlugin(id: string): boolean;
	getManifest(id: string): PluginManifest | undefined;
	getManifests(): PluginManifest[];

	getPluginState(id: string): PluginState;
	isPluginActive(id: string): boolean;
	getDeactivationReason(id: string): string | undefined;

	computeActivationOrder(pluginIds?: string[]): string[];

	activate(id: string): Promise<void>;
	activateAll(): Promise<void>;

	deactivate(id: string, reason?: string): Promise<void>;
	dispose(): Promise<void>;
}
