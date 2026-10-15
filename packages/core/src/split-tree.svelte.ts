export type PaneAxis = 'horizontal' | 'vertical';
export type SplitDirection = 'left' | 'right' | 'up' | 'down';
export type SplitMode = 'empty' | 'move' | 'clone';

export const WORKSPACE_PERSISTENCE_VERSION = 1;

export interface WorkspaceTab {
	id: string;
	type: 'document' | 'diff';
	pluginId?: string;
	canSplit?: boolean;
	docId?: string;
}

export class Pane {
	readonly type = 'pane' as const;
	id: string;
	tabs = $state<WorkspaceTab[]>([]);
	activeTabId = $state<string>('');
	flex = $state<number>(1);

	constructor(tabs: WorkspaceTab[] = [], activeTabId = '', id?: string, flex = 1) {
		this.id = id ?? crypto.randomUUID();
		this.tabs = [...tabs];
		this.activeTabId = activeTabId || (tabs[0]?.id ?? '');
		this.flex = flex;
	}

	get activeTab(): WorkspaceTab | undefined {
		return this.tabs.find((t) => t.id === this.activeTabId);
	}
}

export class Axis {
	readonly type = 'axis' as const;
	id: string;
	axis = $state<PaneAxis>('horizontal');
	children = $state<LayoutNode[]>([]);
	flex = $state<number>(1);

	constructor(axis: PaneAxis = 'horizontal', children: LayoutNode[] = [], id?: string, flex = 1) {
		this.id = id ?? crypto.randomUUID();
		this.axis = axis;
		this.children = [...children];
		this.flex = flex;
	}

	get orientation(): PaneAxis {
		return this.axis;
	}

	set orientation(val: PaneAxis) {
		this.axis = val;
	}
}

export type LayoutNode = Pane | Axis;

export function isPane(node: LayoutNode): node is Pane {
	return node.type === 'pane';
}

export function isAxis(node: LayoutNode): node is Axis {
	return node.type === 'axis';
}

export function getAllPanes(root: LayoutNode): Pane[] {
	if (isPane(root)) {
		return [root];
	}
	const result: Pane[] = [];
	for (const child of root.children) {
		result.push(...getAllPanes(child));
	}
	return result;
}

export function findPane(root: LayoutNode, id: string): Pane | null {
	if (isPane(root)) {
		return root.id === id ? root : null;
	}
	for (const child of root.children) {
		const found = findPane(child, id);
		if (found) return found;
	}
	return null;
}

export function findParentAxis(root: LayoutNode, childId: string): { parent: Axis; index: number } | null {
	if (isPane(root)) return null;

	const index = root.children.findIndex((c) => c.id === childId);
	if (index !== -1) {
		return { parent: root, index };
	}

	for (const child of root.children) {
		if (isAxis(child)) {
			const found = findParentAxis(child, childId);
			if (found) return found;
		}
	}
	return null;
}

export function findPaneWithTab(root: LayoutNode, tabId: string): Pane | null {
	for (const pane of getAllPanes(root)) {
		if (pane.tabs.some((t) => t.id === tabId)) {
			return pane;
		}
	}
	return null;
}

export function canSplitTab(tab?: WorkspaceTab | null): boolean {
	if (!tab) return false;
	if (tab.canSplit !== undefined) return tab.canSplit;
	if (tab.type === 'diff') return false;
	if (tab.id === '__lsp_logs__' || tab.id === '__project_diff__') return false;
	return true;
}

export function splitPane(
	root: LayoutNode,
	targetPaneId: string,
	direction: SplitDirection,
	newPane: Pane
): LayoutNode {
	const targetAxis: PaneAxis = direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical';
	const isAfter = direction === 'right' || direction === 'down';

	if (root.id === targetPaneId) {
		// Target is the workspace root
		const children = isAfter ? [root, newPane] : [newPane, root];
		root.flex = 1;
		newPane.flex = 1;
		return new Axis(targetAxis, children, undefined, 1);
	}

	const parentInfo = findParentAxis(root, targetPaneId);
	if (!parentInfo) {
		// Not found: return root unchanged
		return root;
	}

	const { parent, index } = parentInfo;
	const targetPane = parent.children[index];

	if (parent.axis === targetAxis) {
		// Matching axis: insert adjacent
		targetPane.flex = 1;
		newPane.flex = 1;
		const insertIndex = isAfter ? index + 1 : index;
		parent.children.splice(insertIndex, 0, newPane);
		return root;
	}

	// Orthogonal axis: nest a new axis
	const preservedFlex = targetPane.flex;
	targetPane.flex = 1;
	newPane.flex = 1;
	const children = isAfter ? [targetPane, newPane] : [newPane, targetPane];
	const nested = new Axis(targetAxis, children, undefined, preservedFlex);
	parent.children[index] = nested;
	return root;
}

