import type {
	EditorContribution,
	EditorContributionEntry,
	EditorContributionType,
	ApplyDocumentEditOptions,
	DocumentEditResult
} from "./editor";
import type { KeymapBinding, KeymapTransform } from '../keymap.svelte';
import type { FileIconTransform, ProductIconTransform } from '../editor/icons-types';
export type PluginPlatform = 'web' | 'desktop';

export type PluginState = 'inactive' | 'activating' | 'active' | 'deactivating' | 'error';

import type { CommandTransform, PluginCommand } from './commands';
import type { EventHandler } from './events';
import type {
	BeforeSaveHook,
	BeforeSaveContext,
	BeforeSaveResult,
	AfterSaveHook,
	AfterSaveContext,
	ActiveHookContext,
	WorkspaceOpenedHook,
	WorkspaceOpenedContext
} from './hooks';
import type { SettingNamespaceSchema, SettingSchemaTransform, SettingsRegistryLike } from './settings';
import type {
	SidebarPanelContribution,
	StatusBarItemContribution,
	StatusBarAlignment,
	TabContentContribution,
	MountedContribution,
	UIContributionRegistryLike
} from './ui-contributions';

/**
 * Static manifest module metadata for a plugin (ADR 0011, ADR 0017).
 * Must remain dependency-free and readable without loading plugin implementation.
 */
export interface PluginManifest {
	/**
	 * Unique identifier for the plugin (e.g. 'git').
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

	/**
	 * Whether the app activates this bundled plugin by default on startup.
	 * Generic opt-in flag (no feature names): the app activates all
	 * registered plugins with `defaultEnabled: true` without naming them.
	 * If omitted, defaults to false (inactive until explicitly enabled).
	 */
	readonly defaultEnabled?: boolean;
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

export interface PluginOperationContext {
	readonly propagation: 'async' | 'none';
	run<T>(context: ActiveHookContext, callback: () => T): T;
	get(): ActiveHookContext | undefined;
}

export interface PluginHostOptions {
	platform?: PluginPlatform;
	initialPlugins?: readonly PluginRegistration[];
	operationContext?: PluginOperationContext;
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

	/**
	 * Lists active plugins that depend on the given plugin, directly or
	 * transitively, in cascade order (dependents before dependencies).
	 * Used to explain the disable cascade before it happens (ADR 0017).
	 */
	getActiveDependents(id: string): string[];

	computeActivationOrder(pluginIds?: string[]): string[];

	activate(id: string): Promise<void>;
	activateAll(): Promise<void>;

	deactivate(id: string, reason?: string): Promise<void>;
	dispose(): Promise<void>;

	// Shared command registry (ADR 0012, ADR 0015). Generic contribution
	// types only: plugins register commands where they are implemented and
	// the host replays transforms in order from an empty initial value.
	registerCommandTransform(pluginId: string, transform: CommandTransform): void;
	registerCommands(pluginId: string, commands: readonly PluginCommand[]): void;
	removePluginCommands(pluginId: string): void;
	rebuildCommands(): void;
	refreshCommands(): void;
	getCommand(id: string): PluginCommand | undefined;
	getCommands(): PluginCommand[];
	getCommandsByCategory(category: string): PluginCommand[];
	executeCommand(id: string, ...args: any[]): any;

	registerKeymapTransform(pluginId: string, transform: KeymapTransform): void;
	registerKeymapBindings(pluginId: string, bindings: readonly KeymapBinding[]): void;
	removePluginKeymaps(pluginId: string): void;
	registerFileIconTransform(pluginId: string, transform: FileIconTransform): void;
	registerProductIconTransform(pluginId: string, transform: ProductIconTransform): void;
	removePluginIcons(pluginId: string): void;

	// Event observation (ADR 0013: Events observe, fire-and-forget)
	on<T = any>(event: string, handler: EventHandler<T>, pluginId?: string): () => void;
	off<T = any>(event: string, handler: EventHandler<T>): void;
	emit<T = any>(event: string, payload?: T): void;
	removePluginEvents(pluginId: string): void;

