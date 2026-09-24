import type { PluginHostInterface } from '@np/core';
import { GIT_UI_COMPONENTS_KEY } from '@np/core';
import { GitMergeIcon } from 'phosphor-svelte';
import GitPanel from './GitPanel.svelte';
import GitStatusBarItem from './GitStatusBarItem.svelte';

/**
 * Git UI bridge (#203, ADR 0010).
 *
 * Plugin-owned UI module (NOT shell): provides the real Svelte components
 * for the Git Core Plugin through the generic service key defined in
 * `@np/core` (`git/ui.ts`). The core Git setup consumes this service on
 * every activation and registers the sidebar panel + status item through
 * `host.registerSidebarPanel` / `host.registerStatusBarItem`; the host
 * removes them on deactivate. Headless hosts (Bun tests) never call this
 * bridge and fall back to pilot components, so `@np/core` never imports
 * `.svelte` files.
 *
 * Called once at startup via the generic `provideAllPluginUIs` entry
 * (`../index.ts`), before `AppState.init()` activates default-enabled
 * plugins. Last-write-wins; safe to call once.
 */
export function provideGitUIComponents(host: PluginHostInterface): void {
	host.provideService(GIT_UI_COMPONENTS_KEY, {
		panelComponent: GitPanel,
		panelIcon: GitMergeIcon,
		statusComponent: GitStatusBarItem
	});
}

export { GitPanel, GitStatusBarItem };
