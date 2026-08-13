<script lang="ts">
	import { useAppState } from '@np/core/state.svelte';
	import {
		ArrowUDownLeftIcon, MinusIcon, PlusIcon,
		GitDiffIcon, FileArrowUpIcon
	} from 'phosphor-svelte';
	import Icon from './Icon.svelte';
	import type { GitChange, GroupedChange } from '@np/core';
	import * as ContextMenu from './ui/context-menu';
	import * as Tooltip from './ui/tooltip/index';
	import GitStatusChip from './GitStatusChip.svelte';

	let {
		change,
		isStaged,
		showPath = false,
		isSelected = false,
		isActive = false,
		dense = false,
		selectedPaths,
		onclick,
	}: {
		change: GroupedChange;
		isStaged: boolean;
		showPath?: boolean;
		isSelected?: boolean;
		isActive?: boolean;
		dense?: boolean;
		selectedPaths?: Set<string>;
		onclick?: (e: MouseEvent | KeyboardEvent) => void;
	} = $props();

	const appState = useAppState();

	let fileName = $derived(change.filepath.split('/').pop());
	let folderPath = $derived(change.filepath.substring(0, change.filepath.lastIndexOf('/')));

	async function triggerAction(action: 'stage' | 'unstage' | 'discard' | 'diff' | 'open') {
		const targets = selectedPaths?.has(change.filepath) 
			? Array.from(selectedPaths) 
			: [change.filepath];

		if (action === 'stage' || action === 'unstage' || action === 'discard') {
			const commandId = `git.${action}`;
			for (const path of targets) {
				await appState.commands.execute(commandId, path);
			}
		} else if (action === 'diff') {
			appState.commands.execute('git.openDiff', change.filepath);
		} else if (action === 'open') {
			appState.commands.execute('file.openPath', change.filepath);
		}
	}
</script>

<ContextMenu.Root>
	<ContextMenu.Trigger>
		<div
			role="button"
			tabindex="0"
			{onclick}
			onkeydown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					onclick?.(e);
				}
			}}
			class="group flex items-center justify-between px-2 py-1 rounded transition-colors border border-transparent {dense ? 'py-0.5' : ''} {isSelected || isActive ? 'bg-sidebar-accent' : ''} {isActive ? 'border-border' : ''}"
		>
			<div class="flex items-center gap-1.5 min-w-0">
				{#if isStaged}
					<GitStatusChip status="S" />
				{:else}
					<GitStatusChip status={change.status} />
				{/if}
				<Icon resource={change.filepath} size={14} class="shrink-0" />
				<span class="truncate text-foreground/90 font-medium">{fileName}</span>
				{#if showPath && folderPath}
					<span class="text-[9px] text-muted-foreground/60 truncate max-w-[100px]">{folderPath}</span>
				{/if}
			</div>
			
			<div class="relative flex items-center gap-1.5 shrink-0">
				{#if change.additions > 0 || change.deletions > 0}
					<div class="flex items-center gap-1 text-[9px] font-mono mr-1 opacity-80 group-hover:opacity-0 group-focus-within:opacity-0 transition-opacity">
						{#if change.additions > 0}<span class="text-primary">+{change.additions}</span>{/if}
						{#if change.deletions > 0}<span class="text-destructive">-{change.deletions}</span>{/if}
					</div>
				{/if}
				
				<div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
					{#if isStaged}
						<Tooltip.Root>
							<Tooltip.Trigger>
								{#snippet child({ props })}
									<button 
										{...props}
										type="button"
										aria-label="Unstage change"
										onclick={(e) => { e.stopPropagation(); appState.commands.execute('git.unstage', change.filepath); }}
										class="p-0.5 rounded bg-muted/40 hover:bg-muted text-muted-foreground hover:text-foreground transition-opacity"
									>
										<MinusIcon size={10} />
									</button>
								{/snippet}
							</Tooltip.Trigger>
							<Tooltip.Content side="top" align="center" class="text-[10px] px-2 py-1">
								Unstage change
							</Tooltip.Content>
						</Tooltip.Root>
					{:else}
						<Tooltip.Root>
							<Tooltip.Trigger>
								{#snippet child({ props })}
									<button 
										{...props}
										type="button"
										aria-label="Discard changes"
										onclick={(e) => { e.stopPropagation(); appState.commands.execute('git.discard', change.filepath); }}
										class="p-0.5 rounded bg-muted/40 hover:bg-muted text-muted-foreground hover:text-destructive transition-opacity"
									>
										<ArrowUDownLeftIcon size={10} />
									</button>
								{/snippet}
							</Tooltip.Trigger>
							<Tooltip.Content side="top" align="center" class="text-[10px] px-2 py-1">
								Discard changes
							</Tooltip.Content>
						</Tooltip.Root>
						<Tooltip.Root>
							<Tooltip.Trigger>
								{#snippet child({ props })}
									<button 
										{...props}
										type="button"
										aria-label="Stage change"
										onclick={(e) => { e.stopPropagation(); appState.commands.execute('git.stage', change.filepath); }}
										class="p-0.5 rounded bg-muted/40 hover:bg-muted text-muted-foreground hover:text-foreground transition-opacity"
									>
										<PlusIcon size={10} />
									</button>
								{/snippet}
							</Tooltip.Trigger>
							<Tooltip.Content side="top" align="center" class="text-[10px] px-2 py-1">
								Stage change
							</Tooltip.Content>
						</Tooltip.Root>
					{/if}
				</div>
			</div>
		</div>
	</ContextMenu.Trigger>
	<ContextMenu.Content class="w-48 font-sans">
		{#if isStaged}
			<ContextMenu.Item onclick={() => triggerAction('unstage')}>
				<MinusIcon size={11} />
				Unstage File
				<ContextMenu.Shortcut>
					{appState.keymaps.getShortcutForCommand('git.unstage')}
				</ContextMenu.Shortcut>
			</ContextMenu.Item>
		{:else}
			<ContextMenu.Item onclick={() => triggerAction('stage')}>
				<PlusIcon size={11} />
				Stage File
				<ContextMenu.Shortcut>
					{appState.keymaps.getShortcutForCommand('git.stage')}
				</ContextMenu.Shortcut>
			</ContextMenu.Item>
			<ContextMenu.Item
				onclick={() => triggerAction('discard')}
				class="text-destructive focus:text-destructive hover:!bg-destructive/10"
			>
				<ArrowUDownLeftIcon size={11} />
				Discard Changes
				<ContextMenu.Shortcut>
					{appState.keymaps.getShortcutForCommand('git.discard')}
				</ContextMenu.Shortcut>
			</ContextMenu.Item>
		{/if}
		<ContextMenu.Separator />
		<ContextMenu.Item onclick={() => triggerAction('diff')}>
			<GitDiffIcon size={11} />
			Open Diff
			<ContextMenu.Shortcut>
				{appState.keymaps.getShortcutForCommand('git.openDiff')}
			</ContextMenu.Shortcut>
		</ContextMenu.Item>
		<ContextMenu.Item onclick={() => triggerAction('open')}>
			<FileArrowUpIcon size={11} />
			Open File
			<ContextMenu.Shortcut>
				{appState.keymaps.getShortcutForCommand('file.openPath')}
			</ContextMenu.Shortcut>
		</ContextMenu.Item>
	</ContextMenu.Content>
</ContextMenu.Root>
