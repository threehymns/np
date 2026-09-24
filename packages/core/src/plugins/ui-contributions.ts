/**
 * Additive UI contributions over the plugin host (ADR 0010, ADR 0012, ADR 0015).
 *
 * Contributed sidebar panels and status-bar entries have typed inputs, explicit
 * ordering, and host-controlled mounting and teardown. No plugin contribution may
 * suppress another's in the first version (additive first).
 *
 * Every registry rebuilds by replaying registered transforms in order from an
 * empty initial value on every change. A removed plugin's transforms are dropped
 * and the registry rebuilds without them, leaving no residue.
 */

/** Owner ID for UI contributions registered synchronously by the host app itself. */
export const CORE_UI_OWNER = 'core';

export type StatusBarAlignment = 'left' | 'right';

/**
 * Sidebar panel contribution declaration (ADR 0010, ADR 0015).
 */
export interface SidebarPanelContribution<Props extends Record<string, any> = Record<string, any>> {
	readonly id: string;
	readonly title: string;
	readonly icon?: any;
	readonly order: number;
	readonly component: any;
	readonly props?: Props;
	readonly pluginId?: string;
}

/**
 * Status bar item contribution declaration (ADR 0010, ADR 0015).
 */
export interface StatusBarItemContribution<Props extends Record<string, any> = Record<string, any>> {
	readonly id: string;
	readonly alignment: StatusBarAlignment;
	readonly order: number;
	readonly component: any;
	readonly props?: Props;
	readonly pluginId?: string;
}

/**
 * Actionable diagnostic thrown when two owners contribute the same sidebar panel ID (ADR 0007, ADR 0015).
 */
export class DuplicateSidebarPanelIdError extends Error {
	readonly panelId: string;
	readonly existingPluginId: string;
	readonly incomingPluginId: string;

	constructor(panelId: string, existingPluginId: string, incomingPluginId: string) {
		super(
			`Duplicate sidebar panel ID "${panelId}" contributed by both "${existingPluginId}" and "${incomingPluginId}".\n` +
				`Action: Every sidebar panel must declare a unique "id". Rename the incoming panel ID or ` +
				`remove the conflicting contribution before rebuilding the registry.`
		);
		this.name = 'DuplicateSidebarPanelIdError';
		this.panelId = panelId;
		this.existingPluginId = existingPluginId;
		this.incomingPluginId = incomingPluginId;
	}
}

/**
 * Actionable diagnostic thrown when two owners contribute the same status bar item ID (ADR 0007, ADR 0015).
 */
export class DuplicateStatusBarItemIdError extends Error {
	readonly itemId: string;
	readonly existingPluginId: string;
	readonly incomingPluginId: string;

	constructor(itemId: string, existingPluginId: string, incomingPluginId: string) {
		super(
			`Duplicate status bar item ID "${itemId}" contributed by both "${existingPluginId}" and "${incomingPluginId}".\n` +
				`Action: Every status bar item must declare a unique "id". Rename the incoming item ID or ` +
				`remove the conflicting contribution before rebuilding the registry.`
		);
		this.name = 'DuplicateStatusBarItemIdError';
		this.itemId = itemId;
		this.existingPluginId = existingPluginId;
		this.incomingPluginId = incomingPluginId;
	}
}

/**
 * Validates a sidebar panel contribution. Throws an actionable error if any required field is missing.
 */
export function validateSidebarPanelContribution(panel: SidebarPanelContribution): void {
	if (!panel || typeof panel !== 'object') {
		throw new Error('Sidebar panel contribution must be an object.');
	}
	if (!panel.id || typeof panel.id !== 'string') {
		throw new Error('Sidebar panel contribution must declare a non-empty string "id".');
	}
	if (typeof panel.title !== 'string') {
		throw new Error(`Sidebar panel "${panel.id}" must declare a string "title".`);
	}
	if (typeof panel.order !== 'number' || Number.isNaN(panel.order)) {
		throw new Error(`Sidebar panel "${panel.id}" must declare a numeric "order".`);
	}
	if (!panel.component) {
		throw new Error(`Sidebar panel "${panel.id}" must declare a "component".`);
	}
}

/**
 * Validates a status bar item contribution. Throws an actionable error if any required field is missing.
 */
