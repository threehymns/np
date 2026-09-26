import type { PluginManifest } from '../types';

export const manifest: PluginManifest = {
	id: 'git',
	name: 'Git',
	version: 0,
	description: 'Bundled Git Core Plugin owning repository lifecycle, Git commands, and Git UI contributions',
	platforms: ['web', 'desktop'],
	defaultEnabled: true
};
