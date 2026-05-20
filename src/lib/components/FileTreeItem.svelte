<script lang="ts">
	import { appState } from "$lib/state.svelte";
	import type { TreeNode } from "$lib/project/tree.svelte";
	import { File, Folder, CaretRight, CaretDown } from "phosphor-svelte";
	import { cn } from "$lib/utils";

	let { node, depth = 0 } = $props<{ node: TreeNode; depth: number }>();

	async function handleClick() {
		if (node.kind === 'directory') {
			appState.workspace.projectTree.toggleExpand(node);
		} else {
			await appState.workspace.openFile(node.handle as FileSystemFileHandle);
		}
	}
</script>

<div class="group">
	<button
		class={cn(
			"flex items-center w-full gap-2 px-3 py-1 text-xs transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
			node.kind === 'file' && appState.activeDocument?.origin?.handle === node.handle && "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
		)}
		style="padding-left: {12 + depth * 12}px"
		onclick={handleClick}
	>
		{#if node.kind === 'directory'}
			{#if node.isExpanded}
				<CaretDown class="size-3 opacity-60" />
				<Folder class="size-4 text-primary opacity-80" />
			{:else}
				<CaretRight class="size-3 opacity-60" />
				<Folder class="size-4 opacity-60" />
			{/if}
		{:else}
			<div class="size-3"></div>
			<File class="size-4 opacity-60" />
		{/if}
		
		<span class="truncate">{node.name}</span>
	</button>

	{#if node.kind === 'directory' && node.isExpanded && node.children}
		<div class="flex flex-col">
			{#each node.children as child}
				<svelte:self node={child} depth={depth + 1} />
			{/each}
		</div>
	{/if}
</div>
