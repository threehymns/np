import type { PluginHostInterface } from '../types';

/**
 * Hello UI contribution metadata and service bridge (#203 pattern).
 *
 * Headless module (no Svelte imports): defines the sidebar panel and status
 * bar item IDs, titles, and ordering for the Hello Core Plugin, plus the
 * generic service key through which the UI layer provides real Svelte
 * components. The host itself never names Hello (ADR 0008): it only offers
 * opaque `provideService` / `getService`; this key is a convention owned by
 * the Hello plugin's core setup (consumer) and the UI plugin bridge
 * (provider, in `@np/ui`), never by the host.
 *
 * Headless tests (Bun, no Svelte compiler) run without the UI service and
 * fall back to pilot components, proving the registration wiring without
 * importing `.svelte` files into `@np/core`.
 */

export const HELLO_PANEL_ID = 'hello-panel';
export const HELLO_PANEL_TITLE = 'Hello';
export const HELLO_PANEL_ORDER = 100;

export const HELLO_STATUS_ID = 'hello-status';
export const HELLO_STATUS_ORDER = 100;

/**
 * Generic service key for Hello UI components. Value shape is owned by this
 * module (consumer) and the UI bridge (provider); the host treats it as
 * opaque (ADR 0008, #202 services precedent).
 */
export const HELLO_UI_COMPONENTS_KEY = 'hello:ui-components';

/**
 * Real UI components provided by the UI layer (`packages/ui/src/plugins/hello`).
 * All fields are `any` to keep this module headless (no Svelte imports):
 * panel/status components are Svelte components in the browser, pilot
 * function components in headless tests.
 */
export interface HelloUIComponents {
	readonly panelComponent: any;
	readonly statusComponent: any;
}

export function getHelloUIComponents(
	host: Pick<PluginHostInterface, 'getService'>
): HelloUIComponents | undefined {
	return host.getService<HelloUIComponents>(HELLO_UI_COMPONENTS_KEY);
}
