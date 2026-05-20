<script lang="ts">
	import { appState } from "$lib/state.svelte";
	import FileTreeItem from "./FileTreeItem.svelte";
	import { FolderOpen, ArrowsClockwise, MagnifyingGlass, X } from "phosphor-svelte";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";

	async function refresh() {
		if (appState.workspace.rootHandle) {
			await appState.workspace.projectTree.scan(appState.workspace.rootHandle);
		}
	}

	function clearSearch() {
		appState.workspace.projectTree.searchQuery = "";
	}
</script>

<div class="flex flex-col h-full bg-sidebar text-sidebar-foreground border-r overflow-hidden select-none">
	<div class="flex items-center justify-between px-4 py-2 border-b">
		<span class="text-xs font-bold tracking-wider uppercase opacity-60">Explorer</span>
		<div class="flex gap-1">
			<Button variant="ghost" size="icon-sm" onclick={refresh} title="Refresh Explorer">
				<ArrowsClockwise class="size-3.5" />
			</Button>
			<Button variant="ghost" size="icon-sm" onclick={() => appState.workspace.openDirectory()} title="Open Folder">
				<FolderOpen class="size-3.5" />
			</Button>
		</div>
	</div>

	{#if appState.workspace.rootHandle}
		<div class="px-3 py-2">
			<div class="relative group">
				<MagnifyingGlass class="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 opacity-40 group-focus-within:opacity-80 transition-opacity" />
				<input
					type="text"
					placeholder="Search files..."
					bind:value={appState.workspace.projectTree.searchQuery}
					class="w-full bg-background/50 border-none rounded-md pl-7 pr-7 py-1.5 text-[11px] outline-none ring-1 ring-border/50 focus:ring-primary/40 transition-all placeholder:opacity-50"
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

	<div class="flex-1 overflow-auto py-1">
		{#if appState.workspace.rootHandle}
			<div class="px-2 mb-1">
				<div class="flex items-center gap-2 px-2 py-1 text-[11px] font-semibold opacity-50 truncate">
					{appState.workspace.rootHandle.name}
				</div>
			</div>
			
			<div class="space-y-0.5">
				{#each appState.workspace.projectTree.filteredNodes as node}
					<FileTreeItem {node} depth={0} />
				{/each}
			</div>
			
			{#if appState.workspace.projectTree.searchQuery && appState.workspace.projectTree.filteredNodes.length === 0}
				<div class="px-6 py-10 text-center">
					<p class="text-xs opacity-40">No matches found</p>
				</div>
			{/if}
		{:else}
			<div class="flex flex-col items-center justify-center h-40 px-6 text-center">
				<FolderOpen class="size-8 mb-3 opacity-20" />
				<p class="text-xs opacity-50 mb-4">No folder opened</p>
				<Button variant="outline" size="sm" onclick={() => appState.workspace.openDirectory()}>
					Open Folder
				</Button>
			</div>
		{/if}
	</div>
</div>
