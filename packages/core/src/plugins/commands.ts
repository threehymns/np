/**
 * Transform-based command registry primitives (ADR 0012, ADR 0015).
 *
 * Every registry that multiple plugins contribute to rebuilds by replaying
 * registered transform functions in order from an empty initial value on
 * every change. Plugins describe their changes; the host decides when to
 * apply them. A removed plugin's transforms are dropped and the registry
 * rebuilds without them; a data refresh replays the same transforms and
 * therefore cannot duplicate or lose commands.
 *
 * This module is intentionally pure: no Svelte runes, no CodeMirror, no
 * AppState, no Node APIs. Both the standalone `CommandRegistry`
 * (unit tests, mock AppStates) and the `PluginHost` (canonical registry
 * backing `AppState.commands`) replay through `rebuildCommands`, so their
 * behavior is identical by construction. Reactivity lives in the wrappers
 * (`$state` Maps); the replay logic here is synchronously testable.
 *
 * Transforms must be pure functions of their inputs and repeatable: no
 * side effects, no UI mounting, no document mutations (ADR 0012).
 */

/** Owner ID for commands registered synchronously by the host app itself. */
export const CORE_COMMANDS_OWNER = 'core';

export interface PluginCommand {
	id: string;
	label: string;
	category: string;
	action: (...args: any[]) => any;
	isVisible?: () => boolean;
	isEnabled?: () => boolean;
}

/**
 * A pure, repeatable description of one contribution to the shared command
 * registry. Receives the accumulated state so far, returns the next state.
 * Must not mutate its input; return a new Map instead.
 */
export type CommandTransform = (
	prev: ReadonlyMap<string, PluginCommand>
) => ReadonlyMap<string, PluginCommand>;

export interface CommandTransformEntry {
	readonly pluginId: string;
	readonly transform: CommandTransform;
}

/**
 * Actionable diagnostic thrown when two owners contribute the same command
 * ID (ADR 0007). Same-owner re-registration (e.g. a refresh with fresh
 * action closures) is allowed and last-wins; cross-owner overwrites are
 * rejected so a removed plugin's absence is deterministic.
 */
export class DuplicateCommandIdError extends Error {
	readonly commandId: string;
	readonly existingPluginId: string;
	readonly incomingPluginId: string;

	constructor(commandId: string, existingPluginId: string, incomingPluginId: string) {
		super(
			`Duplicate command ID "${commandId}" contributed by both "${existingPluginId}" and "${incomingPluginId}".\n` +
				`Action: Every command must declare a unique "id". Rename the incoming command ID or ` +
				`remove the conflicting contribution before rebuilding the registry.`
		);
		this.name = 'DuplicateCommandIdError';
		this.commandId = commandId;
		this.existingPluginId = existingPluginId;
		this.incomingPluginId = incomingPluginId;
	}
}

/**
 * Creates a transform that adds the given commands to the accumulated state.
 * The input array is defensively copied so later mutations by the caller
 * cannot change replay results (repeatability).
 */
export function createAddCommandsTransform(commands: readonly PluginCommand[]): CommandTransform {
	const snapshot = [...commands];
	return (prev) => {
		const next = new Map(prev);
		for (const command of snapshot) {
			next.set(command.id, command);
		}
		return next;
	};
}

/**
 * Replays transform entries in order from an empty initial value.
 * Pure and repeatable: the same entry list always yields an equal Map with
 * equal insertion order, so refresh-mid-session rebuilds produce no
 * duplicates or losses, and dropping one plugin's entries yields exactly
 * the registry a clean build without it would produce.
 *
 * @throws {DuplicateCommandIdError} when a transform overwrites a command
 * ID owned by a different plugin with a different command object.
 */
export function rebuildCommands(transforms: readonly CommandTransformEntry[]): Map<string, PluginCommand> {
	let state = new Map<string, PluginCommand>();
	const owners = new Map<string, string>();

	for (const entry of transforms) {
		// Defensive copy: an impure transform that mutates its input cannot
		// corrupt the accumulated state, keeping replays deterministic.
		const input = new Map(state);
		const result = entry.transform(input);
		const next = result instanceof Map ? new Map(result) : new Map<string, PluginCommand>();

		for (const [id, command] of next) {
			const prevCommand = state.get(id);
			if (prevCommand === undefined) {
				const owner = owners.get(id);
				if (owner !== undefined && owner !== entry.pluginId) {
					throw new DuplicateCommandIdError(id, owner, entry.pluginId);
				}
				owners.set(id, entry.pluginId);
			} else if (prevCommand !== command) {
				const owner = owners.get(id);
				if (owner !== undefined && owner !== entry.pluginId) {
					throw new DuplicateCommandIdError(id, owner, entry.pluginId);
				}
				owners.set(id, entry.pluginId);
			}
		}

		for (const id of state.keys()) {
			if (!next.has(id)) {
				owners.delete(id);
			}
		}

		state = next;
	}

	return state;
}

/**
 * Structural interface shared by the standalone `CommandRegistry` and the
 * host-backed `AppState.commands` facade. Palette, menus, keymaps, and
 * `registerCoreCommands` program against this shape so both implementations
 * stay interchangeable views over the same replay semantics.
 */
export interface CommandRegistryLike {
	registerTransform(pluginId: string, transform: CommandTransform): void;
	registerCommands(pluginId: string, commands: readonly PluginCommand[]): void;
	removePlugin(pluginId: string): void;
	rebuild(): void;
	refresh(): void;
	get(id: string): PluginCommand | undefined;
	getAll(): PluginCommand[];
	getByCategory(category: string): PluginCommand[];
	execute(id: string, ...args: any[]): any;
}
