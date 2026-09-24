import type { PluginCleanup, PluginHostInterface } from '../types';
import { createPilotComponent } from '../ui-contributions';
import { manifest } from './manifest';

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
	// Contributes a pilot sidebar panel and a pilot status-bar entry
	host.registerSidebarPanel(manifest.id, {
		id: 'hello-panel',
		title: 'Hello',
		order: 100,
		component: createPilotComponent('hello-panel'),
		props: { message: 'Hello from Hello Plugin' }
	});

	host.registerStatusBarItem(manifest.id, {
		id: 'hello-status',
		alignment: 'left',
		order: 100,
		component: createPilotComponent('hello-status'),
		props: { message: 'Hello Status' }
	});

	return () => {
		activeInstances--;
		helloPluginState.active = activeInstances > 0;
		helloPluginState.deactivationCount++;
	};
}

export { manifest };
export default { manifest, setup };
