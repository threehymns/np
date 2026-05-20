<script lang="ts">
	import { appState } from "$lib/state.svelte";
	import FileTreeItem from "./FileTreeItem.svelte";
	import { FolderOpen, ArrowsClockwise } from "phosphor-svelte";
	import { Button } from "$lib/components/ui/button";

	async function refresh() {
		if (appState.workspace.rootHandle) {
			await appState.workspace.projectTree.scan(appState.workspace.rootHandle);
		}
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

	<div class="flex-1 overflow-auto py-2">
		{#if appState.workspace.rootHandle}
			<div class="px-2 mb-2">
				<div class="flex items-center gap-2 px-2 py-1 text-xs font-medium opacity-80 truncate">
					<FolderOpen class="size-4 shrink-0" />
					{appState.workspace.rootHandle.name}
				</div>
			</div>
			
			<div class="space-y-0.5">
				{#each appState.workspace.projectTree.nodes as node}
					<FileTreeItem {node} depth={0} />
				{/each}
			</div>
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
