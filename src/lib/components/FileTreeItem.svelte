<script lang="ts">
	import { appState } from "$lib/state.svelte";
	import type { TreeNode } from "$lib/project/tree.svelte";
	import { File, Folder, CaretRight, CaretDown, Plus, FolderPlus, Trash, PencilSimple } from "phosphor-svelte";
	import { cn } from "$lib/utils";
	import * as ContextMenu from "$lib/components/ui/context-menu";
	import { tick } from "svelte";
	import Icon from "$lib/components/Icon.svelte";

	let { node, depth = 0 } = $props<{ node: TreeNode; depth: number }>();
	let isRenaming = $state(false);
	let newName = $state("");
	let inputRef = $state<HTMLInputElement | null>(null);

	async function handleClick() {
		if (isRenaming) return;
		if (node.kind === 'directory') {
			appState.workspace.projectTree.toggleExpand(node);
		} else {
			await appState.workspace.openFile(node.handle as FileSystemFileHandle);
		}
	}

	async function createNewFile() {
		const name = prompt("Enter file name (e.g. notes.md)");
		if (!name) return;
		const parent = node.kind === 'directory' ? node.handle : node.parentHandle;
		if (parent instanceof FileSystemDirectoryHandle) {
			await appState.workspace.projectTree.createFile(parent, name);
		}
	}

	async function createNewFolder() {
		const name = prompt("Enter folder name");
		if (!name) return;
		const parent = node.kind === 'directory' ? node.handle : node.parentHandle;
		if (parent instanceof FileSystemDirectoryHandle) {
			await appState.workspace.projectTree.createDirectory(parent, name);
		}
	}

	async function deleteEntry() {
		if (confirm(`Are you sure you want to delete ${node.name}?`)) {
			await appState.workspace.projectTree.deleteEntry(node);
		}
	}

	async function startRename() {
		newName = node.name;
		isRenaming = true;
		await tick();
		if (inputRef) {
			inputRef.focus();
			// Select name without extension if it's a file
			const dotIndex = newName.lastIndexOf('.');
			if (node.kind === 'file' && dotIndex > 0) {
				inputRef.setSelectionRange(0, dotIndex);
			} else {
				inputRef.select();
			}
		}
	}

	async function finishRename() {
		if (!isRenaming) return;
		const trimmedName = newName.trim();
		if (trimmedName && trimmedName !== node.name) {
			await appState.workspace.projectTree.renameEntry(node, trimmedName);
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
					"flex items-center w-full gap-2 px-3 py-1 text-xs transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring",
					node.kind === 'file' && appState.activeDocument?.origin?.handle === node.handle && "bg-sidebar-accent text-sidebar-accent-foreground font-medium",
					isRenaming && "bg-sidebar-accent"
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
					<Icon icon={appState.icons.getFileIcon(node.name)} class="size-4 opacity-90" />
				{/if}
				
				{#if isRenaming}
					<input
						bind:this={inputRef}
						bind:value={newName}
						onkeydown={handleInputKeydown}
						onblur={finishRename}
						class="flex-1 bg-background border border-primary/50 rounded px-1 -mx-1 h-[1.25rem] text-xs outline-none focus:ring-1 focus:ring-primary/30"
					/>
				{:else}
					<span class="truncate py-0.5">{node.name}</span>
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

{#if node.kind === 'directory' && node.isExpanded && node.children}
		<div class="flex flex-col">
			{#each node.children as child}
				<svelte:self node={child} depth={depth + 1} />
			{/each}
		</div>
	{/if}