export function collapseTree(node: LayoutNode): LayoutNode {
	if (isPane(node)) return node;

	// Recursively collapse children first
	node.children = node.children.map((child) => collapseTree(child));

	// Collapse single-child axes
	if (node.children.length === 1) {
		const singleChild = node.children[0];
		singleChild.flex = node.flex;
		return singleChild;
	}

	return node;
}

export function removePane(
	root: LayoutNode,
	targetPaneId: string
): { newRoot: LayoutNode; neighborId: string | null } | null {
	if (isPane(root)) {
		// Only pane in workspace: root is never removed
		return null;
	}

	const parentInfo = findParentAxis(root, targetPaneId);
	if (!parentInfo) {
		return null;
	}

	const { parent, index } = parentInfo;

	// Pick neighbor before removing
	let neighborNode: LayoutNode | null = null;
	if (index > 0) {
		neighborNode = parent.children[index - 1];
	} else if (index < parent.children.length - 1) {
		neighborNode = parent.children[index + 1];
	}

	let neighborId: string | null = null;
	if (neighborNode) {
		const neighborPanes = getAllPanes(neighborNode);
		neighborId = index > 0
			? neighborPanes[neighborPanes.length - 1]?.id ?? null
			: neighborPanes[0]?.id ?? null;
	}

	parent.children.splice(index, 1);
	const newRoot = collapseTree(root);

	if (!neighborId) {
		const remaining = getAllPanes(newRoot);
		neighborId = remaining[0]?.id ?? null;
	}

	return { newRoot, neighborId };
}

export interface Rect {
	left: number;
	top: number;
	right: number;
	bottom: number;
	width: number;
	height: number;
}

export function getDomPaneRects(): Map<string, Rect> {
	const map = new Map<string, Rect>();
	if (typeof document === 'undefined') return map;

	const elements = document.querySelectorAll<HTMLElement>('[data-pane-id]');
	for (const el of elements) {
		const id = el.getAttribute('data-pane-id');
		if (id) {
			const r = el.getBoundingClientRect();
			map.set(id, {
				left: r.left,
				top: r.top,
				right: r.right,
				bottom: r.bottom,
				width: r.width,
				height: r.height
			});
		}
	}
	return map;
}

export function findPaneInDirection(
	paneId: string,
	direction: SplitDirection,
	rectsMap?: Map<string, Rect>
): string | null {
	const rects = rectsMap ?? getDomPaneRects();
	const currentRect = rects.get(paneId);
	if (!currentRect) return null;

	let targetX: number;
	let targetY: number;

	switch (direction) {
		case 'left':
			targetX = currentRect.left - 1;
			targetY = currentRect.top + currentRect.height / 2;
			break;
		case 'right':
			targetX = currentRect.right + 1;
			targetY = currentRect.top + currentRect.height / 2;
			break;
		case 'up':
			targetX = currentRect.left + currentRect.width / 2;
			targetY = currentRect.top - 1;
			break;
		case 'down':
			targetX = currentRect.left + currentRect.width / 2;
			targetY = currentRect.bottom + 1;
			break;
	}

	// 1. Direct hit-test: does (targetX, targetY) hit any candidate rect?
	for (const [id, rect] of rects.entries()) {
		if (id === paneId) continue;
		if (
			targetX >= rect.left &&
			targetX <= rect.right &&
			targetY >= rect.top &&
			targetY <= rect.bottom
		) {
			return id;
		}
	}

	// 2. Tolerance hit-test: step one pixel past edge and find candidate with orthogonal overlap
	let bestId: string | null = null;
	let minDistance = Infinity;

	for (const [id, rect] of rects.entries()) {
		if (id === paneId) continue;

		let inDirection = false;
		let distance = Infinity;

		if (direction === 'left' && rect.right <= currentRect.left) {
			const overlap = Math.min(currentRect.bottom, rect.bottom) - Math.max(currentRect.top, rect.top);
			if (overlap > 0) {
				inDirection = true;
				distance = currentRect.left - rect.right;
			}
		} else if (direction === 'right' && rect.left >= currentRect.right) {
			const overlap = Math.min(currentRect.bottom, rect.bottom) - Math.max(currentRect.top, rect.top);
			if (overlap > 0) {
				inDirection = true;
				distance = rect.left - currentRect.right;
			}
		} else if (direction === 'up' && rect.bottom <= currentRect.top) {
			const overlap = Math.min(currentRect.right, rect.right) - Math.max(currentRect.left, rect.left);
			if (overlap > 0) {
				inDirection = true;
				distance = currentRect.top - rect.bottom;
			}
		} else if (direction === 'down' && rect.top >= currentRect.bottom) {
			const overlap = Math.min(currentRect.right, rect.right) - Math.max(currentRect.left, rect.left);
			if (overlap > 0) {
				inDirection = true;
				distance = rect.top - currentRect.bottom;
			}
		}

		if (inDirection && distance < minDistance) {
			minDistance = distance;
			bestId = id;
		}
	}

	return bestId;
}
