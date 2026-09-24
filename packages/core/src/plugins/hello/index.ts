import type { PluginCleanup, PluginHostInterface } from '../types';
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

	return () => {
		activeInstances--;
		helloPluginState.active = activeInstances > 0;
		helloPluginState.deactivationCount++;
	};
}

export { manifest };
export default { manifest, setup };
