/**
 * Settings namespaces, layered resolver, and workspace scope (ADR 0012, ADR 0014, #199).
 *
 * Implements plugin-owned settings namespaces with schemas, defaults,
 * explicit merge rules, and a layered resolver across Default < User < Workspace scopes,
 * reporting effective values plus provenance ('default' | 'user' | 'workspace').
 *
 * Key guarantees (ADR 0014, #199):
 * - Plugin settings are declared under plugin-owned namespaces with schemas,
 *   defaults, control hints, and allowed scopes.
 * - Workspace-level configuration (.np/settings.json) overrides user-level values.
 * - Precedence: default < user < workspace.
 * - Resolver reports provenance accurately: 'default' | 'user' | 'workspace'.
 * - Inherited values are NEVER materialized into the scope the user is editing.
 * - Settings belonging to disabled plugins are preserved untouched in storage.
 * - Invalid stored values produce diagnostics, never silent resets.
 * - JSONC comments and unknown namespaces survive edits.
 */

import { parse, modify, applyEdits, type ParseError, printParseErrorCode } from 'jsonc-parser';

/** Owner ID for settings registered synchronously by the core application. */
export const CORE_SETTINGS_OWNER = 'core';

export type SettingScope = 'user' | 'workspace';
export type SettingProvenance = 'default' | 'user' | 'workspace';

export type SettingPropertyType = 'boolean' | 'number' | 'string' | 'object' | 'array';

export type SettingControlHint =
	| 'toggle'
	| 'checkbox'
	| 'input'
	| 'number'
	| 'slider'
	| 'select'
	| 'color'
	| 'json';

export type SettingMergeRule = 'replace' | 'shallow' | 'deep';

export type SettingMergeFunction<T = any> = (current: T, incoming: T) => T;

export interface SettingDiagnostic {
	readonly namespace: string;
	readonly key: string;
	readonly message: string;
	readonly severity: 'error' | 'warning' | 'info';
	readonly receivedValue?: unknown;
	readonly scope?: SettingScope;
}

export interface SettingPropertySchema<T = any> {
	readonly type: SettingPropertyType;
	readonly default: T;
	readonly title?: string;
	readonly label?: string;
	readonly description?: string;
	readonly enum?: readonly T[];
	readonly minimum?: number;
	readonly maximum?: number;
	readonly step?: number;
	readonly control?: SettingControlHint;
	readonly scope?: readonly SettingScope[];
	readonly mergeRule?: SettingMergeRule | SettingMergeFunction<T>;
	readonly validate?: (value: unknown) => { valid: boolean; error?: string } | boolean | string | void;
	/**
	 * Aliases for backwards-compatibility or alternate names (e.g. camelCase vs snake_case).
	 */
	readonly alias?: string | readonly string[];
}

export interface SettingNamespaceSchema {
	readonly namespace: string;
	readonly title?: string;
	readonly description?: string;
	readonly properties: Readonly<Record<string, SettingPropertySchema<any>>>;
}

export interface ResolvedSetting<T = any> {
	readonly namespace: string;
	readonly key: string;
	readonly value: T;
	readonly provenance: SettingProvenance;
	/** Alias for provenance */
	readonly source: SettingProvenance;
	readonly defaultValue: T;
	readonly userValue?: T;
	readonly workspaceValue?: T;
	readonly schema?: SettingPropertySchema<T>;
	readonly diagnostics?: readonly SettingDiagnostic[];
}

export const WORKSPACE_SETTINGS_RELATIVE_PATH = '.np/settings.json';

export interface WorkspaceSettingsStorage {
	load(): Promise<string | null> | string | null;
	save(content: string): Promise<void> | void;
}

/**
 * A pure, repeatable transform of setting namespace schemas (ADR 0012).
 */
export type SettingSchemaTransform = (
	prev: ReadonlyMap<string, SettingNamespaceSchema>
) => ReadonlyMap<string, SettingNamespaceSchema>;

export interface SettingSchemaTransformEntry {
	readonly pluginId: string;
	readonly transform: SettingSchemaTransform;
}

/**
 * Actionable diagnostic thrown when two different owners contribute the same settings namespace.
 */
export class DuplicateSettingNamespaceError extends Error {
	readonly namespace: string;
	readonly existingPluginId: string;
	readonly incomingPluginId: string;

	constructor(namespace: string, existingPluginId: string, incomingPluginId: string) {
		super(
			`Duplicate settings namespace "${namespace}" contributed by both "${existingPluginId}" and "${incomingPluginId}".\\n` +
				`Action: Every settings namespace must be uniquely owned. Rename the incoming namespace or remove the conflicting plugin.`
		);
		this.name = 'DuplicateSettingNamespaceError';
		this.namespace = namespace;
		this.existingPluginId = existingPluginId;
		this.incomingPluginId = incomingPluginId;
	}
}

/**
 * Creates a transform that adds a setting namespace schema to the accumulated state.
 */
export function createAddSettingSchemaTransform(schema: SettingNamespaceSchema): SettingSchemaTransform {
	const snapshot = {
		...schema,
		properties: { ...schema.properties }
	};
	return (prev) => {
		const next = new Map(prev);
		next.set(snapshot.namespace, snapshot);
		return next;
	};
}

/**
 * Replays setting schema transform entries in order from an empty initial value (ADR 0012).
 * Pure and repeatable: identical entry lists yield identical Map results.
 */
