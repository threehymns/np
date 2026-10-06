import type { PluginHostInterface } from '@np/core';
import {
	gitManifest,
	gitRegistration,
	lspManifest,
	lspRegistration,
	svelteLanguageRegistration,
	PLUGIN_UI_LOADER_SERVICE_KEY,
	type PluginUILoader
} from '@np/core';

export function registerBundledPlugins(host: PluginHostInterface): void {
	if (!host.hasPlugin(gitRegistration.manifest.id)) {
		host.register(gitRegistration);
	}
	if (!host.hasPlugin(svelteLanguageRegistration.manifest.id)) {
		host.register(svelteLanguageRegistration);
	}
	// The LSP manifest already limits itself to desktop, and activation would
	// refuse it elsewhere. Registering it on web anyway would only buy a startup
	// error for a plugin that cannot run, so the platform is checked here — the
	// manifest stays the authority on what is supported, this is only the
	// decision not to offer it where it cannot work.
	if (host.platform === 'desktop' && !host.hasPlugin(lspRegistration.manifest.id)) {
		host.register(lspRegistration);
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
				case lspManifest.id: {
					const { provideLspUIComponents } = await import('./lsp');
					provideLspUIComponents(host);
					return;
				}
				default:
					return;
			}
		}
	};
	host.provideService(PLUGIN_UI_LOADER_SERVICE_KEY, loader);
}
