<script lang="ts">
	import { useAppState } from '@np/core/state.svelte';
	import { 
		ArrowUDownLeftIcon, MinusIcon, PlusIcon,
		GitDiffIcon,

    FileArrowUpIcon

	} from 'phosphor-svelte';
	import Icon from './Icon.svelte';
	import type { GitChange, GroupedChange } from '@np/core';
	import * as ContextMenu from './ui/context-menu';
	import * as Tooltip from './ui/tooltip/index';

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

	function triggerAction(action: 'stage' | 'unstage' | 'discard' | 'diff' | 'open') {
		const targets = selectedPaths?.has(change.filepath) 
			? Array.from(selectedPaths) 
			: [change.filepath];

		if (action === 'stage') {
			targets.forEach(path => appState.commands.execute('git.stage', path));
		} else if (action === 'unstage') {
			targets.forEach(path => appState.commands.execute('git.unstage', path));
		} else if (action === 'discard') {
			targets.forEach(path => appState.commands.execute('git.discard', path));
		} else if (action === 'diff') {
			appState.commands.execute('git.openDiff', change.filepath);
		} else if (action === 'open') {
			appState.commands.execute('editor.open', change.filepath);
		}
	}
</script>

{#snippet renderStatusChip(status: 'M' | 'A' | 'D' | 'S' | 'U')}
	{#if status === 'M'}
		<span class="text-[9px] font-bold px-1 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 font-mono scale-90 w-4 flex justify-center shrink-0">M</span>
	{:else if status === 'A' || status === 'U'}
		<span class="text-[9px] font-bold px-1 rounded bg-primary/10 text-primary font-mono scale-90 w-4 flex justify-center shrink-0">U</span>
	{:else if status === 'D'}
		<span class="text-[9px] font-bold px-1 rounded bg-destructive/10 text-destructive font-mono scale-90 w-4 flex justify-center shrink-0">D</span>
	{:else if status === 'S'}
		<span class="text-[9px] font-bold px-1 rounded bg-primary/10 text-primary font-mono scale-90 w-4 flex justify-center shrink-0">S</span>
	{/if}
{/snippet}

<ContextMenu.Root>
	<ContextMenu.Trigger>
		<div 
			role="button"
			tabindex="0"
			{onclick}
			onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && onclick?.(e)}
			class="group flex items-center justify-between px-2 py-1 rounded transition-colors border border-transparent {dense ? 'py-0.5' : ''} {isSelected || isActive ? 'bg-sidebar-accent' : ''} {isActive ? 'border-border' : ''}"
		>
			<div class="flex items-center gap-1.5 min-w-0">
				{#if isStaged}
					{@render renderStatusChip('S')}
				{:else}
					{@render renderStatusChip(change.status === 'A' ? 'U' : change.status)}
				{/if}
				<Icon resource={change.filepath} size={14} class="shrink-0" />
				<span class="truncate text-foreground/90 font-medium">{fileName}</span>
				{#if showPath && folderPath}
					<span class="text-[9px] text-muted-foreground/60 truncate max-w-[100px]">{folderPath}</span>
				{/if}
			</div>
			
			<div class="flex items-center gap-1.5 shrink-0">
				{#if change.additions > 0 || change.deletions > 0}
					<div class="flex items-center gap-1 text-[9px] font-mono mr-1 opacity-80 group-hover:hidden group-focus:hidden">
						{#if change.additions > 0}<span class="text-primary">+{change.additions}</span>{/if}
						{#if change.deletions > 0}<span class="text-destructive">-{change.deletions}</span>{/if}
					</div>
				{/if}
				
				<div class="hidden group-hover:flex items-center gap-1">
					<Tooltip.Provider delayDuration={400}>
						{#if isStaged}
							<Tooltip.Root>
								<Tooltip.Trigger>
									{#snippet child({ props })}
										<button 
											{...props}
											type="button"
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
					</Tooltip.Provider>
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
				{appState.keymaps.getShortcutForCommand('git.diff')}
			</ContextMenu.Shortcut>
		</ContextMenu.Item>
		<ContextMenu.Item onclick={() => triggerAction('open')}>
			<FileArrowUpIcon size={11} />
			Open File
			<ContextMenu.Shortcut>
				{appState.keymaps.getShortcutForCommand('git.open')}
			</ContextMenu.Shortcut>
		</ContextMenu.Item>
	</ContextMenu.Content>
</ContextMenu.Root>
