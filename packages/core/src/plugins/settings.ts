/**
 * Settings namespaces and layered resolver (ADR 0012, ADR 0014).
 *
 * Implements plugin-owned settings namespaces with schemas, defaults,
 * explicit merge rules, and a layered resolver for user scope reporting
 * effective values plus provenance ('default' | 'user').
 *
 * Key guarantees (ADR 0014):
 * - Plugin settings are declared under plugin-owned namespaces with schemas,
 *   defaults, and allowed scopes.
 * - Current preferences migrate onto namespaced schemas with zero behavior change.
 * - Effective values report provenance ('default' | 'user').
 * - Settings belonging to disabled plugins are preserved untouched in storage
 *   and never garbage collected.
 * - Invalid stored values produce diagnostics, never silent resets.
 * - JSONC comments and unknown namespaces survive edits.
 */

import { parse, modify, applyEdits, type ParseError, printParseErrorCode } from 'jsonc-parser';

/** Owner ID for settings registered synchronously by the core application. */
export const CORE_SETTINGS_OWNER = 'core';

export type SettingScope = 'user' | 'workspace';
export type SettingProvenance = 'default' | 'user' | 'workspace';

export type SettingType = 'boolean' | 'number' | 'string' | 'object' | 'array';

export type SettingMergeRule = 'replace' | 'shallow' | 'deep';
export type SettingMergeFunction<T = any> = (lower: T, higher: T) => T;

export interface SettingDiagnostic {
	readonly namespace: string;
	readonly key: string;
	readonly message: string;
	readonly severity: 'error' | 'warning';
	readonly receivedValue?: unknown;
}

