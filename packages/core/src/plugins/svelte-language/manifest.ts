import type { PluginManifest } from '../types';

export const manifest: PluginManifest = {
	id: 'svelte-language',
	name: 'Svelte Language',
	version: 0,
	description: 'Syntax highlighting and language mode for Svelte files',
	platforms: ['web', 'desktop'],
	defaultEnabled: true
};
