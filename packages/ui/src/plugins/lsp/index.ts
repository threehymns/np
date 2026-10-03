import type { PluginHostInterface } from '@np/core';
import {
	lspManifest,
	type UIContributionComponent,
	type UIContributionIcon
} from '@np/core';
import { TerminalWindowIcon } from 'phosphor-svelte';
import LspLogsContent from './LspLogsContent.svelte';
import LspStatusItem from './LspStatusItem.svelte';

/**
 * Real LSP UI components, provided to the plugin through the loader service
 * (ADR 0010). The key is derived from the manifest id for the same reason the
 * Git bridge derives its own: the host treats a service as opaque, so the two
 * sides agree on a string instead of the host learning a feature.
 *
 * The status item and the Logs tab are whole components because a status bar
 * contribution carries no menu and a tab carries no toolbar: the shell renders
 * each one raw with its props.
 */
const LSP_UI_COMPONENTS_KEY = `${lspManifest.id}:ui-components`;

interface LspUIComponents {
	statusItemComponent: UIContributionComponent;
	logsComponent: UIContributionComponent;
	logsIcon?: UIContributionIcon;
}

const lspUIComponents = {
	statusItemComponent: LspStatusItem as unknown as UIContributionComponent,
	logsComponent: LspLogsContent as unknown as UIContributionComponent,
	logsIcon: TerminalWindowIcon as unknown as UIContributionIcon
} satisfies LspUIComponents;

export function provideLspUIComponents(host: PluginHostInterface): void {
	host.provideService(LSP_UI_COMPONENTS_KEY, lspUIComponents);
}

export { LspLogsContent, LspStatusItem };
