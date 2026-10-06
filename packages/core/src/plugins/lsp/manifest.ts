import type { PluginManifest } from '../types';

export const manifest: PluginManifest = {
	id: 'lsp',
	name: 'Language Servers',
	version: 0,
	description:
		'Starts language servers for the files you open. Desktop only: stdio servers need a process host, and web is out of scope until a remote or headless transport exists.',
	platforms: ['desktop'],
	defaultEnabled: true
};