export function rebuildSettingSchemas(
	transforms: readonly SettingSchemaTransformEntry[]
): Map<string, SettingNamespaceSchema> {
	let state = new Map<string, SettingNamespaceSchema>();
	const owners = new Map<string, string>();

	for (const entry of transforms) {
		const input = new Map(state);
		const result = entry.transform(input);
		const next = result instanceof Map ? new Map(result) : new Map<string, SettingNamespaceSchema>();

		for (const [namespace, schema] of next) {
			const prevSchema = state.get(namespace);
			if (prevSchema === undefined) {
				const owner = owners.get(namespace);
				if (owner !== undefined && owner !== entry.pluginId) {
					throw new DuplicateSettingNamespaceError(namespace, owner, entry.pluginId);
				}
				owners.set(namespace, entry.pluginId);
			} else if (prevSchema !== schema) {
				const owner = owners.get(namespace);
				if (owner !== undefined && owner !== entry.pluginId) {
					throw new DuplicateSettingNamespaceError(namespace, owner, entry.pluginId);
				}
				owners.set(namespace, entry.pluginId);
			}
		}

		for (const namespace of state.keys()) {
			if (!next.has(namespace)) {
				owners.delete(namespace);
			}
		}

		state = next;
	}

	return state;
}

/**
 * Standard Zed-aligned Editor settings schema.
 */
export const EDITOR_SCHEMA: SettingNamespaceSchema = {
	namespace: 'editor',
	title: 'Editor',
	description: 'Code and Markdown editor settings',
	properties: {
		tab_size: {
			type: 'number',
			default: 2,
			title: 'Tab Size',
			description: 'The number of spaces a tab is equal to',
			minimum: 1,
			maximum: 8,
			control: 'input',
			alias: 'tabSize'
		},
		line_numbers: {
			type: 'boolean',
			default: true,
			title: 'Line Numbers',
			description: 'Whether to show line numbers in the gutter',
			control: 'toggle',
			alias: 'lineNumbers'
		},
		word_wrap: {
			type: 'boolean',
			default: true,
			title: 'Word Wrap',
			description: 'Controls line wrapping in the editor',
			control: 'toggle',
			alias: 'wordWrap'
		},
		vim_mode: {
			type: 'boolean',
			default: false,
			title: 'Vim Mode',
			description: 'Enables Vim modal editing emulation',
			control: 'toggle',
			alias: 'vimMode'
		},
		vim_sync_clipboard: {
			type: 'boolean',
			default: true,
			title: 'Vim Sync Clipboard',
			description: 'Synchronizes the Vim yank/paste register with the system clipboard',
			control: 'toggle',
			alias: 'vimSyncClipboard'
		}
	}
};

/**
 * Standard UI settings schema.
 */
export const UI_SCHEMA: SettingNamespaceSchema = {
	namespace: 'ui',
	title: 'User Interface',
	description: 'Appearance, themes, and layout settings',
	properties: {
		theme: {
			type: 'string',
			default: 'default',
			title: 'Theme',
			description: 'Visual color theme for the editor and application',
			control: 'select'
		},
		appearance_mode: {
			type: 'string',
			default: 'system',
			title: 'Appearance Mode',
			description: 'Application appearance mode (system, light, dark)',
			enum: ['system', 'light', 'dark'],
			control: 'select',
			alias: 'appearanceMode'
		},
		accent_color: {
			type: 'string',
			default: 'default',
			title: 'Accent Color',
			description: 'Accent color for UI highlights and focus rings',
			control: 'color',
			alias: 'accentColor'
		},
		zoom: {
			type: 'number',
			default: 100,
			title: 'Zoom',
			description: 'Editor and interface zoom level percentage',
			minimum: 10,
			maximum: 500,
			control: 'slider'
		},
		status_bar: {
			type: 'boolean',
			default: true,
			title: 'Status Bar',
			description: 'Toggles the visibility of the status bar',
			control: 'toggle',
			alias: 'statusBar'
		},
		sidebar_visible: {
			type: 'boolean',
			default: true,
			title: 'Sidebar Visible',
			description: 'Controls visibility of the file explorer sidebar',
			control: 'toggle',
			alias: 'sidebarVisible'
		},
		sidebar_width: {
			type: 'number',
			default: 256,
			title: 'Sidebar Width',
			description: 'Initial width of the file explorer sidebar in pixels',
			minimum: 100,
			maximum: 1000,
			control: 'input',
			alias: 'sidebarWidth'
		},
		file_icon_theme_id: {
			type: 'string',
			default: 'phosphor',
			title: 'File Icon Theme',
			description: 'Active file icon theme identifier',
			control: 'select',
			alias: 'fileIconThemeId'
		},
		product_icon_theme_id: {
			type: 'string',
			default: 'phosphor',
			title: 'Product Icon Theme',
			description: 'Active product/UI icon theme identifier',
			control: 'select',
			alias: 'productIconThemeId'
		}
	}
};

/**
 * Validates a value against a setting property schema.
 */