	// Operation hooks (ADR 0013: Hooks participate)
	registerBeforeSaveHook(pluginId: string, hook: BeforeSaveHook): () => void;
	registerAfterSaveHook(pluginId: string, hook: AfterSaveHook): () => void;
	removePluginHooks(pluginId: string): void;
	runBeforeSave(context: BeforeSaveContext): Promise<BeforeSaveResult>;
	runAfterSave(context: AfterSaveContext): Promise<void>;
	isExecutingSaveHook(): boolean;
	getActiveSaveHook(): ActiveHookContext | null;
	checkSaveReentry(operation?: string, phase?: string): void;

	// Generic workspace-lifecycle hooks (#202, ADR 0013 extension).
	// Awaited participation in folder open: the workspace runs these after
	// the root is set and permission granted, before it proceeds, so
	// feature plugins can own per-workspace resources (repository
	// detection, watchers) with no hardwired core path and no
	// feature-specific host methods.
	registerWorkspaceOpenedHook(pluginId: string, hook: WorkspaceOpenedHook): () => void;
	removePluginWorkspaceHooks(pluginId: string): void;
	runWorkspaceOpened(context: WorkspaceOpenedContext): Promise<void>;

	// Generic application-service sharing (#202, ADR 0008). The host is a
	// neutral meeting point: the app publishes opaque services (workspace,
	// dialogs) and plugins consume them by key with their own types.
	// Well-known keys live in './services'; the host never names features.
	provideService(key: string, service: unknown): void;
	getService<T = unknown>(key: string): T | undefined;

	// Shared settings registry (ADR 0012, ADR 0014). Generic contribution
	// types only: plugins register schemas where they are implemented and
	// the host replays transforms in order from an empty initial value.
	readonly settings: SettingsRegistryLike;
	registerSettingSchema(pluginId: string, schema: SettingNamespaceSchema): void;
	registerSettingTransform(pluginId: string, transform: SettingSchemaTransform): void;
	removePluginSettings(pluginId: string): void;
	rebuildSettings(): void;
	refreshSettings(): void;
	getSettingSchema(namespace: string): SettingNamespaceSchema | undefined;
	getSettingSchemas(): SettingNamespaceSchema[];

	// UI contributions (ADR 0010, ADR 0015)
	readonly ui: UIContributionRegistryLike;
	registerSidebarPanel(pluginId: string, panel: SidebarPanelContribution): void;
	registerSidebarPanels(pluginId: string, panels: readonly SidebarPanelContribution[]): void;
	removePluginSidebarPanels(pluginId: string): void;
	getSidebarPanel(id: string): SidebarPanelContribution | undefined;
	getSidebarPanels(): SidebarPanelContribution[];

	registerStatusBarItem(pluginId: string, item: StatusBarItemContribution): void;
	registerStatusBarItems(pluginId: string, items: readonly StatusBarItemContribution[]): void;
	removePluginStatusBarItems(pluginId: string): void;
	getStatusBarItem(id: string): StatusBarItemContribution | undefined;
	getStatusBarItems(alignment?: StatusBarAlignment): StatusBarItemContribution[];

	registerTabContent(pluginId: string, content: TabContentContribution): void;
	registerTabContents(pluginId: string, contents: readonly TabContentContribution[]): void;
	removePluginTabContents(pluginId: string): void;
	getTabContent(id: string): TabContentContribution | undefined;
	getTabContents(): TabContentContribution[];

	mountContribution(
		pluginId: string,
		contributionId: string,
		target: any,
		props?: Record<string, any>
	): MountedContribution;
	unmountContribution(instanceId: string): void;
	rebuildUIContributions(): void;

	// Editor contribution contract (ADR 0016).
	// Plugins declare CodeMirror extensions as contributions that the host
	// places into the correct compartments of its single composed configuration.
	registerEditorContribution(pluginId: string, contribution: EditorContribution): void;
	registerEditorContributions(pluginId: string, contributions: readonly EditorContribution[]): void;
	removePluginEditorContributions(pluginId: string): void;
	getEditorContributions(type?: EditorContributionType): readonly EditorContributionEntry[];
	readonly editorRevision: number;
	readonly editorContributionsRevision?: number;

	// Document text changes go through a host document-edit operation
	// applied as one undo transaction with revision checks.
	applyDocumentEdit(options: ApplyDocumentEditOptions): DocumentEditResult;
}
