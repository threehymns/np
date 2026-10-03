import type { PluginHostInterface } from '../types';
import type { UIContributionComponent, UIContributionIcon } from '../ui-contributions';

/**
 * UI contribution metadata and the service bridge for the LSP plugin
 * (spec #263, ticket #266, ADR 0010).
 *
 * Headless module (no Svelte imports), and the same arrangement as the Git
 * plugin's `ui.ts`: core declares the ids, the titles, the ordering and the key
 * the UI layer provides real components under, while the host itself never names
 * a feature (ADR 0008). A headless host publishes no components and falls back
 * to pilot components, which is how the registration wiring is asserted without
 * importing a `.svelte` file into `@np/core`.
 *
 * The components own their menus. A status bar item contribution carries an
 * id, an alignment, an order, a component and props, and the shell renders the
 * component raw — so the menu, its pickers and everything below it live in
 * `@np/ui` and reach the plugin's runtime through the service keys.
 */

export const LSP_STATUS_ITEM_ID = 'lsp-status';
export const LSP_STATUS_ITEM_ORDER = 30;

/**
 * Tab id of the Logs tab. Distinct from the contribution id, which is the
 * manifest id because the shell resolves a tab's content by plugin.
 */
export const LSP_LOGS_TAB_ID = '__lsp_logs__';
export const LSP_LOGS_TAB_TITLE = 'Logs';

export const LSP_UI_COMPONENTS_KEY = 'lsp:ui-components';

export interface LspUIComponents {
	readonly statusItemComponent: UIContributionComponent;
	readonly logsComponent: UIContributionComponent;
	readonly logsIcon?: UIContributionIcon;
}

export function getLspUIComponents(
	host: Pick<PluginHostInterface, 'getService'>
): LspUIComponents | undefined {
	return host.getService<LspUIComponents>(LSP_UI_COMPONENTS_KEY);
}