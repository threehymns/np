import type { PluginManifest } from '../types';

export const manifest: PluginManifest = {
	id: 'hello',
	name: 'Hello',
	version: 0,
	description: 'Bundled hello Core Plugin proving activation and deactivation lifecycle',
	platforms: ['web', 'desktop']
};
