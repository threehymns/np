import '../../../../tests/contract/rune-setup';
import { describe, it, expect } from 'bun:test';
import { PluginHost } from './host.svelte';
import {
	DuplicateSidebarPanelIdError,
	DuplicateStatusBarItemIdError,
	UIContributionRegistry,
	createPilotComponent,
	compareSidebarPanels,
	compareStatusBarItems,
	rebuildSidebarPanels,
	rebuildStatusBarItems,
	createAddSidebarPanelsTransform,
	createAddStatusBarItemsTransform,
	validateSidebarPanelContribution,
	validateStatusBarItemContribution,
	type SidebarPanelContribution,
	type StatusBarItemContribution,
	type SidebarPanelTransformEntry,
	type StatusBarItemTransformEntry
} from './ui-contributions';
import { AppState } from '../state.svelte';
import { createMockStorage } from '../../../../tests/mock-storage';

describe('Additive UI Contributions (ADR 0010, ADR 0012, ADR 0015, #200)', () => {
	describe('1. Pure Replay & Transform Primitives', () => {
		it('replays sidebar panel and status bar item transforms in order from empty state', () => {
			const panelTransforms: SidebarPanelTransformEntry[] = [
				{
					pluginId: 'plugin-a',
					transform: createAddSidebarPanelsTransform(
						[
							{
								id: 'panel-a',
								title: 'Panel A',
								order: 20,
								component: createPilotComponent('panel-a')
							}
						],
						'plugin-a'
					)
				},
				{
					pluginId: 'plugin-b',
					transform: createAddSidebarPanelsTransform(
						[
							{
								id: 'panel-b',
								title: 'Panel B',
								order: 10,
								component: createPilotComponent('panel-b')
							}
						],
						'plugin-b'
					)
				}
			];

			const panels = rebuildSidebarPanels(panelTransforms);
			expect(panels.size).toBe(2);
			expect(panels.has('panel-a')).toBe(true);
			expect(panels.has('panel-b')).toBe(true);

			const statusTransforms: StatusBarItemTransformEntry[] = [
				{
					pluginId: 'plugin-a',
					transform: createAddStatusBarItemsTransform(
						[
							{
								id: 'status-a',
								alignment: 'right',
								order: 50,
								component: createPilotComponent('status-a')
							}
						],
						'plugin-a'
					)
				},
				{
					pluginId: 'plugin-b',
					transform: createAddStatusBarItemsTransform(
						[
							{
								id: 'status-b',
								alignment: 'left',
								order: 10,
								component: createPilotComponent('status-b')
							}
						],
						'plugin-b'
					)
				}
			];

			const statusItems = rebuildStatusBarItems(statusTransforms);
			expect(statusItems.size).toBe(2);
			expect(statusItems.has('status-a')).toBe(true);
			expect(statusItems.has('status-b')).toBe(true);
		});

		it('removing one plugin yields exactly the registry a clean build without it would produce', () => {
			const makePanelsA = (): SidebarPanelContribution => ({
				id: 'panel-a',
				title: 'Panel A',
				order: 10,
				component: createPilotComponent('panel-a')
			});
			const makePanelsB = (): SidebarPanelContribution => ({
				id: 'panel-b',
				title: 'Panel B',
				order: 20,
				component: createPilotComponent('panel-b')
			});
			const makePanelsC = (): SidebarPanelContribution => ({
				id: 'panel-c',
				title: 'Panel C',
				order: 30,
				component: createPilotComponent('panel-c')
			});

			const allTransforms: SidebarPanelTransformEntry[] = [
				{ pluginId: 'a', transform: createAddSidebarPanelsTransform([makePanelsA()], 'a') },
				{ pluginId: 'b', transform: createAddSidebarPanelsTransform([makePanelsB()], 'b') },
				{ pluginId: 'c', transform: createAddSidebarPanelsTransform([makePanelsC()], 'c') }
			];

			// Clean build without 'b'
			const cleanWithoutB: SidebarPanelTransformEntry[] = [
				{ pluginId: 'a', transform: createAddSidebarPanelsTransform([makePanelsA()], 'a') },
				{ pluginId: 'c', transform: createAddSidebarPanelsTransform([makePanelsC()], 'c') }
			];

			const afterDropB = allTransforms.filter((t) => t.pluginId !== 'b');
			const resultAfterDrop = rebuildSidebarPanels(afterDropB);
			const resultClean = rebuildSidebarPanels(cleanWithoutB);

			expect(Array.from(resultAfterDrop.keys())).toEqual(Array.from(resultClean.keys()));
			expect(resultAfterDrop.has('panel-b')).toBe(false);
			expect(resultAfterDrop.size).toBe(2);
		});

		it('rejects cross-plugin duplicate sidebar panel IDs with DuplicateSidebarPanelIdError', () => {
			const transforms: SidebarPanelTransformEntry[] = [
				{
					pluginId: 'plugin-1',
					transform: createAddSidebarPanelsTransform(
						[
							{
								id: 'shared-panel',
								title: 'First',
								order: 10,
								component: createPilotComponent('first')
							}
						],
						'plugin-1'
					)
				},
				{
					pluginId: 'plugin-2',
					transform: createAddSidebarPanelsTransform(
						[
							{
								id: 'shared-panel',
								title: 'Second',
								order: 20,
								component: createPilotComponent('second')
							}
						],
						'plugin-2'
					)
				}
			];

			expect(() => rebuildSidebarPanels(transforms)).toThrow(DuplicateSidebarPanelIdError);
		});

		it('rejects cross-plugin duplicate status bar item IDs with DuplicateStatusBarItemIdError', () => {
			const transforms: StatusBarItemTransformEntry[] = [
				{
					pluginId: 'plugin-1',
					transform: createAddStatusBarItemsTransform(
						[
							{
								id: 'shared-status',
								alignment: 'left',
								order: 10,
								component: createPilotComponent('first')
							}
						],
						'plugin-1'
					)
				},
				{
					pluginId: 'plugin-2',
					transform: createAddStatusBarItemsTransform(
						[
							{
								id: 'shared-status',
								alignment: 'left',
								order: 20,
								component: createPilotComponent('second')
							}
						],
						'plugin-2'
					)
				}
			];

			expect(() => rebuildStatusBarItems(transforms)).toThrow(DuplicateStatusBarItemIdError);
		});

		it('allows same-plugin re-registration with last-wins (refresh with fresh closures)', () => {
			const transforms: SidebarPanelTransformEntry[] = [
				{
					pluginId: 'plugin-1',
					transform: createAddSidebarPanelsTransform(
						[
							{
								id: 'my-panel',
								title: 'Version 1',
								order: 10,
								component: createPilotComponent('v1')
							}
						],
						'plugin-1'
					)
				},
				{
					pluginId: 'plugin-1',
					transform: createAddSidebarPanelsTransform(
						[
							{
								id: 'my-panel',
								title: 'Version 2 (Refreshed)',
								order: 15,
								component: createPilotComponent('v2')
							}
						],
						'plugin-1'
					)
				}
			];

			const panels = rebuildSidebarPanels(transforms);
			expect(panels.size).toBe(1);
			expect(panels.get('my-panel')?.title).toBe('Version 2 (Refreshed)');
			expect(panels.get('my-panel')?.order).toBe(15);
		});

		it('validates typed inputs and throws actionable errors for invalid contributions', () => {
			// Sidebar panel validation
			expect(() => validateSidebarPanelContribution(null as any)).toThrow();
			expect(() => validateSidebarPanelContribution({} as any)).toThrow(/non-empty string "id"/);
			expect(() => validateSidebarPanelContribution({ id: 'p1' } as any)).toThrow(/string "title"/);
			expect(() => validateSidebarPanelContribution({ id: 'p1', title: 'P1' } as any)).toThrow(/numeric "order"/);
			expect(() => validateSidebarPanelContribution({ id: 'p1', title: 'P1', order: 1 } as any)).toThrow(/component/);

			// Status bar item validation
			expect(() => validateStatusBarItemContribution(null as any)).toThrow();
			expect(() => validateStatusBarItemContribution({} as any)).toThrow(/non-empty string "id"/);
			expect(() => validateStatusBarItemContribution({ id: 's1' } as any)).toThrow(/alignment 'left' \| 'right'/);
			expect(() => validateStatusBarItemContribution({ id: 's1', alignment: 'invalid' as any, order: 1, component: {} })).toThrow(/alignment/);
			expect(() => validateStatusBarItemContribution({ id: 's1', alignment: 'left' } as any)).toThrow(/numeric "order"/);
			expect(() => validateStatusBarItemContribution({ id: 's1', alignment: 'left', order: 1 } as any)).toThrow(/component/);
		});
	});

	describe('2. Explicit Deterministic Ordering (ADR 0015)', () => {
		it('sorts sidebar panels ascending by explicit order with deterministic tie-breaking by id', () => {
			const panels: SidebarPanelContribution[] = [
				{ id: 'c-panel', title: 'C', order: 20, component: {} },
				{ id: 'b-panel', title: 'B', order: 10, component: {} },
				{ id: 'z-panel', title: 'Z', order: 10, component: {} },
				{ id: 'a-panel', title: 'A', order: 10, component: {} },
				{ id: 'd-panel', title: 'D', order: 5, component: {} }
			];

			const sorted = [...panels].sort(compareSidebarPanels);
			expect(sorted.map((p) => p.id)).toEqual(['d-panel', 'a-panel', 'b-panel', 'z-panel', 'c-panel']);
		});

		it('partitions status bar items by alignment and sorts ascending by order with deterministic tie-breaking', () => {
			const items: StatusBarItemContribution[] = [
				{ id: 'r2', alignment: 'right', order: 20, component: {} },
				{ id: 'l2', alignment: 'left', order: 20, component: {} },
				{ id: 'r1', alignment: 'right', order: 10, component: {} },
				{ id: 'l1', alignment: 'left', order: 10, component: {} },
				{ id: 'l1-tie', alignment: 'left', order: 10, component: {} }
			];

			const sorted = [...items].sort(compareStatusBarItems);
			// Left items first (ordered 10 tie-broken alphabetically, then 20), followed by right items
			expect(sorted.map((i) => i.id)).toEqual(['l1', 'l1-tie', 'l2', 'r1', 'r2']);
		});
	});

	describe('3. Standalone UIContributionRegistry', () => {
		it('supports registering, querying, mounting, and removing contributions without full host', () => {
			const registry = new UIContributionRegistry();

			registry.registerSidebarPanel('plugin-a', {
				id: 'panel-1',
				title: 'Panel One',
				order: 10,
				component: createPilotComponent('panel-1')
			});

			registry.registerStatusBarItem('plugin-a', {
				id: 'status-1',
				alignment: 'left',
				order: 5,
				component: createPilotComponent('status-1'),
				props: { message: 'Ready' }
			});

			expect(registry.getSidebarPanels()).toHaveLength(1);
			expect(registry.getStatusBarItems()).toHaveLength(1);
			expect(registry.getSidebarPanel('panel-1')?.title).toBe('Panel One');
			expect(registry.getStatusBarItem('status-1')?.alignment).toBe('left');

			// Mount contribution
			const container = { appendChild: () => {}, removeChild: () => {} };
			const mounted = registry.mountContribution('plugin-a', 'status-1', container);
			expect(mounted.contributionId).toBe('status-1');
			expect(registry.getMountedContributions('plugin-a')).toHaveLength(1);

			// Remove plugin
			registry.removePlugin('plugin-a');
			expect(registry.getSidebarPanels()).toHaveLength(0);
			expect(registry.getStatusBarItems()).toHaveLength(0);
			expect(registry.getMountedContributions('plugin-a')).toHaveLength(0);
		});
	});

	describe('4. Host-Mounted Additive UI Contributions Lifecycle (ADR 0009, ADR 0010, ADR 0015)', () => {
		it('registers sidebar panels and status entries and queries them in deterministic order', async () => {
			const host = new PluginHost();

			host.register({
				manifest: { id: 'p1', name: 'Plugin 1', version: 0 },
				setup: (h) => {
					h.registerSidebarPanel('p1', {
						id: 'panel-z',
						title: 'Panel Z',
						order: 200,
						component: createPilotComponent('panel-z')
					});
					h.registerStatusBarItem('p1', {
						id: 'status-z',
						alignment: 'right',
						order: 50,
						component: createPilotComponent('status-z')
					});
				}
			});

			host.register({
				manifest: { id: 'p2', name: 'Plugin 2', version: 0 },
				setup: (h) => {
					h.registerSidebarPanel('p2', {
						id: 'panel-a',
						title: 'Panel A',
						order: 100,
						component: createPilotComponent('panel-a')
					});
					h.registerStatusBarItem('p2', {
						id: 'status-a',
						alignment: 'left',
						order: 10,
						component: createPilotComponent('status-a')
					});
				}
			});

			await host.activateAll();

			// Verify panels sorted by order: panel-a (order 100) before panel-z (order 200)
			const panels = host.getSidebarPanels();
			expect(panels).toHaveLength(2);
			expect(panels[0].id).toBe('panel-a');
			expect(panels[1].id).toBe('panel-z');

			// Verify status items partitioned by alignment and order
			const leftItems = host.getStatusBarItems('left');
			expect(leftItems).toHaveLength(1);
			expect(leftItems[0].id).toBe('status-a');

			const rightItems = host.getStatusBarItems('right');
			expect(rightItems).toHaveLength(1);
			expect(rightItems[0].id).toBe('status-z');
		});

		it('pilot panel renders, updates, and unmounts purely through contributions', async () => {
			const host = new PluginHost();

			host.register({
				manifest: { id: 'pilot-plugin', name: 'Pilot Plugin', version: 0 },
				setup: (h) => {
					h.registerSidebarPanel('pilot-plugin', {
						id: 'pilot-view',
						title: 'Pilot View',
						order: 10,
						component: createPilotComponent('pilot-view'),
						props: { message: 'Initial message', order: 10 }
					});
				}
			});

			await host.activate('pilot-plugin');

			const targetContainer = {
				appendChild: () => {},
				removeChild: () => {}
			};

			// 1. Host mounts the pilot panel
			const mounted = host.mountContribution('pilot-plugin', 'pilot-view', targetContainer);
			expect(mounted).toBeDefined();
			expect(mounted.contributionId).toBe('pilot-view');
			expect(mounted.props.message).toBe('Initial message');
			expect(mounted.instance.rendered).toBe(true);
			expect(mounted.instance.unmounted).toBe(false);

			// 2. Host updates the pilot panel
			mounted.update({ message: 'Updated message' });
			expect(mounted.props.message).toBe('Updated message');
			expect(mounted.instance.updated).toBe(true);

			// 3. Host unmounts the pilot panel
			mounted.unmount();
			expect(mounted.instance.unmounted).toBe(true);
			expect(mounted.instance.rendered).toBe(false);
			expect(host.ui.getMountedContributions('pilot-plugin')).toHaveLength(0);
		});

		it('disabling a plugin cleanly unmounts and removes its panels and status entries with no residue (ADR 0009, ADR 0015)', async () => {
			const host = new PluginHost();

			let panelUnmounted = false;
			const customComponent = () => ({
				rendered: true,
				unmount: () => {
					panelUnmounted = true;
				}
			});

			host.register({
				manifest: { id: 'ephemeral-plugin', name: 'Ephemeral Plugin', version: 0 },
				setup: (h) => {
					h.registerSidebarPanel('ephemeral-plugin', {
						id: 'ephemeral-panel',
						title: 'Ephemeral Panel',
						order: 1,
						component: customComponent
					});
					h.registerStatusBarItem('ephemeral-plugin', {
						id: 'ephemeral-status',
						alignment: 'left',
						order: 1,
						component: createPilotComponent('ephemeral-status')
					});
				}
			});

			await host.activate('ephemeral-plugin');

			// Verify presence
			expect(host.getSidebarPanel('ephemeral-panel')).toBeDefined();
			expect(host.getStatusBarItem('ephemeral-status')).toBeDefined();
			expect(host.getSidebarPanels()).toHaveLength(1);
			expect(host.getStatusBarItems()).toHaveLength(1);

			// Mount a contribution
			const mounted = host.mountContribution('ephemeral-plugin', 'ephemeral-panel', {});
			expect(mounted).toBeDefined();
			expect(panelUnmounted).toBe(false);

			// Deactivate / disable plugin
			await host.deactivate('ephemeral-plugin');

			// Verify unmounted
			expect(panelUnmounted).toBe(true);
			expect(host.ui.getMountedContributions('ephemeral-plugin')).toHaveLength(0);

			// Verify zero residue
			expect(host.getSidebarPanel('ephemeral-panel')).toBeUndefined();
			expect(host.getStatusBarItem('ephemeral-status')).toBeUndefined();
			expect(host.getSidebarPanels()).toHaveLength(0);
			expect(host.getStatusBarItems()).toHaveLength(0);
		});

		it('additive first: nothing one plugin contributes can suppress another plugin contribution', async () => {
			const host = new PluginHost();

			host.register({
				manifest: { id: 'p1', name: 'Plugin 1', version: 0 },
				setup: (h) => {
					h.registerSidebarPanel('p1', {
						id: 'p1-panel',
						title: 'Panel 1',
						order: 10,
						component: createPilotComponent('p1')
					});
				}
			});

			host.register({
				manifest: { id: 'p2', name: 'Plugin 2', version: 0 },
				setup: (h) => {
					h.registerSidebarPanel('p2', {
						id: 'p2-panel',
						title: 'Panel 2',
						order: 20,
						component: createPilotComponent('p2')
					});
				}
			});

			await host.activateAll();

			const panels = host.getSidebarPanels();
			expect(panels).toHaveLength(2);
			expect(panels.map((p) => p.id)).toEqual(['p1-panel', 'p2-panel']);

			// Deactivating p1 does not affect p2
			await host.deactivate('p1');
			const panelsAfterP1Deactivate = host.getSidebarPanels();
			expect(panelsAfterP1Deactivate).toHaveLength(1);
			expect(panelsAfterP1Deactivate[0].id).toBe('p2-panel');
		});
	});

	describe('5. AppState Integration & Active View Teardown (ADR 0009)', () => {
		it('resets activeSidebarTab to explorer when the active tab belongs to a deactivated plugin', async () => {
			const storage = createMockStorage();
			const appState = new AppState({
				storage,
				prefsStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} }
			});

			// Register a test plugin that contributes a sidebar panel
			appState.plugins.register({
				manifest: { id: 'custom-view-plugin', name: 'Custom View', version: 0 },
				setup: (h) => {
					h.registerSidebarPanel('custom-view-plugin', {
						id: 'custom-view',
						title: 'Custom View',
						order: 50,
						component: createPilotComponent('custom-view')
					});
				}
			});

			await appState.plugins.activate('custom-view-plugin');
			expect(appState.plugins.getSidebarPanel('custom-view')).toBeDefined();

			// User switches to the custom panel
			appState.activeSidebarTab = 'custom-view';
			expect(appState.activeSidebarTab).toBe('custom-view');

			// Plugin is disabled / deactivated
			await appState.plugins.deactivate('custom-view-plugin');

			// activeSidebarTab automatically reverts to 'explorer' with no dangling residue
			expect(appState.activeSidebarTab).toBe('explorer');
		});
	});
});