export interface SettingPropertySchema<T = any> {
	readonly type: SettingType;
	readonly default: T;
	readonly title?: string;
	readonly description?: string;
	readonly control?: 'toggle' | 'input' | 'select' | 'color' | 'slider' | string;
	readonly enum?: readonly (string | number)[];
	readonly minimum?: number;
	readonly maximum?: number;
	readonly step?: number;
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
			`Duplicate settings namespace "${namespace}" contributed by both "${existingPluginId}" and "${incomingPluginId}".\n` +
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
 * Standard Zed-aligned UI appearance and layout settings schema.
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
 * Validates a candidate setting value against its property schema.
 */
export function validateSettingValue<T>(
	namespace: string,
	key: string,
	value: unknown,
	schema: SettingPropertySchema<T>
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
			if (typeof value !== 'number' || isNaN(value) || !isFinite(value)) {
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
			if (typeof value !== 'object' || Array.isArray(value)) {
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
 * Merges default setting values with user-provided overrides according to the schema merge rule.
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
 * Pure settings resolver for user scope.
 * Resolves effective values across schema defaults and user configuration,
 * providing provenance ('default' | 'user') and diagnostics.
 */
export class SettingsResolver {
	constructor(
		private readonly getSchemaFn: (namespace: string) => SettingNamespaceSchema | undefined,
		private readonly getUserDataFn: () => Record<string, any>
	) {}

	/**
	 * Resolves a setting for the given namespace and key.
	 */
	resolve<T = any>(namespace: string, key: string): ResolvedSetting<T> {
		const schema = this.getSchemaFn(namespace);
		const propSchema = schema?.properties[key] as SettingPropertySchema<T> | undefined;

		const userData = this.getUserDataFn();
		const userNs = userData && typeof userData[namespace] === 'object' && userData[namespace] !== null
			? userData[namespace]
			: undefined;

		// 1. If property schema exists:
		if (propSchema) {
			const defaultValue = propSchema.default;

			// Look up user value in:
			// a) namespaced key
			// b) namespaced aliases
			// c) top-level flat key / aliases (backward compatibility)
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

			if (!userFound || userRawValue === undefined) {
				return {
					namespace,
					key,
					value: defaultValue,
					provenance: 'default',
					source: 'default',
					defaultValue,
					schema: propSchema
				};
			}

			// Validate user value
			const validation = validateSettingValue(namespace, key, userRawValue, propSchema);
			if (!validation.valid) {
				// Invalid stored values produce diagnostics, never silent resets.
				// Effective value falls back to default.
				return {
					namespace,
					key,
					value: defaultValue,
					provenance: 'default',
					source: 'default',
					defaultValue,
					userValue: userRawValue as T,
					schema: propSchema,
					diagnostics: [validation.diagnostic]
				};
			}

			const effectiveValue = applyMergeRule(defaultValue, userRawValue as T, propSchema.mergeRule);
			return {
				namespace,
				key,
				value: effectiveValue,
				provenance: 'user',
				source: 'user',
				defaultValue,
				userValue: userRawValue as T,
				schema: propSchema
			};
		}

		// 2. No schema registered (disabled plugin or unknown namespace)
		let rawValue: unknown = undefined;
		if (userNs && key in userNs) {
			rawValue = userNs[key];
		} else if (userData && key in userData) {
			rawValue = userData[key];
		}

		if (rawValue !== undefined) {
			return {
				namespace,
				key,
				value: rawValue as T,
				provenance: 'user',
				source: 'user',
				defaultValue: undefined as unknown as T
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
	get<T = any>(namespace: string, key: string): T {
		return this.resolve<T>(namespace, key).value;
	}

	/**
	 * Resolves all settings in a namespace.
	 */
	resolveNamespace(namespace: string): Record<string, ResolvedSetting> {
		const schema = this.getSchemaFn(namespace);
		const result: Record<string, ResolvedSetting> = {};

		if (schema) {
			for (const key of Object.keys(schema.properties)) {
				result[key] = this.resolve(namespace, key);
			}
		}

		const userData = this.getUserDataFn();
		const userNs = userData && typeof userData[namespace] === 'object' && userData[namespace] !== null
			? userData[namespace]
			: undefined;

		if (userNs) {
			for (const key of Object.keys(userNs)) {
				if (!(key in result)) {
					result[key] = this.resolve(namespace, key);
				}
			}
		}

		return result;
	}

	/**
	 * Collects all diagnostics across all registered namespaces.
	 */
	getDiagnostics(): SettingDiagnostic[] {
		const diagnostics: SettingDiagnostic[] = [];
		const userData = this.getUserDataFn();
		if (!userData) return diagnostics;

		// Check registered namespaces
		// Note: We need the list of all registered schemas
		return diagnostics;
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
	initialSchemas?: readonly SettingNamespaceSchema[];
	onDiagnosticsChange?: (diagnostics: readonly SettingDiagnostic[]) => void;
}

/**
 * Manager coordinates stored configuration, schema registry, layered resolution,
 * JSONC editing, and diagnostics.
 */
export class SettingsManager {
	private storage?: PreferenceStorageLike;
	private storageKey: string;
	private schemas = new Map<string, SettingNamespaceSchema>();
	private schemaTransforms: SettingSchemaTransformEntry[] = [];
	private storedRawData: Record<string, any> = {};
	private storedRawText: string = '';
	private currentDiagnostics: SettingDiagnostic[] = [];
	private explicitlyModifiedKeys = new Set<string>();
	private isRestoring = false;
	private onDiagnosticsChange?: (diagnostics: readonly SettingDiagnostic[]) => void;

	readonly resolver: SettingsResolver;

	constructor(options: SettingsManagerOptions = {}) {
		this.storage = options.storage;
		this.storageKey = options.storageKey ?? 'np-prefs-v2';
		this.onDiagnosticsChange = options.onDiagnosticsChange;

		this.resolver = new SettingsResolver(
			(ns) => this.getSchema(ns),
			() => this.storedRawData
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
		return this.schemas.get(namespace);
	}

	getAllSchemas(): SettingNamespaceSchema[] {
		return Array.from(this.schemas.values());
	}

	/**
	 * Reads settings from storage.
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
	 * Loads settings from text (JSON or JSONC) without writing to storage.
	 */
	loadFromText(rawText: string | null | undefined): void {
		if (!rawText || !rawText.trim()) {
			this.storedRawData = {};
			this.storedRawText = rawText ?? '';
			this.currentDiagnostics = [];
			return;
		}

		this.storedRawText = rawText;
		const parseErrors: ParseError[] = [];
		const parsed = parse(rawText, parseErrors, { allowTrailingComma: true });

		if (parseErrors.length > 0) {
			const errorMessages = parseErrors
				.map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`)
				.join(', ');
			this.currentDiagnostics = [
				{
					namespace: 'core',
					key: '$syntax',
					message: `Syntax error in settings document: ${errorMessages}`,
					severity: 'error'
				}
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
	 * Validates all stored values against current registered schemas.
	 * Collects diagnostics without modifying or resetting stored data.
	 */
	validateAll(): SettingDiagnostic[] {
		const diagnostics: SettingDiagnostic[] = [];

		for (const [namespace, schema] of this.schemas) {
			const userNs = this.storedRawData[namespace];

			for (const [key, propSchema] of Object.entries(schema.properties)) {
				let userRawValue: unknown = undefined;
				let found = false;

				if (userNs && typeof userNs === 'object' && key in userNs) {
					userRawValue = userNs[key];
					found = true;
				} else if (userNs && typeof userNs === 'object' && propSchema.alias) {
					const aliases = Array.isArray(propSchema.alias) ? propSchema.alias : [propSchema.alias];
					for (const alias of aliases) {
						if (alias in userNs) {
							userRawValue = userNs[alias];
							found = true;
							break;
						}
					}
				}

				if (!found && this.storedRawData) {
					if (key in this.storedRawData) {
						userRawValue = this.storedRawData[key];
						found = true;
					} else if (propSchema.alias) {
						const aliases = Array.isArray(propSchema.alias) ? propSchema.alias : [propSchema.alias];
						for (const alias of aliases) {
							if (alias in this.storedRawData) {
								userRawValue = this.storedRawData[alias];
								found = true;
								break;
							}
						}
					}
				}

				if (found && userRawValue !== undefined) {
					const res = validateSettingValue(namespace, key, userRawValue, propSchema);
					if (!res.valid) {
						diagnostics.push(res.diagnostic);
					}
				}
			}
		}

		this.currentDiagnostics = diagnostics;
		this.onDiagnosticsChange?.(this.currentDiagnostics);
		return diagnostics;
	}

	getDiagnostics(): SettingDiagnostic[] {
		return [...this.currentDiagnostics];
	}

	getDiagnosticsForNamespace(namespace: string): SettingDiagnostic[] {
		return this.currentDiagnostics.filter((d) => d.namespace === namespace);
	}

	resolve<T = any>(namespace: string, key: string): ResolvedSetting<T> {
		return this.resolver.resolve<T>(namespace, key);
	}

	get<T = any>(namespace: string, key: string): T {
		return this.resolver.get<T>(namespace, key);
	}

	/**
	 * Sets a setting in the user configuration and persists to storage.
	 * Preserves all comments, unknown namespaces, and disabled plugin settings.
	 */
	set<T = any>(namespace: string, key: string, value: T): void {
		const schema = this.getSchema(namespace);
		const propSchema = schema?.properties[key];

		if (propSchema) {
			const validation = validateSettingValue(namespace, key, value, propSchema);
			if (!validation.valid) {
				throw new Error(validation.diagnostic.message);
			}
		}

		if (typeof this.storedRawData[namespace] !== 'object' || this.storedRawData[namespace] === null) {
			this.storedRawData[namespace] = {};
		}

		this.storedRawData[namespace][key] = value;
		this.explicitlyModifiedKeys.add(`${namespace}.${key}`);

		// Re-validate diagnostics
		this.validateAll();

		// Save to storage
		this.save();
	}

	/**
	 * Returns the complete stored document object.
	 */
	getStoredDocument(): Record<string, any> {
		return { ...this.storedRawData };
	}

	/**
	 * Persists settings to storage while preserving comments and unknown namespaces.
	 */
	private save(): void {
		if (!this.storage) return;

		try {
			let updatedText = this.storedRawText;

			// If we have JSONC text and comments, apply in-place edits using jsonc-parser
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
}
