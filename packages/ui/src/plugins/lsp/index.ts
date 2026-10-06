import type { PluginHostInterface } from '@np/core';
import {
	LSP_UI_COMPONENTS_KEY,
	type LspUIComponents,
	type UIContributionComponent,
	type UIContributionIcon
} from '@np/core';
import { TerminalWindowIcon } from 'phosphor-svelte';
import LspLogsContent from './LspLogsContent.svelte';
import LspStatusItem from './LspStatusItem.svelte';

/**
 * Real LSP UI components, provided to the plugin through the loader service
 * (ADR 0010).
 *
 * The status item and the Logs tab are whole components because a status bar
 * contribution carries no menu and a tab carries no toolbar: the shell renders
 * each one raw with its props.
 */

const lspUIComponents = {
	statusItemComponent: LspStatusItem as unknown as UIContributionComponent,
	logsComponent: LspLogsContent as unknown as UIContributionComponent,
	logsIcon: TerminalWindowIcon as unknown as UIContributionIcon
} satisfies LspUIComponents;

export function provideLspUIComponents(host: PluginHostInterface): void {
	host.provideService(LSP_UI_COMPONENTS_KEY, lspUIComponents);
}

export { LspLogsContent, LspStatusItem };
