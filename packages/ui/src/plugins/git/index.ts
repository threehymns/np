import type { PluginHostInterface } from '@np/core';
import { gitManifest } from '@np/core';
import { GitDiffIcon, GitMergeIcon } from 'phosphor-svelte';
import GitDiffContent from './GitDiffContent.svelte';
import GitPanel from './GitPanel.svelte';
import GitStatusBarItem from './GitStatusBarItem.svelte';

const GIT_UI_COMPONENTS_KEY = `${gitManifest.id}:ui-components`;

export function provideGitUIComponents(host: PluginHostInterface): void {
	host.provideService(GIT_UI_COMPONENTS_KEY, {
		panelComponent: GitPanel,
		panelIcon: GitMergeIcon,
		statusComponent: GitStatusBarItem,
		diffComponent: GitDiffContent,
		diffIcon: GitDiffIcon
	});
}

export { GitPanel, GitStatusBarItem };