export function validateSettingValue(
	namespace: string,
	key: string,
	value: unknown,
	schema: SettingPropertySchema
): { valid: true } | { valid: false; diagnostic: SettingDiagnostic } {
	if (value === undefined || value === null) {
		return { valid: true };
	}

	switch (schema.type) {
		case 'boolean':
			if (typeof value !== 'boolean') {
				return {
					valid: false,
					diagnostic: {
						namespace,
						key,
						message: `Invalid type for "${namespace}.${key}": expected boolean, received ${typeof value}`,
						severity: 'error',
						receivedValue: value
					}
				};
			}
			break;
		case 'number':
			if (typeof value !== 'number' || Number.isNaN(value)) {
				return {
					valid: false,
					diagnostic: {
						namespace,
						key,
						message: `Invalid type for "${namespace}.${key}": expected number, received ${typeof value}`,
						severity: 'error',
						receivedValue: value
					}
				};
			}
			if (schema.minimum !== undefined && value < schema.minimum) {
				return {
					valid: false,
					diagnostic: {
						namespace,
						key,
						message: `Value for "${namespace}.${key}" (${value}) is below minimum ${schema.minimum}`,
						severity: 'error',
						receivedValue: value
					}
				};
			}
			if (schema.maximum !== undefined && value > schema.maximum) {
				return {
					valid: false,
					diagnostic: {
						namespace,
						key,
						message: `Value for "${namespace}.${key}" (${value}) exceeds maximum ${schema.maximum}`,
						severity: 'error',
						receivedValue: value
					}
				};
			}
			break;
		case 'string':
			if (typeof value !== 'string') {
				return {
					valid: false,
					diagnostic: {
						namespace,
						key,
						message: `Invalid type for "${namespace}.${key}": expected string, received ${typeof value}`,
						severity: 'error',
						receivedValue: value
					}
				};
			}
			if (schema.enum && !schema.enum.includes(value)) {
				return {
					valid: false,
					diagnostic: {
						namespace,
						key,
						message: `Value "${value}" for "${namespace}.${key}" is not one of allowed values: [${schema.enum.join(', ')}]`,
						severity: 'error',
						receivedValue: value
					}
				};
			}
			break;
		case 'object':
			if (typeof value !== 'object' || value === null || Array.isArray(value)) {
				return {
					valid: false,
					diagnostic: {
						namespace,
						key,
						message: `Invalid type for "${namespace}.${key}": expected object, received ${typeof value}`,
						severity: 'error',
						receivedValue: value
					}
				};
			}
			break;
		case 'array':
			if (!Array.isArray(value)) {
				return {
					valid: false,
					diagnostic: {
						namespace,
						key,
						message: `Invalid type for "${namespace}.${key}": expected array, received ${typeof value}`,
						severity: 'error',
						receivedValue: value
					}
				};
			}
			break;
	}

	if (schema.validate) {
		const customRes = schema.validate(value);
		if (customRes === false) {
			return {
				valid: false,
				diagnostic: {
					namespace,
					key,
					message: `Validation failed for "${namespace}.${key}"`,
					severity: 'error',
					receivedValue: value
				}
			};
		}
		if (typeof customRes === 'string') {
			return {
				valid: false,
				diagnostic: {
					namespace,
					key,
					message: customRes,
					severity: 'error',
					receivedValue: value
				}
			};
		}
		if (typeof customRes === 'object' && customRes !== null && !customRes.valid) {
			return {
				valid: false,
				diagnostic: {
					namespace,
					key,
					message: customRes.error ?? `Validation failed for "${namespace}.${key}"`,
					severity: 'error',
					receivedValue: value
				}
			};
		}
	}

	return { valid: true };
}

/**
 * Merges default setting values with overrides according to the schema merge rule.
 */
export function applyMergeRule<T>(
	defaultValue: T,
	incomingValue: T,
	rule?: SettingMergeRule | SettingMergeFunction<T>
): T {
	if (typeof rule === 'function') {
		return rule(defaultValue, incomingValue);
	}
	if (
		rule === 'shallow' &&
		typeof defaultValue === 'object' &&
		defaultValue !== null &&
		typeof incomingValue === 'object' &&
		incomingValue !== null &&
		!Array.isArray(defaultValue) &&
		!Array.isArray(incomingValue)
	) {
		return { ...defaultValue, ...incomingValue };
	}
	if (
		rule === 'deep' &&
		typeof defaultValue === 'object' &&
		defaultValue !== null &&
		typeof incomingValue === 'object' &&
		incomingValue !== null &&
		!Array.isArray(defaultValue) &&
		!Array.isArray(incomingValue)
	) {
		return deepMergeObjects(defaultValue, incomingValue);
	}
	// 'replace' or default
	return incomingValue;
}

function deepMergeObjects(base: any, override: any): any {
	if (
		Array.isArray(base) ||
		Array.isArray(override) ||
		typeof base !== 'object' ||
		typeof override !== 'object' ||
		!base ||
		!override
	) {
		return override;
	}
	const result = { ...base };
	for (const key of Object.keys(override)) {
		if (key in base && typeof base[key] === 'object' && typeof override[key] === 'object') {
			result[key] = deepMergeObjects(base[key], override[key]);
		} else {
			result[key] = override[key];
		}
	}
	return result;
}

/**
 * Modifies a JSONC document while preserving existing formatting and comments.
 */
export function applySettingEditToJsonc(
	text: string,
	path: readonly (string | number)[],
	value: unknown
): string {
	const initialText = text.trim() ? text : '{\n}\n';
	const edits = modify(initialText, path as (string | number)[], value, {
		formattingOptions: {
			insertSpaces: true,
			tabSize: 2
		}
	});
	return applyEdits(initialText, edits);
}

/**
 * Pure settings resolver for layered scopes (default < user < workspace).
 * Accurately reports provenance and prevents invalid stored values from corrupting defaults.
 */
