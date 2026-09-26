import type { PluginHostInterface } from '../types';
import type { UIContributionComponent, UIContributionIcon } from '../ui-contributions';

/**
 * Git UI contribution metadata and service bridge (#203).
 *
 * Headless module (no Svelte imports): defines the sidebar panel IDs,
 * titles, and ordering for the Git Core Plugin, plus the
 * generic service key through which the UI layer provides real Svelte
 * components. The host itself never names Git (ADR 0008): it only offers
 * opaque `provideService` / `getService`; this key is a convention owned by
 * the Git plugin's core setup (consumer) and the UI plugin bridge
 * (provider, in `@np/ui`), never by the host.
 *
 * Headless tests (Bun, no Svelte compiler) run without the UI service and
 * fall back to pilot components, proving the registration wiring without
 * importing `.svelte` files into `@np/core`.
 */

export const GIT_PANEL_ID = 'git';
export const GIT_PANEL_TITLE = 'Source Control';
export const GIT_PANEL_ORDER = 20;

/**
 * Generic service key for Git UI components. Value shape is owned by this
 * module (consumer) and the UI bridge (provider); the host treats it as
 * opaque (ADR 0008, #202 services precedent).
 */
export const GIT_UI_COMPONENTS_KEY = 'git:ui-components';

/**
 * Real UI components provided by the UI layer (`packages/ui/src/plugins/git`).
 * The module stays headless (no Svelte imports): the panel component is a
 * Svelte component in the browser, a pilot function component in headless
 * tests.
 */
export interface GitUIComponents {
	readonly panelComponent: UIContributionComponent;
	readonly panelIcon?: UIContributionIcon;
	readonly diffComponent?: UIContributionComponent;
	readonly diffIcon?: UIContributionIcon;
}

export function getGitUIComponents(
	host: Pick<PluginHostInterface, 'getService'>
): GitUIComponents | undefined {
	return host.getService<GitUIComponents>(GIT_UI_COMPONENTS_KEY);
}
