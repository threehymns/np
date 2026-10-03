import type { PluginManifest } from '../types';

export const manifest: PluginManifest = {
	id: 'svelte-language',
	name: 'Svelte Language',
	version: 0,
	description: 'Bundled Svelte language support proving the language contribution path',
	platforms: ['web', 'desktop'],
	defaultEnabled: true
};