export class SettingsResolver {
	constructor(
		private readonly getSchemaFn: (namespace: string) => SettingNamespaceSchema | undefined,
		private readonly getUserDataFn: () => Record<string, any>,
		private readonly getWorkspaceDataFn?: () => Record<string, any> | undefined
	) {}

	/**
	 * Resolves a setting for the given namespace and key across default, user, and workspace scopes.
	 * TargetScope limits the resolution level (e.g. 'user' resolves only default < user).
	 */
	resolve<T = any>(namespace: string, key: string, targetScope?: SettingScope): ResolvedSetting<T> {
		const schema = this.getSchemaFn(namespace);
		const propSchema = schema?.properties[key] as SettingPropertySchema<T> | undefined;

		const userData = this.getUserDataFn();
		const userNs =
			userData && typeof userData[namespace] === 'object' && userData[namespace] !== null
				? userData[namespace]
				: undefined;

		const wsData = targetScope !== 'user' ? this.getWorkspaceDataFn?.() : undefined;
		const wsNs =
			wsData && typeof wsData[namespace] === 'object' && wsData[namespace] !== null
				? wsData[namespace]
				: undefined;

		// 1. If property schema exists:
		if (propSchema) {
			const defaultValue = propSchema.default;
			const diagnostics: SettingDiagnostic[] = [];

			// Look up user value
			let userRawValue: unknown = undefined;
			let userFound = false;

			if (userNs && key in userNs) {
				userRawValue = userNs[key];
				userFound = true;
			} else if (userNs && propSchema.alias) {
				const aliases = Array.isArray(propSchema.alias) ? propSchema.alias : [propSchema.alias];
				for (const alias of aliases) {
					if (alias in userNs) {
						userRawValue = userNs[alias];
						userFound = true;
						break;
					}
				}
			}

			if (!userFound && userData) {
				if (key in userData) {
					userRawValue = userData[key];
					userFound = true;
				} else if (propSchema.alias) {
					const aliases = Array.isArray(propSchema.alias) ? propSchema.alias : [propSchema.alias];
					for (const alias of aliases) {
						if (alias in userData) {
							userRawValue = userData[alias];
							userFound = true;
							break;
						}
					}
				}
			}

			// Validate user value
			let userValid = false;
			if (userFound && userRawValue !== undefined) {
				const userValidation = validateSettingValue(namespace, key, userRawValue, propSchema);
				if (userValidation.valid) {
					userValid = true;
				} else {
					diagnostics.push({
						...userValidation.diagnostic,
						scope: 'user'
					});
				}
			}

			// Look up workspace value
			let wsRawValue: unknown = undefined;
			let wsFound = false;

			if (wsNs && key in wsNs) {
				wsRawValue = wsNs[key];
				wsFound = true;
			} else if (wsNs && propSchema.alias) {
				const aliases = Array.isArray(propSchema.alias) ? propSchema.alias : [propSchema.alias];
				for (const alias of aliases) {
					if (alias in wsNs) {
						wsRawValue = wsNs[alias];
						wsFound = true;
						break;
					}
				}
			}

			// Validate workspace value (check scope restriction & validity)
			let wsValid = false;
			if (wsFound && wsRawValue !== undefined) {
				if (propSchema.scope && !propSchema.scope.includes('workspace')) {
					diagnostics.push({
						namespace,
						key,
						message: `Setting "${namespace}.${key}" cannot be configured in workspace scope`,
						severity: 'warning',
						scope: 'workspace',
						receivedValue: wsRawValue
					});
				} else {
					const wsValidation = validateSettingValue(namespace, key, wsRawValue, propSchema);
					if (wsValidation.valid) {
						wsValid = true;
					} else {
						diagnostics.push({
							...wsValidation.diagnostic,
							scope: 'workspace'
						});
					}
				}
			}

			// Resolve effective value and provenance: default < user < workspace
			let effectiveValue: T = defaultValue;
			let provenance: SettingProvenance = 'default';

			if (userValid) {
				effectiveValue = applyMergeRule(defaultValue, userRawValue as T, propSchema.mergeRule);
				provenance = 'user';
			}

			if (wsValid) {
				effectiveValue = applyMergeRule(effectiveValue, wsRawValue as T, propSchema.mergeRule);
				provenance = 'workspace';
			}

			return {
				namespace,
				key,
				value: effectiveValue,
				provenance,
				source: provenance,
				defaultValue,
				userValue: userFound ? (userRawValue as T) : undefined,
				workspaceValue: wsFound ? (wsRawValue as T) : undefined,
				schema: propSchema,
				diagnostics: diagnostics.length > 0 ? diagnostics : undefined
			};
		}

		// 2. No schema registered (disabled plugin or unknown namespace)
		let wsRawValue: unknown = undefined;
		if (wsNs && key in wsNs) {
			wsRawValue = wsNs[key];
		}

		let userRawValue: unknown = undefined;
		let userFound = false;
		if (userNs && key in userNs) {
			userRawValue = userNs[key];
			userFound = true;
		} else if (userData && key in userData) {
			userRawValue = userData[key];
			userFound = true;
		}

		if (wsRawValue !== undefined) {
			return {
				namespace,
				key,
				value: wsRawValue as T,
				provenance: 'workspace',
				source: 'workspace',
				defaultValue: undefined as unknown as T,
				userValue: userFound ? (userRawValue as T) : undefined,
				workspaceValue: wsRawValue as T
			};
		}

		if (userRawValue !== undefined) {
			return {
				namespace,
				key,
				value: userRawValue as T,
				provenance: 'user',
				source: 'user',
				defaultValue: undefined as unknown as T,
				userValue: userRawValue as T,
				workspaceValue: undefined
			};
		}

		return {
			namespace,
			key,
			value: undefined as unknown as T,
			provenance: 'default',
			source: 'default',
			defaultValue: undefined as unknown as T
		};
	}

