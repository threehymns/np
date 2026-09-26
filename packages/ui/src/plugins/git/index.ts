import type { PluginHostInterface } from '@np/core';
import {
	gitManifest,
	type UIContributionComponent,
	type UIContributionIcon
} from '@np/core';
import { GitDiffIcon, GitMergeIcon } from 'phosphor-svelte';
import GitDiffContent from './GitDiffContent.svelte';
import GitPanel from './GitPanel.svelte';
import GitStatusBarItem from './GitStatusBarItem.svelte';

const GIT_UI_COMPONENTS_KEY = `${gitManifest.id}:ui-components`;

interface GitUIComponents {
	panelComponent: UIContributionComponent;
	panelIcon?: UIContributionIcon;
	statusComponent: UIContributionComponent;
	diffComponent?: UIContributionComponent;
	diffIcon?: UIContributionIcon;
}

const gitUIComponents = {
	panelComponent: GitPanel as unknown as UIContributionComponent,
	panelIcon: GitMergeIcon as unknown as UIContributionIcon,
	statusComponent: GitStatusBarItem as unknown as UIContributionComponent,
	diffComponent: GitDiffContent as unknown as UIContributionComponent,
	diffIcon: GitDiffIcon as unknown as UIContributionIcon
} satisfies GitUIComponents;

export function provideGitUIComponents(host: PluginHostInterface): void {
	host.provideService(GIT_UI_COMPONENTS_KEY, gitUIComponents);
}

export { GitPanel, GitStatusBarItem };
