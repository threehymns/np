<script lang="ts">
  import BranchSelectButton from './BranchSelectButton.svelte';

	import { useAppState } from '@np/core';
	import FileTreeItem from "./FileTreeItem.svelte";
	import { FolderOpen, ArrowsClockwise, X, Funnel } from "phosphor-svelte";
	import { Button } from './ui/button';
	import { ScrollArea } from "./ui/scroll-area/index.js";
	import * as Tooltip from './ui/tooltip/index.js';
	import { toURI, cn } from '@np/core';
	import { slide } from "svelte/transition";
	import { onMount } from "svelte";

	const appState = useAppState();

	let showFilter = $state(false);
	let mounted = $state(false);

	onMount(() => {
		mounted = true;
	});

	function toggleFilter() {
		showFilter = !showFilter;
		if (!showFilter) {
			appState.workspace.projectTree.searchQuery = "";
		}
	}

	async function refresh() {
		if (appState.workspace.rootOrigin) {
			if (appState.workspace.repository) {
				await appState.workspace.repository.refresh();
			}
			await appState.workspace.projectTree.scan(appState.workspace.rootOrigin);
		}
	}

	function clearSearch() {
		appState.workspace.projectTree.searchQuery = "";
	}

</script>

<div class="flex flex-col h-full text-sidebar-foreground overflow-hidden select-none">
	{#if mounted && appState.workspace.rootOrigin}
		{@const rootOrigin = appState.workspace.rootOrigin}
		<div class="px-2 py-1 shrink-0">
			<div class="flex items-center justify-between px-2 py-1 text-[11px] font-semibold opacity-60 group/header">
				<div class="flex items-center gap-1 min-w-0">

					<BranchSelectButton/>
				</div>


				<div class="flex gap-0.5 shrink-0 opacity-0 pointer-events-none group-hover/header:opacity-100 group-hover/header:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto transition-opacity">
					<Tooltip.Provider delayDuration={400}>
						<Tooltip.Root>
							<Tooltip.Trigger>
								{#snippet child({ props })}
									<Button variant="ghost" size="icon-xs" {...props} onclick={toggleFilter} class={cn(showFilter ? 'bg-sidebar-accent text-sidebar-accent-foreground' : '', "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground")}>
										<Funnel class="size-3" />
									</Button>
								{/snippet}
							</Tooltip.Trigger>
							<Tooltip.Content side="top" align="center" class="text-[10px] px-2 py-1">
								Filter Files
							</Tooltip.Content>
						</Tooltip.Root>
						<Tooltip.Root>
							<Tooltip.Trigger>
								{#snippet child({ props })}
									<Button variant="ghost" size="icon-xs" {...props} onclick={refresh} class="hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
										<ArrowsClockwise class="size-3" />
									</Button>
								{/snippet}
							</Tooltip.Trigger>
							<Tooltip.Content side="top" align="center" class="text-[10px] px-2 py-1">
								Refresh Explorer
							</Tooltip.Content>
						</Tooltip.Root>
						<Tooltip.Root>
							<Tooltip.Trigger>
								{#snippet child({ props })}
									<Button variant="ghost" size="icon-xs" {...props} onclick={() => appState.workspace.openDirectory()} class="hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
										<FolderOpen class="size-3" />
									</Button>
								{/snippet}
							</Tooltip.Trigger>
							<Tooltip.Content side="top" align="center" class="text-[10px] px-2 py-1">
								Open Folder
							</Tooltip.Content>
						</Tooltip.Root>
					</Tooltip.Provider>
				</div>
			</div>

			{#if showFilter}
				<div transition:slide={{ duration: 200 }} class="px-2 py-1.5">
					<div class="relative group">
						<Funnel class="absolute left-2 top-1/2 -translate-y-1/2 size-3 opacity-40 group-focus-within:opacity-80 transition-opacity" />
						<!-- svelte-ignore a11y_autofocus -->
						<input
							type="text"
							autofocus
							placeholder="Filter files by name..."
							bind:value={appState.workspace.projectTree.searchQuery}
							class="w-full bg-sidebar-accent/50 border-none rounded-md pl-7 pr-7 py-1 text-[11px] outline-none ring-1 ring-sidebar-border/50 focus:ring-sidebar-ring/40 transition-all placeholder:opacity-50"
						/>
						{#if appState.workspace.projectTree.searchQuery}
							<button 
								onclick={clearSearch}
								class="absolute right-2 top-1/2 -translate-y-1/2 opacity-40 hover:opacity-100 transition-opacity"
							>
								<X class="size-3" />
							</button>
						{/if}
					</div>
				</div>
			{/if}
		</div>
	{/if}

	<ScrollArea class="flex-1 min-h-0 py-1">
		{#if mounted}
			{#if appState.workspace.rootOrigin}
				<div class="space-y-0.5">
					{#if appState.workspace.hasRootPermission}
						{#each appState.workspace.projectTree.visualNodes as visualNode (toURI(visualNode.originalNode.origin))}
							<FileTreeItem {visualNode} />
						{/each}
					{:else}
						<div class="px-6 py-10 text-center">
							<FolderOpen class="size-8 mx-auto mb-3 opacity-20" />
							<p class="text-[11px] opacity-60 mb-4 px-2">Access to this folder needs to be restored.</p>
							<Button 
								variant="outline" 
								size="sm" 
								onclick={() => appState.workspace.requestRootPermission()} 
								class="h-7 text-[10px] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground border-sidebar-border"
							>
								Grant Permission
							</Button>
						</div>
					{/if}
				</div>
				
				{#if appState.workspace.projectTree.searchQuery && appState.workspace.projectTree.isSearching}
					<div class="px-6 py-10 text-center">
						<div class="inline-block animate-spin size-4 border-2 border-primary border-t-transparent rounded-full mb-2"></div>
						<p class="text-xs opacity-40">Searching...</p>
					</div>
				{:else if appState.workspace.projectTree.searchQuery && appState.workspace.projectTree.visualNodes.length === 0}
					<div class="px-6 py-10 text-center">
						<p class="text-xs opacity-40">No matches found</p>
					</div>
				{/if}
			{:else}
				<div class="flex flex-col items-center justify-center h-40 px-6 text-center">
					<FolderOpen class="size-8 mb-3 opacity-20" />
					<p class="text-xs opacity-50 mb-4">No folder opened</p>
					<Button variant="outline" size="sm" onclick={() => appState.workspace.openDirectory()} class="hover:bg-sidebar-accent hover:text-sidebar-accent-foreground border-sidebar-border">
						Open Folder
					</Button>
				</div>
			{/if}
		{/if}
	</ScrollArea>
</div>

<style>
	:global([data-slot="scroll-area-viewport"]::-webkit-scrollbar) {
		display: none;
	}
	:global([data-slot="scroll-area-viewport"]) {
		scrollbar-width: none;
	}
</style>