	/**
	 * Convenience getter returning just the effective value.
	 */
	get<T = any>(namespace: string, key: string, targetScope?: SettingScope): T {
		return this.resolve<T>(namespace, key, targetScope).value;
	}

	/**
	 * Resolves all settings in a namespace across registered properties and overrides.
	 */
	resolveNamespace(namespace: string, targetScope?: SettingScope): Record<string, ResolvedSetting> {
		const schema = this.getSchemaFn(namespace);
		const result: Record<string, ResolvedSetting> = {};

		if (schema) {
			for (const key of Object.keys(schema.properties)) {
				result[key] = this.resolve(namespace, key, targetScope);
			}
		}

		const userData = this.getUserDataFn();
		const userNs =
			userData && typeof userData[namespace] === 'object' && userData[namespace] !== null
				? userData[namespace]
				: undefined;

		if (userNs) {
			for (const key of Object.keys(userNs)) {
				if (!(key in result)) {
					result[key] = this.resolve(namespace, key, targetScope);
				}
			}
		}

		if (targetScope !== 'user') {
			const wsData = this.getWorkspaceDataFn?.();
			const wsNs =
				wsData && typeof wsData[namespace] === 'object' && wsData[namespace] !== null
					? wsData[namespace]
					: undefined;

			if (wsNs) {
				for (const key of Object.keys(wsNs)) {
					if (!(key in result)) {
						result[key] = this.resolve(namespace, key, targetScope);
					}
				}
			}
		}

		return result;
	}
}

/**
 * Storage interface matching preferences storage.
 */
export interface PreferenceStorageLike {
	getItem(key: string): string | null | Promise<string | null>;
	setItem(key: string, value: string): void | Promise<void>;
}

export interface SettingsRegistryLike {
	registerTransform(pluginId: string, transform: SettingSchemaTransform): void;
	registerSchema(pluginId: string, schema: SettingNamespaceSchema): void;
	removePlugin(pluginId: string): void;
	rebuild(): void;
	refresh(): void;
	getSchema(namespace: string): SettingNamespaceSchema | undefined;
	getAllSchemas(): SettingNamespaceSchema[];
}

export interface SettingsManagerOptions {
	storage?: PreferenceStorageLike;
	storageKey?: string;
	workspaceStorage?: WorkspaceSettingsStorage;
	schemaRegistry?: SettingsRegistryLike;
	initialSchemas?: readonly SettingNamespaceSchema[];
	onDiagnosticsChange?: (diagnostics: readonly SettingDiagnostic[]) => void;
}

/**
 * Manager coordinates stored configuration, schema registry, layered resolution,
 * JSONC editing, and diagnostics across User and Workspace scopes.
 */
export class SettingsManager {
	private storage?: PreferenceStorageLike;
	private storageKey: string;
	private workspaceStorage?: WorkspaceSettingsStorage;
	private schemaRegistry?: SettingsRegistryLike;
	private schemas = new Map<string, SettingNamespaceSchema>();
	private schemaTransforms: SettingSchemaTransformEntry[] = [];
	private storedRawData: Record<string, any> = {};
	private storedRawText: string = '';
	private storedWorkspaceData: Record<string, any> = {};
	private storedWorkspaceText: string = '';
	private currentDiagnostics: SettingDiagnostic[] = [];
	private explicitlyModifiedKeys = new Set<string>();
	private explicitlyModifiedWorkspaceKeys = new Set<string>();
	private onDiagnosticsChange?: (diagnostics: readonly SettingDiagnostic[]) => void;

	readonly resolver: SettingsResolver;

	constructor(options: SettingsManagerOptions = {}) {
		this.storage = options.storage;
		this.storageKey = options.storageKey ?? 'np-prefs-v2';
		this.workspaceStorage = options.workspaceStorage;
		this.schemaRegistry = options.schemaRegistry;
		this.onDiagnosticsChange = options.onDiagnosticsChange;

		this.resolver = new SettingsResolver(
			(ns) => this.getSchema(ns),
			() => this.storedRawData,
			() => this.storedWorkspaceData
		);

		// Register built-in core schemas
		this.registerSchema(CORE_SETTINGS_OWNER, EDITOR_SCHEMA);
		this.registerSchema(CORE_SETTINGS_OWNER, UI_SCHEMA);

		if (options.initialSchemas) {
			for (const s of options.initialSchemas) {
				this.registerSchema('initial', s);
			}
		}

		this.load();
		if (this.workspaceStorage) {
			this.loadWorkspace().catch((e) => console.error('Failed to load initial workspace settings:', e));
		}
	}

	setSchemaRegistry(registry: SettingsRegistryLike): void {
		this.schemaRegistry = registry;
		this.validateAll();
	}

	registerTransform(pluginId: string, transform: SettingSchemaTransform): void {
		this.schemaTransforms.push({ pluginId, transform });
		this.rebuild();
	}

