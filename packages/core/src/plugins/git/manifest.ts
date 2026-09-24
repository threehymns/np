import type { PluginManifest } from '../types';

export const manifest: PluginManifest = {
	id: 'git',
	name: 'Git',
	version: 0,
	description: 'Bundled Git Core Plugin owning repository lifecycle and Git commands',
	platforms: ['web', 'desktop']
};
