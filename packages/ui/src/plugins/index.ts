import type { PluginHostInterface } from '@np/core';
import { gitRegistration } from '@np/core';
import { provideGitUIComponents } from './git/index';

/**
 * Generic bundled-plugin UI bridge (#203).
 *
 * Plugin infrastructure (NOT shell): registers bundled feature plugins with
 * the host and provides their UI components through generic services before
 * `AppState.init()` activates default-enabled plugins. Shell code
 * (`AppShell`, apps) imports only these generic entry points — never
 * feature names — so no feature identifiers remain in shell-owned UI code.
 *
 * To add a future bundled plugin with UI (e.g. an exporter): import its
 * registration + provider here and extend both functions. No shell or host
 * changes are needed.
 */
export function registerBundledPlugins(host: PluginHostInterface): void {
	if (!host.hasPlugin(gitRegistration.manifest.id)) {
		host.register(gitRegistration);
	}
}

export function provideAllPluginUIs(host: PluginHostInterface): void {
	registerBundledPlugins(host);
	provideGitUIComponents(host);
}
