import type { PluginHostInterface } from '@np/core';
import {
	gitManifest,
	gitRegistration,
	PLUGIN_UI_LOADER_SERVICE_KEY,
	type PluginUILoader
} from '@np/core';

export function registerBundledPlugins(host: PluginHostInterface): void {
	if (!host.hasPlugin(gitRegistration.manifest.id)) {
		host.register(gitRegistration);
	}
}

export function registerPluginUiLoader(host: PluginHostInterface): void {
	const loader: PluginUILoader = {
		load: async (pluginId) => {
			switch (pluginId) {
				case gitManifest.id: {
					const { provideGitUIComponents } = await import('./git');
					provideGitUIComponents(host);
					return;
				}
				default:
					return;
			}
		}
	};
	host.provideService(PLUGIN_UI_LOADER_SERVICE_KEY, loader);
}