	registerSchema(pluginId: string, schema: SettingNamespaceSchema): void {
		this.registerTransform(pluginId, createAddSettingSchemaTransform(schema));
	}

	removePlugin(pluginId: string): void {
		const kept = this.schemaTransforms.filter((entry) => entry.pluginId !== pluginId);
		if (kept.length !== this.schemaTransforms.length) {
			this.schemaTransforms = kept;
			this.rebuild();
		}
	}

	rebuild(): void {
		this.schemas = rebuildSettingSchemas(this.schemaTransforms);
		this.validateAll();
	}

	refresh(): void {
		this.rebuild();
	}

	getSchema(namespace: string): SettingNamespaceSchema | undefined {
		return this.schemaRegistry?.getSchema(namespace) ?? this.schemas.get(namespace);
	}

	getAllSchemas(): SettingNamespaceSchema[] {
		const map = new Map<string, SettingNamespaceSchema>();
		for (const s of this.schemas.values()) {
			map.set(s.namespace, s);
		}
		if (this.schemaRegistry) {
			for (const s of this.schemaRegistry.getAllSchemas()) {
				map.set(s.namespace, s);
			}
		}
		return Array.from(map.values());
	}

	/**
	 * Reads user settings from storage.
	 */
	load(): void {
		if (!this.storage) return;

		try {
			const raw = this.storage.getItem(this.storageKey);
			if (typeof raw === 'string') {
				this.storedRawText = raw;
				this.loadFromText(raw);
			}
		} catch (err) {
			console.error('Failed to load settings from storage:', err);
		}
	}

	/**
	 * Reads workspace settings from workspace storage.
	 */
	async loadWorkspace(): Promise<void> {
		if (!this.workspaceStorage) return;

		try {
			const raw = await this.workspaceStorage.load();
			if (typeof raw === 'string') {
				this.loadWorkspaceFromText(raw);
			} else {
				this.loadWorkspaceFromText('');
			}
		} catch (err) {
			console.error('Failed to load workspace settings from storage:', err);
		}
	}

	/**
	 * Attaches workspace settings storage and loads its contents.
	 */
	async attachWorkspaceStorage(storage: WorkspaceSettingsStorage): Promise<void> {
		this.workspaceStorage = storage;
		await this.loadWorkspace();
	}

	/**
	 * Detaches workspace storage and clears workspace-level overrides.
	 */
	clearWorkspace(): void {
		this.storedWorkspaceData = {};
		this.storedWorkspaceText = '';
		this.explicitlyModifiedWorkspaceKeys.clear();
		this.workspaceStorage = undefined;
		this.validateAll();
	}

	/**
	 * Loads user settings from text (JSON or JSONC) without writing to storage.
	 */
	loadFromText(rawText: string | null | undefined): void {
		if (!rawText || !rawText.trim()) {
			this.storedRawData = {};
			this.storedRawText = rawText ?? '';
			this.validateAll();
			return;
		}

		this.storedRawText = rawText;
		const parseErrors: ParseError[] = [];
		const parsed = parse(rawText, parseErrors, { allowTrailingComma: true });

		if (parseErrors.length > 0) {
			const errorMessages = parseErrors
				.map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`)
				.join(', ');
			const syntaxDiag: SettingDiagnostic = {
				namespace: 'core',
				key: '$syntax',
				message: `Syntax error in settings document: ${errorMessages}`,
				severity: 'error',
				scope: 'user'
			};
			this.currentDiagnostics = [
				...this.currentDiagnostics.filter((d) => d.scope !== 'user'),
				syntaxDiag
			];
			this.onDiagnosticsChange?.(this.currentDiagnostics);
			return;
		}

		if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
			this.storedRawData = parsed;
		} else {
			this.storedRawData = {};
		}

		this.validateAll();
	}

	/**
	 * Loads workspace settings from text (JSON or JSONC) without writing to storage.
	 */
	loadWorkspaceFromText(rawText: string | null | undefined): void {
		if (!rawText || !rawText.trim()) {
			this.storedWorkspaceData = {};
			this.storedWorkspaceText = rawText ?? '';
			this.validateAll();
			return;
		}

		this.storedWorkspaceText = rawText;
		const parseErrors: ParseError[] = [];
		const parsed = parse(rawText, parseErrors, { allowTrailingComma: true });

		if (parseErrors.length > 0) {
			const errorMessages = parseErrors
				.map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`)
				.join(', ');
			const syntaxDiag: SettingDiagnostic = {
				namespace: 'workspace',
				key: '$syntax',
				message: `Syntax error in workspace settings document: ${errorMessages}`,
				severity: 'error',
				scope: 'workspace'
			};
			this.currentDiagnostics = [
				...this.currentDiagnostics.filter((d) => d.scope !== 'workspace'),
				syntaxDiag
			];
			this.onDiagnosticsChange?.(this.currentDiagnostics);
			return;
		}

