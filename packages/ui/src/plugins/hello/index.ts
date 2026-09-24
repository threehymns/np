import type { PluginHostInterface } from '@np/core';
import { HELLO_UI_COMPONENTS_KEY } from '@np/core';
import HelloPanel from './HelloPanel.svelte';
import HelloStatus from './HelloStatus.svelte';

/**
 * Hello UI bridge (#203 pattern, ADR 0010).
 *
 * Plugin-owned UI module (NOT shell): provides the real Svelte components
 * for the Hello Core Plugin through the generic service key defined in
 * `@np/core` (`hello/ui.ts`). The core Hello setup consumes this service on
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
export function provideHelloUIComponents(host: PluginHostInterface): void {
	host.provideService(HELLO_UI_COMPONENTS_KEY, {
		panelComponent: HelloPanel,
		statusComponent: HelloStatus
	});
}

export { HelloPanel, HelloStatus };