export function validateStatusBarItemContribution(item: StatusBarItemContribution): void {
	if (!item || typeof item !== 'object') {
		throw new Error('Status bar item contribution must be an object.');
	}
	if (!item.id || typeof item.id !== 'string') {
		throw new Error('Status bar item contribution must declare a non-empty string "id".');
	}
	if (item.alignment !== 'left' && item.alignment !== 'right') {
		throw new Error(`Status bar item "${item.id}" must declare alignment 'left' | 'right'. Received "${item.alignment}".`);
	}
	if (typeof item.order !== 'number' || Number.isNaN(item.order)) {
		throw new Error(`Status bar item "${item.id}" must declare a numeric "order".`);
	}
	if (!item.component) {
		throw new Error(`Status bar item "${item.id}" must declare a "component".`);
	}
}

/**
 * Deterministic comparison for sidebar panels:
 * 1. Ascending by explicit `order`
 * 2. Deterministic tie-breaking by `id` (alphabetical)
 */
export function compareSidebarPanels(a: SidebarPanelContribution, b: SidebarPanelContribution): number {
	if (a.order !== b.order) {
		return a.order - b.order;
	}
	return a.id.localeCompare(b.id);
}

/**
 * Deterministic comparison for status bar items:
 * 1. Alignment ('left' before 'right')
 * 2. Ascending by explicit `order`
 * 3. Deterministic tie-breaking by `id` (alphabetical)
 */
export function compareStatusBarItems(a: StatusBarItemContribution, b: StatusBarItemContribution): number {
	if (a.alignment !== b.alignment) {
		return a.alignment === 'left' ? -1 : 1;
	}
	if (a.order !== b.order) {
		return a.order - b.order;
	}
	return a.id.localeCompare(b.id);
}

export type SidebarPanelTransform = (
	prev: ReadonlyMap<string, SidebarPanelContribution>
) => ReadonlyMap<string, SidebarPanelContribution>;

export interface SidebarPanelTransformEntry {
	readonly pluginId: string;
	readonly transform: SidebarPanelTransform;
}

export type StatusBarItemTransform = (
	prev: ReadonlyMap<string, StatusBarItemContribution>
) => ReadonlyMap<string, StatusBarItemContribution>;

export interface StatusBarItemTransformEntry {
	readonly pluginId: string;
	readonly transform: StatusBarItemTransform;
}

export function createAddSidebarPanelsTransform(
	panels: readonly SidebarPanelContribution[],
	pluginId: string
): SidebarPanelTransform {
	const snapshot = panels.map((p) => {
		validateSidebarPanelContribution(p);
		return { ...p, pluginId };
	});
	return (prev) => {
		const next = new Map(prev);
		for (const panel of snapshot) {
			next.set(panel.id, panel);
		}
		return next;
	};
}

export function createAddStatusBarItemsTransform(
	items: readonly StatusBarItemContribution[],
	pluginId: string
): StatusBarItemTransform {
	const snapshot = items.map((item) => {
		validateStatusBarItemContribution(item);
		return { ...item, pluginId };
	});
	return (prev) => {
		const next = new Map(prev);
		for (const item of snapshot) {
			next.set(item.id, item);
		}
		return next;
	};
}

/**
 * Replays sidebar panel transforms from an empty initial value.
 *
 * @throws {DuplicateSidebarPanelIdError} when a transform overwrites a panel ID owned by a different plugin.
 */
