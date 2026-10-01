import { manifest } from './manifest';
import type { PluginRegistration } from '../types';

/**
 * Lazy registration for the Git Core Plugin.
 * Exposes the pure manifest immediately, deferring loading of the
 * implementation module until activation (ADR 0011).
 */
export const gitRegistration: PluginRegistration = {
	manifest,
	load: async () => {
		const mod = await import('./index');
		return {
			manifest,
			setup: mod.setup
		};
	}
};
