<script lang="ts">
	import { appState } from "$lib/state.svelte";
	import FileTreeItem from "./FileTreeItem.svelte";
	import { FolderOpen, ArrowsClockwise, MagnifyingGlass, X, Funnel } from "phosphor-svelte";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import * as Tooltip from "$lib/components/ui/tooltip/index.js";
	import { slide } from "svelte/transition";
	import { cn } from "$lib/utils";

	let showFilter = $state(false);

	function toggleFilter() {
		showFilter = !showFilter;
		if (!showFilter) {
			appState.workspace.projectTree.searchQuery = "";
		}
	}

	async function refresh() {
		if (appState.workspace.rootHandle) {
			await appState.workspace.projectTree.scan(appState.workspace.rootHandle);
		}
	}

	function clearSearch() {
		appState.workspace.projectTree.searchQuery = "";
	}
</script>

<div class="flex flex-col h-full text-sidebar-foreground overflow-hidden select-none">
	<div class="flex-1 overflow-auto py-1">
		{#if appState.workspace.rootHandle}
			<div class="px-2 mb-1">
				<div class="flex items-center justify-between px-2 py-1 text-[11px] font-semibold opacity-60 group/header">
					<span class="truncate">{appState.workspace.rootHandle.name}</span>
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
			
			<div class="space-y-0.5">
				{#each appState.workspace.projectTree.visualNodes as visualNode (visualNode.name)}
					<FileTreeItem {visualNode} />
				{/each}
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
	</div>
</div>