export function rebuildSidebarPanels(
	transforms: readonly SidebarPanelTransformEntry[]
): Map<string, SidebarPanelContribution> {
	let state = new Map<string, SidebarPanelContribution>();
	const owners = new Map<string, string>();

	for (const entry of transforms) {
		const input = new Map(state);
		const result = entry.transform(input);
		const next = result instanceof Map ? new Map(result) : new Map<string, SidebarPanelContribution>();

		for (const [id, panel] of next) {
			const prev = state.get(id);
			if (prev === undefined || prev !== panel) {
				const owner = owners.get(id);
				if (owner !== undefined && owner !== entry.pluginId) {
					throw new DuplicateSidebarPanelIdError(id, owner, entry.pluginId);
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
 * Replays status bar item transforms from an empty initial value.
 *
 * @throws {DuplicateStatusBarItemIdError} when a transform overwrites a status item ID owned by a different plugin.
 */
export function rebuildStatusBarItems(
	transforms: readonly StatusBarItemTransformEntry[]
): Map<string, StatusBarItemContribution> {
	let state = new Map<string, StatusBarItemContribution>();
	const owners = new Map<string, string>();

	for (const entry of transforms) {
		const input = new Map(state);
		const result = entry.transform(input);
		const next = result instanceof Map ? new Map(result) : new Map<string, StatusBarItemContribution>();

		for (const [id, item] of next) {
			const prev = state.get(id);
			if (prev === undefined || prev !== item) {
				const owner = owners.get(id);
				if (owner !== undefined && owner !== entry.pluginId) {
					throw new DuplicateStatusBarItemIdError(id, owner, entry.pluginId);
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
 * Host-managed mounted contribution instance tracking (ADR 0010).
 */
export interface MountedContribution<Props extends Record<string, any> = Record<string, any>> {
	readonly instanceId: string;
	readonly contributionId: string;
	readonly pluginId: string;
	readonly kind: 'sidebar-panel' | 'status-bar-item';
	readonly target: any;
	readonly instance: any;
	props: Props;
	update(newProps: Partial<Props>): void;
	unmount(): void;
}

/**
 * Structural interface for the UI contributions registry.
 */
export interface UIContributionRegistryLike {
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

	mountContribution(
		pluginId: string,
		contributionId: string,
		target: any,
		props?: Record<string, any>
	): MountedContribution;
	unmountContribution(instanceId: string): void;
	unmountAllPluginContributions(pluginId: string): void;
	getMountedContributions(pluginId?: string): MountedContribution[];

	rebuild(): void;
	removePlugin(pluginId: string): void;
}

/**
 * Standalone UI contribution registry for testing and headless usage.
 */
export class UIContributionRegistry implements UIContributionRegistryLike {
	private panelTransforms: SidebarPanelTransformEntry[] = [];
	private statusTransforms: StatusBarItemTransformEntry[] = [];

	private panelMap = new Map<string, SidebarPanelContribution>();
	private statusMap = new Map<string, StatusBarItemContribution>();
	private mountedMap = new Map<string, MountedContribution>();
	private nextInstanceSeq = 1;

	registerSidebarPanel(pluginId: string, panel: SidebarPanelContribution): void {
		this.registerSidebarPanels(pluginId, [panel]);
	}

	registerSidebarPanels(pluginId: string, panels: readonly SidebarPanelContribution[]): void {
		const entry = {
			pluginId,
			transform: createAddSidebarPanelsTransform(panels, pluginId)
		};
		const nextTransforms = [...this.panelTransforms, entry];
		const nextMap = rebuildSidebarPanels(nextTransforms);
		this.panelTransforms = nextTransforms;
		this.panelMap = nextMap;
	}

	removePluginSidebarPanels(pluginId: string): void {
		const kept = this.panelTransforms.filter((e) => e.pluginId !== pluginId);
		if (kept.length !== this.panelTransforms.length) {
			this.panelTransforms = kept;
			this.rebuild();
		}
	}

	getSidebarPanel(id: string): SidebarPanelContribution | undefined {
		return this.panelMap.get(id);
	}

	getSidebarPanels(): SidebarPanelContribution[] {
		return Array.from(this.panelMap.values()).sort(compareSidebarPanels);
	}

	registerStatusBarItem(pluginId: string, item: StatusBarItemContribution): void {
		this.registerStatusBarItems(pluginId, [item]);
	}

	registerStatusBarItems(pluginId: string, items: readonly StatusBarItemContribution[]): void {
		const entry = {
			pluginId,
			transform: createAddStatusBarItemsTransform(items, pluginId)
		};
		const nextTransforms = [...this.statusTransforms, entry];
		const nextMap = rebuildStatusBarItems(nextTransforms);
		this.statusTransforms = nextTransforms;
		this.statusMap = nextMap;
	}

	removePluginStatusBarItems(pluginId: string): void {
		const kept = this.statusTransforms.filter((e) => e.pluginId !== pluginId);
		if (kept.length !== this.statusTransforms.length) {
			this.statusTransforms = kept;
			this.rebuild();
		}
	}

	getStatusBarItem(id: string): StatusBarItemContribution | undefined {
		return this.statusMap.get(id);
	}

	getStatusBarItems(alignment?: StatusBarAlignment): StatusBarItemContribution[] {
		const items = Array.from(this.statusMap.values());
		const filtered = alignment ? items.filter((i) => i.alignment === alignment) : items;
		return filtered.sort(compareStatusBarItems);
	}

	rebuild(): void {
		const nextPanelMap = rebuildSidebarPanels(this.panelTransforms);
		const nextStatusMap = rebuildStatusBarItems(this.statusTransforms);
		this.panelMap = nextPanelMap;
		this.statusMap = nextStatusMap;
	}

	removePlugin(pluginId: string): void {
		this.unmountAllPluginContributions(pluginId);
		this.removePluginSidebarPanels(pluginId);
		this.removePluginStatusBarItems(pluginId);
	}

	mountContribution(
		pluginId: string,
		contributionId: string,
		target: any,
		props?: Record<string, any>
	): MountedContribution {
		const panel = this.panelMap.get(contributionId);
		const statusItem = this.statusMap.get(contributionId);
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

		const instanceId = `inst-${this.nextInstanceSeq++}`;
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

		this.mountedMap.set(instanceId, mounted);
		return mounted;
	}

	unmountContribution(instanceId: string): void {
		const mounted = this.mountedMap.get(instanceId);
		if (!mounted) return;

		this.mountedMap.delete(instanceId);
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
		for (const [id, mounted] of Array.from(this.mountedMap.entries())) {
			if (mounted.pluginId === pluginId) {
				this.unmountContribution(id);
			}
		}
	}

	getMountedContributions(pluginId?: string): MountedContribution[] {
		const all = Array.from(this.mountedMap.values());
		return pluginId ? all.filter((m) => m.pluginId === pluginId) : all;
	}
}

/**
 * Creates a pilot component for testing and contract verification.
 * Supports rendering into a target node, updating props, and unmounting with no residue.
 */
export function createPilotComponent(name = 'pilot-panel') {
	return function PilotComponent(targetOrAnchor: any, props: Record<string, any> = {}) {
		let currentProps = { ...props };
		let rendered = true;
		let updated = false;
		let unmounted = false;

		const element =
			typeof document !== 'undefined' && typeof document.createElement === 'function'
				? document.createElement('div')
				: {
						tagName: 'DIV',
						dataset: {} as Record<string, string>,
						attributes: {} as Record<string, string>,
						textContent: '',
						parentNode: null as any,
						setAttribute(attr: string, val: string) {
							this.attributes[attr] = val;
						},
						getAttribute(attr: string) {
							return this.attributes[attr];
						},
						remove() {
							if (this.parentNode && typeof this.parentNode.removeChild === 'function') {
								this.parentNode.removeChild(this);
							}
						}
				  };

		if ('setAttribute' in element) {
			element.setAttribute('data-testid', name);
			element.setAttribute('data-order', String(props.order ?? 0));
		}
		element.textContent = props.message ?? `Component: ${name}`;

		if (targetOrAnchor) {
			if (typeof targetOrAnchor.appendChild === 'function') {
				targetOrAnchor.appendChild(element);
				(element as any).parentNode = targetOrAnchor;
			} else if (targetOrAnchor.parentNode && typeof targetOrAnchor.parentNode.insertBefore === 'function') {
				targetOrAnchor.parentNode.insertBefore(element, targetOrAnchor);
				(element as any).parentNode = targetOrAnchor.parentNode;
			}
		}

		const instance = {
			element,
			get props() {
				return currentProps;
			},
			get rendered() {
				return rendered;
			},
			get updated() {
				return updated;
			},
			get unmounted() {
				return unmounted;
			},
			update(newProps: Record<string, any>) {
				currentProps = { ...currentProps, ...newProps };
				updated = true;
				element.textContent = currentProps.message ?? `Component: ${name}`;
				if (newProps.order !== undefined && 'setAttribute' in element) {
					element.setAttribute('data-order', String(newProps.order));
				}
			},
			destroy() {
				this.unmount();
			},
			unmount() {
				if (unmounted) return;
				unmounted = true;
				rendered = false;
				if (typeof element.remove === 'function') {
					element.remove();
				}
			}
		};

		return instance;
	};
}
