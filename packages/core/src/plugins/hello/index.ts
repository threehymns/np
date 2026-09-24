import type { PluginCleanup, PluginHostInterface } from '../types';
import { createPilotComponent } from '../ui-contributions';
import { manifest } from './manifest';
import {
	HELLO_PANEL_ID,
	HELLO_PANEL_TITLE,
	HELLO_PANEL_ORDER,
	HELLO_STATUS_ID,
	HELLO_STATUS_ORDER,
	getHelloUIComponents
} from './ui';

let activeInstances = 0;

export const helloPluginState = {
	active: false,
	activationCount: 0,
	deactivationCount: 0
};

export function getActiveHelloCount(): number {
	return activeInstances;
}

/**
 * Setup entrypoint for the hello core plugin.
 * Returns a cleanup function that runs on disable.
 */
export function setup(host: PluginHostInterface): PluginCleanup {
	activeInstances++;
	helloPluginState.active = true;
	helloPluginState.activationCount++;

	// Additive UI contributions (ADR 0010, ADR 0015):
	// Contributes a pilot sidebar panel and a pilot status-bar entry.
	// Real Svelte components arrive via the generic UI-components service
	// provided by the UI bridge (`@np/ui`); headless hosts (Bun tests) fall
	// back to pilot components so the wiring is verified without importing
	// `.svelte` files into `@np/core`.
	const uiComponents = getHelloUIComponents(host);
	if (uiComponents) {
		host.registerSidebarPanel(manifest.id, {
			id: HELLO_PANEL_ID,
			title: HELLO_PANEL_TITLE,
			order: HELLO_PANEL_ORDER,
			component: uiComponents.panelComponent,
			props: { message: 'Hello from Hello Plugin' }
		});
		host.registerStatusBarItem(manifest.id, {
			id: HELLO_STATUS_ID,
			alignment: 'left',
			order: HELLO_STATUS_ORDER,
			component: uiComponents.statusComponent,
			props: { message: 'Hello Status' }
		});
	} else {
		host.registerSidebarPanel(manifest.id, {
			id: HELLO_PANEL_ID,
			title: HELLO_PANEL_TITLE,
			order: HELLO_PANEL_ORDER,
			component: createPilotComponent('hello-panel'),
			props: { message: 'Hello from Hello Plugin' }
		});
		host.registerStatusBarItem(manifest.id, {
			id: HELLO_STATUS_ID,
			alignment: 'left',
			order: HELLO_STATUS_ORDER,
			component: createPilotComponent('hello-status'),
			props: { message: 'Hello Status' }
		});
	}

	return () => {
		activeInstances--;
		helloPluginState.active = activeInstances > 0;
		helloPluginState.deactivationCount++;
	};
}

export { manifest };
export default { manifest, setup };