		if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
			this.storedWorkspaceData = parsed;
		} else {
			this.storedWorkspaceData = {};
		}

		this.validateAll();
	}

	/**
	 * Validates all stored user and workspace values against current registered schemas.
	 * Collects diagnostics without modifying or resetting stored data.
	 */
	validateAll(): SettingDiagnostic[] {
		const diagnostics: SettingDiagnostic[] = [];
		const allSchemas = this.getAllSchemas();

		for (const schema of allSchemas) {
			const namespace = schema.namespace;
			const userNs = this.storedRawData[namespace];
			const wsNs = this.storedWorkspaceData[namespace];

			for (const [key, propSchema] of Object.entries(schema.properties)) {
				// Validate User data
				let userRawValue: unknown = undefined;
				let userFound = false;

				if (userNs && typeof userNs === 'object' && key in userNs) {
					userRawValue = userNs[key];
					userFound = true;
				} else if (userNs && typeof userNs === 'object' && propSchema.alias) {
					const aliases = Array.isArray(propSchema.alias) ? propSchema.alias : [propSchema.alias];
					for (const alias of aliases) {
						if (alias in userNs) {
							userRawValue = userNs[alias];
							userFound = true;
							break;
						}
					}
				}

				if (!userFound && this.storedRawData) {
					if (key in this.storedRawData) {
						userRawValue = this.storedRawData[key];
						userFound = true;
					} else if (propSchema.alias) {
						const aliases = Array.isArray(propSchema.alias) ? propSchema.alias : [propSchema.alias];
						for (const alias of aliases) {
							if (alias in this.storedRawData) {
								userRawValue = this.storedRawData[alias];
								userFound = true;
								break;
							}
						}
					}
				}

				if (userFound && userRawValue !== undefined) {
					const res = validateSettingValue(namespace, key, userRawValue, propSchema);
					if (!res.valid) {
						diagnostics.push({ ...res.diagnostic, scope: 'user' });
					}
				}

				// Validate Workspace data
				let wsRawValue: unknown = undefined;
				let wsFound = false;

				if (wsNs && typeof wsNs === 'object' && key in wsNs) {
					wsRawValue = wsNs[key];
					wsFound = true;
				} else if (wsNs && typeof wsNs === 'object' && propSchema.alias) {
					const aliases = Array.isArray(propSchema.alias) ? propSchema.alias : [propSchema.alias];
					for (const alias of aliases) {
						if (alias in wsNs) {
							wsRawValue = wsNs[alias];
							wsFound = true;
							break;
						}
					}
				}

				if (wsFound && wsRawValue !== undefined) {
					if (propSchema.scope && !propSchema.scope.includes('workspace')) {
						diagnostics.push({
							namespace,
							key,
							message: `Setting "${namespace}.${key}" cannot be configured in workspace scope`,
							severity: 'warning',
							scope: 'workspace',
							receivedValue: wsRawValue
						});
					} else {
						const res = validateSettingValue(namespace, key, wsRawValue, propSchema);
						if (!res.valid) {
							diagnostics.push({ ...res.diagnostic, scope: 'workspace' });
						}
					}
				}
			}
		}

		this.currentDiagnostics = diagnostics;
		this.onDiagnosticsChange?.(this.currentDiagnostics);
		return diagnostics;
	}

	getDiagnostics(scope?: SettingScope): SettingDiagnostic[] {
		if (scope) {
			return this.currentDiagnostics.filter((d) => d.scope === scope);
		}
		return [...this.currentDiagnostics];
	}

	getDiagnosticsForNamespace(namespace: string, scope?: SettingScope): SettingDiagnostic[] {
		return this.currentDiagnostics.filter(
			(d) => d.namespace === namespace && (!scope || d.scope === scope)
		);
	}

	resolve<T = any>(namespace: string, key: string, targetScope?: SettingScope): ResolvedSetting<T> {
		return this.resolver.resolve<T>(namespace, key, targetScope);
	}

	get<T = any>(namespace: string, key: string, targetScope?: SettingScope): T {
		return this.resolver.get<T>(namespace, key, targetScope);
	}

	/**
	 * Checks if an explicit override exists in the specified scope.
	 */
	hasOverride(namespace: string, key: string, scope: SettingScope = 'workspace'): boolean {
		if (scope === 'workspace') {
			return !!(this.storedWorkspaceData[namespace] && key in this.storedWorkspaceData[namespace]);
		}
		return !!(this.storedRawData[namespace] && key in this.storedRawData[namespace]);
	}

	/**
	 * Sets a setting in the specified scope and persists to the corresponding storage.
	 * IMPORTANT: Inherited values are never materialized into the scope the user is editing.
	 */
	set<T = any>(namespace: string, key: string, value: T, scope: SettingScope = 'user'): void {
		const schema = this.getSchema(namespace);
		const propSchema = schema?.properties[key];

		if (propSchema) {
			if (scope === 'workspace' && propSchema.scope && !propSchema.scope.includes('workspace')) {
				throw new Error(`Setting "${namespace}.${key}" cannot be configured in workspace scope`);
			}
			const validation = validateSettingValue(namespace, key, value, propSchema);
			if (!validation.valid) {
				throw new Error(validation.diagnostic.message);
			}
		}

		if (scope === 'workspace') {
			if (
				typeof this.storedWorkspaceData[namespace] !== 'object' ||
				this.storedWorkspaceData[namespace] === null
			) {
				this.storedWorkspaceData[namespace] = {};
			}
			this.storedWorkspaceData[namespace][key] = value;
			this.explicitlyModifiedWorkspaceKeys.add(`${namespace}.${key}`);
			this.validateAll();
			this.saveWorkspace().catch((e) => console.error('Failed to save workspace settings:', e));
		} else {
			if (
				typeof this.storedRawData[namespace] !== 'object' ||
				this.storedRawData[namespace] === null
			) {
				this.storedRawData[namespace] = {};
			}
			this.storedRawData[namespace][key] = value;
			this.explicitlyModifiedKeys.add(`${namespace}.${key}`);
			this.validateAll();
			this.save();
		}
	}

	/**
	 * Removes a setting override from the specified scope so it falls back to the parent scope.
	 */
	unset(namespace: string, key: string, scope: SettingScope = 'workspace'): void {
		if (scope === 'workspace') {
			if (
				this.storedWorkspaceData[namespace] &&
				typeof this.storedWorkspaceData[namespace] === 'object'
			) {
				delete this.storedWorkspaceData[namespace][key];
				if (Object.keys(this.storedWorkspaceData[namespace]).length === 0) {
					delete this.storedWorkspaceData[namespace];
				}
				this.explicitlyModifiedWorkspaceKeys.delete(`${namespace}.${key}`);
				this.storedWorkspaceText =
					Object.keys(this.storedWorkspaceData).length > 0
						? JSON.stringify(this.storedWorkspaceData, null, 2)
						: '';
				this.validateAll();
				this.saveWorkspace().catch((e) => console.error('Failed to save workspace settings:', e));
			}
		} else {
			if (this.storedRawData[namespace] && typeof this.storedRawData[namespace] === 'object') {
				delete this.storedRawData[namespace][key];
				if (Object.keys(this.storedRawData[namespace]).length === 0) {
					delete this.storedRawData[namespace];
				}
				this.explicitlyModifiedKeys.delete(`${namespace}.${key}`);
				this.storedRawText =
					Object.keys(this.storedRawData).length > 0
						? JSON.stringify(this.storedRawData, null, 2)
						: '';
				this.validateAll();
				this.save();
			}
		}
	}

	/**
	 * Returns the complete stored document object for user settings.
	 */
	getStoredDocument(): Record<string, any> {
		return { ...this.storedRawData };
	}

	/**
	 * Returns the complete stored document object for workspace settings.
	 */
	getWorkspaceDocument(): Record<string, any> {
		return { ...this.storedWorkspaceData };
	}

	/**
	 * Returns the workspace raw text.
	 */
	getWorkspaceText(): string {
		return this.storedWorkspaceText;
	}

	/**
	 * Persists user settings to storage while preserving comments and unknown namespaces.
	 */
	private save(): void {
		if (!this.storage) return;

		try {
			let updatedText = this.storedRawText;

			if (updatedText && updatedText.trim()) {
				for (const [namespace, nsData] of Object.entries(this.storedRawData)) {
					if (typeof nsData === 'object' && nsData !== null && !Array.isArray(nsData)) {
						for (const [key, val] of Object.entries(nsData)) {
							if (this.explicitlyModifiedKeys.has(`${namespace}.${key}`)) {
								updatedText = applySettingEditToJsonc(updatedText, [namespace, key], val);
							}
						}
					}
				}
				this.storedRawText = updatedText;
				this.storage.setItem(this.storageKey, updatedText);
			} else {
				const json = JSON.stringify(this.storedRawData, null, 2);
				this.storedRawText = json;
				this.storage.setItem(this.storageKey, json);
			}
		} catch (err) {
			console.error('Failed to save settings:', err);
		}
	}

	/**
	 * Persists workspace settings to workspace storage while preserving comments.
	 */
	async saveWorkspace(): Promise<void> {
		if (!this.workspaceStorage) return;

		try {
			let updatedText = this.storedWorkspaceText;

			if (updatedText && updatedText.trim()) {
				for (const [namespace, nsData] of Object.entries(this.storedWorkspaceData)) {
					if (typeof nsData === 'object' && nsData !== null && !Array.isArray(nsData)) {
						for (const [key, val] of Object.entries(nsData)) {
							if (this.explicitlyModifiedWorkspaceKeys.has(`${namespace}.${key}`)) {
								updatedText = applySettingEditToJsonc(updatedText, [namespace, key], val);
							}
						}
					}
				}
				this.storedWorkspaceText = updatedText;
			} else {
				const json =
					Object.keys(this.storedWorkspaceData).length > 0
						? JSON.stringify(this.storedWorkspaceData, null, 2)
						: '';
				this.storedWorkspaceText = json;
			}

			await this.workspaceStorage.save(this.storedWorkspaceText);
		} catch (err) {
			console.error('Failed to save workspace settings:', err);
		}
	}
}

/**
 * Storage adapter for workspace .np/settings.json file.
 */
export class FileWorkspaceSettingsStorage implements WorkspaceSettingsStorage {
	constructor(
		private readonly storage: any,
		private readonly rootOrigin: any
	) {}

	private getSettingsOrigin(): any {
		const rootPath = (this.rootOrigin?.path ?? '').replace(/\/+$/, '');
		return {
			scheme: this.rootOrigin?.scheme ?? 'file',
			path: `${rootPath}/${WORKSPACE_SETTINGS_RELATIVE_PATH}`,
			name: 'settings.json'
		};
	}

	async load(): Promise<string | null> {
		try {
			const origin = this.getSettingsOrigin();
			return await this.storage.readFile(origin);
		} catch {
			return null;
		}
	}

	async save(content: string): Promise<void> {
		try {
			const origin = this.getSettingsOrigin();
			if (typeof this.storage.createDirectory === 'function') {
				try {
					await this.storage.createDirectory(this.rootOrigin, '.np');
				} catch {
					// directory might already exist
				}
			}
			await this.storage.saveFile(content, origin);
		} catch (err) {
			console.error('Failed to save workspace settings to storage:', err);
		}
	}
}
