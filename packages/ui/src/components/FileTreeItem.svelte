<script lang="ts">
	import { useAppState } from '@np/core';
	import type { VisualNode } from '@np/core';
	import { File, Folder, FolderOpen, CaretRight, Plus, FolderPlus, Trash, PencilSimple } from "phosphor-svelte";
	import { cn } from '@np/core';
	import * as ContextMenu from './ui/context-menu';
	import { tick } from "svelte";
	import Icon from './Icon.svelte';
	import FileTreeItem from "./FileTreeItem.svelte";
	import { toURI } from '@np/core';

	const appState = useAppState();

	let { visualNode } = $props<{ visualNode: VisualNode }>();
	let isRenaming = $state(false);
	let newName = $state("");
	let inputRef = $state<HTMLInputElement | null>(null);

	async function handleClick() {
		if (isRenaming) return;
		if (visualNode.kind === 'directory') {
			await appState.workspace.projectTree.toggleExpand(visualNode.originalNode);
			// Sync expanded state for concatenated path segments
			if (visualNode.leafNode !== visualNode.originalNode) {
				visualNode.leafNode.isExpanded = visualNode.originalNode.isExpanded;
			}
		} else {
			await appState.workspace.openFile(visualNode.origin);
		}
	}

	async function createNewFile() {
		const name = prompt("Enter file name (e.g. notes.md)");
		if (!name) return;
		const parentOrigin = visualNode.kind === 'directory' ? visualNode.origin : visualNode.parentOrigin;
		if (parentOrigin) {
			await appState.workspace.projectTree.createFile(parentOrigin, name, visualNode.kind === 'directory' ? visualNode.leafNode : undefined);
		}
	}

	async function createNewFolder() {
		const name = prompt("Enter folder name");
		if (!name) return;
		const parentOrigin = visualNode.kind === 'directory' ? visualNode.origin : visualNode.parentOrigin;
		if (parentOrigin) {
			await appState.workspace.projectTree.createDirectory(parentOrigin, name, visualNode.kind === 'directory' ? visualNode.leafNode : undefined);
		}
	}

	async function deleteEntry() {
		if (confirm(`Are you sure you want to delete ${visualNode.name}?`)) {
			// Delete the original root folder of the chain since it contains the entire chain
			await appState.workspace.projectTree.deleteEntry(visualNode.originalNode);
		}
	}

	async function startRename() {
		newName = visualNode.leafNode.name; // Rename the leaf directory in the chain
		isRenaming = true;
		await tick();
		if (inputRef) {
			inputRef.focus();
			// Select name without extension if it's a file
			const dotIndex = newName.lastIndexOf('.');
			if (visualNode.kind === 'file' && dotIndex > 0) {
				inputRef.setSelectionRange(0, dotIndex);
			} else {
				inputRef.select();
			}
		}
	}

	async function finishRename() {
		if (!isRenaming) return;
		const trimmedName = newName.trim();
		if (trimmedName && trimmedName !== visualNode.leafNode.name) {
			await appState.workspace.projectTree.renameEntry(visualNode.leafNode, trimmedName);
		}
		isRenaming = false;
	}

	function handleInputKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			finishRename();
		} else if (e.key === 'Escape') {
			isRenaming = false;
		}
	}
</script>

<ContextMenu.Root>
	<ContextMenu.Trigger>
		<div class="group">
			<button
				class={cn(
					"flex items-center w-[calc(100%-8px)] mx-1 gap-2 px-2 py-1 text-[11px] rounded transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring text-left",
					visualNode.kind === 'file' && appState.activeDocument?.origin && toURI(appState.activeDocument.origin) === toURI(visualNode.origin) && "bg-sidebar-accent text-sidebar-accent-foreground font-medium",
					isRenaming && "bg-sidebar-accent"
				)}
				style="padding-left: {8 + visualNode.depth * 12}px"
				onclick={handleClick}
			>
				{#if visualNode.kind === 'directory'}
					<CaretRight 
						class={cn(
							"size-3 opacity-60 shrink-0 transition-transform duration-200", 
							visualNode.isExpanded && "rotate-90"
						)} 
					/>
					<Icon 
						resource={visualNode.leafNode.name}
						type="folder"
						folderOpen={visualNode.isExpanded}
						phosphorFallback={visualNode.isExpanded ? FolderOpen : Folder} 
						class="size-3.5 opacity-90 shrink-0" 
					/>
				{:else}
					<div class="size-3 shrink-0"></div>
					<Icon 
						resource={visualNode.name}
						type="file"
						phosphorFallback={File} 
						class="size-3.5 opacity-90 shrink-0" 
					/>
				{/if}
				
				{#if isRenaming}
					<input
						bind:this={inputRef}
						bind:value={newName}
						onkeydown={handleInputKeydown}
						onblur={finishRename}
						class="flex-1 bg-sidebar-accent border border-sidebar-primary/50 rounded px-1 -mx-1 h-[1.25rem] text-[11px] outline-none focus:ring-1 focus:ring-sidebar-ring/30"
					/>
				{:else}
					<span class="truncate py-0.5">{visualNode.name}</span>
				{/if}
			</button>
		</div>
	</ContextMenu.Trigger>
	<ContextMenu.Content>
		<ContextMenu.Item onclick={createNewFile}>
			<Plus class="mr-2 size-4" />
			New File
		</ContextMenu.Item>
		<ContextMenu.Item onclick={createNewFolder}>
			<FolderPlus class="mr-2 size-4" />
			New Folder
		</ContextMenu.Item>
		<ContextMenu.Separator />
		<ContextMenu.Item onclick={startRename}>
			<PencilSimple class="mr-2 size-4" />
			Rename
		</ContextMenu.Item>
		<ContextMenu.Item onclick={deleteEntry} class="text-destructive">
			<Trash class="mr-2 size-4" />
			Delete
		</ContextMenu.Item>
	</ContextMenu.Content>
</ContextMenu.Root>

{#if visualNode.kind === 'directory' && visualNode.isExpanded && visualNode.children}
	<div class="flex flex-col">
		{#each visualNode.children as child (toURI(child.origin))}
			<FileTreeItem visualNode={child} />
		{/each}
	</div>
{/if}
