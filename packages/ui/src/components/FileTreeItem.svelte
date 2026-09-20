<script lang="ts">
	import { useAppState } from '@np/core';
	import type { VisualNode, TreeNode } from '@np/core';
	import { FileIcon, FolderIcon, FolderOpenIcon, CaretRightIcon, PlusIcon, FolderPlusIcon, TrashIcon, PencilSimpleIcon } from "phosphor-svelte";
	import { cn } from '@np/core';
	import * as ContextMenu from './ui/context-menu';
	import { tick } from "svelte";
	import Icon from './Icon.svelte';
	import FileTreeItem from "./FileTreeItem.svelte";
	import { toURI } from '@np/core';

	const appState = useAppState();

	let { visualNode } = $props<{ visualNode: VisualNode }>();
	let isRenaming = $state(false);
	let renamingIndex = $state<number | null>(null);
	let menuTargetIndex = $state<number | null>(null);
	let menuOpen = $state(false);
	let menuArmed = $state(false);
	let focusedSegIndex = $state<number | null>(null);
	let newName = $state("");
	let inputRef = $state<HTMLInputElement | null>(null);

	// A folded row only earns its menu from a segment right-click or keyboard
	// activation (which falls back to the focused/leaf segment). If the menu
	// opens without one (gap, caret, icon, mouse), force it shut and drop
	// any stale target so it can never act on the wrong level. Closing the
	// menu always clears the target for the same reason.
	$effect(() => {
		if (!menuOpen) {
			menuArmed = false;
			menuTargetIndex = null;
		} else if (isFolded && !menuArmed) {
			menuOpen = false;
		}
	});

	// A folded row (a/b/c) renders one segment per chain level so each level
	// gets its own hover background and context menu.
	let isFolded = $derived(visualNode.kind === 'directory' && visualNode.chain.length > 1);

	/** Chain node targeted by the open context menu (unfolded rows fall back to the leaf). Only called while armed. */
	function menuTargetNode(): TreeNode {
		const chain = visualNode.chain;
		const idx = menuTargetIndex ?? chain.length - 1;
		return chain[Math.min(Math.max(idx, 0), chain.length - 1)];
	}

	function handleRowContextMenu(e: MouseEvent) {
		// Never let our menu hijack the rename input's native edit menu.
		if ((e.target as Element)?.closest?.('input')) {
			e.stopPropagation();
			return;
		}
		if (isRenaming) {
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		if (isFolded) {
			const seg = (e.target as Element)?.closest?.('[data-seg]');
			if (seg) {
				menuTargetIndex = Number((seg as HTMLElement).dataset.seg);
				menuArmed = true;
				// Let the event bubble to the ContextMenu trigger.
			} else if ((e as MouseEvent).clientX === 0 && (e as MouseEvent).clientY === 0) {
				// Keyboard activation (Shift+F10 / Menu key) targets the row
				// button itself, so there is no segment under the cursor.
				// Fall back to the focused segment in this row, if any,
				// otherwise the leaf, so keyboard users can still open the menu.
				const chain = visualNode.chain;
				let idx = chain.length - 1;
				if (focusedSegIndex !== null && focusedSegIndex >= 0 && focusedSegIndex < chain.length) {
					idx = focusedSegIndex;
				} else {
					const rowEl = e.currentTarget as Element | null;
					const active = document.activeElement as HTMLElement | null;
					if (active && rowEl?.contains(active) && active.hasAttribute('data-seg')) {
						const n = Number(active.dataset.seg);
						if (!Number.isNaN(n)) idx = Math.min(Math.max(n, 0), chain.length - 1);
					}
				}
				menuTargetIndex = idx;
				menuArmed = true;
				// Let the event bubble to the ContextMenu trigger.
			} else {
				// Caret, icon, separators, padding: ambiguous which level is
				// meant, so show no menu at all.
				e.preventDefault();
				e.stopPropagation();
				menuTargetIndex = null;
				menuArmed = false;
			}
		}
	}

	async function handleClick() {
		if (isRenaming) return;
		menuTargetIndex = null;
		menuArmed = false;
		if (visualNode.kind === 'directory') {
			await appState.workspace.projectTree.toggleVisualExpand(visualNode);
		} else {
			await appState.workspace.openFile(visualNode.origin);
		}
	}

	async function createNewFile() {
		const name = prompt("Enter file name (e.g. notes.md)");
		if (!name) return;
		if (visualNode.kind === 'directory') {
			const target = menuTargetNode();
			await appState.workspace.projectTree.createFile(target.origin, name, target);
		} else if (visualNode.parentOrigin) {
			await appState.workspace.projectTree.createFile(visualNode.parentOrigin, name);
		}
	}

	async function createNewFolder() {
		const name = prompt("Enter folder name");
		if (!name) return;
		if (visualNode.kind === 'directory') {
			const target = menuTargetNode();
			await appState.workspace.projectTree.createDirectory(target.origin, name, target);
		} else if (visualNode.parentOrigin) {
			await appState.workspace.projectTree.createDirectory(visualNode.parentOrigin, name);
		}
	}

	async function deleteEntry() {
		if (visualNode.kind === 'directory') {
			const chain = visualNode.chain;
			const idx = Math.min(menuTargetIndex ?? chain.length - 1, chain.length - 1);
			const target = chain[idx];
			if (idx < chain.length - 1) {
				const subpath = chain.slice(idx).map((n: { name: string }) => n.name).join('/');
				if (confirm(`Are you sure you want to delete ${subpath} and everything inside it?`)) {
					await appState.workspace.projectTree.deleteEntry(target);
				}
			} else if (confirm(`Are you sure you want to delete ${target.name}?`)) {
				await appState.workspace.projectTree.deleteEntry(target);
			}
		} else {
			if (confirm(`Are you sure you want to delete ${visualNode.name}?`)) {
				await appState.workspace.projectTree.deleteEntry(visualNode.originalNode);
			}
		}
	}

	async function startRename() {
		if (visualNode.kind === 'directory') {
			renamingIndex = menuTargetIndex ?? visualNode.chain.length - 1;
			newName = visualNode.chain[renamingIndex].name;
		} else {
			renamingIndex = 0;
			newName = visualNode.leafNode.name;
		}
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
		if (visualNode.kind === 'directory' && renamingIndex !== null) {
			const target = visualNode.chain[Math.min(renamingIndex, visualNode.chain.length - 1)];
			if (trimmedName && trimmedName !== target.name) {
				await appState.workspace.projectTree.renameEntry(target, trimmedName);
			}
		} else if (trimmedName && trimmedName !== visualNode.leafNode.name) {
			await appState.workspace.projectTree.renameEntry(visualNode.leafNode, trimmedName);
		}
		isRenaming = false;
		renamingIndex = null;
		menuTargetIndex = null;
	}

	function cancelRename() {
		isRenaming = false;
		renamingIndex = null;
		menuTargetIndex = null;
	}

	function handleInputKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			finishRename();
		} else if (e.key === 'Escape') {
			cancelRename();
		}
	}
</script>

<ContextMenu.Root bind:open={menuOpen}>
	<ContextMenu.Trigger>
		<div class="group">
			<button
				class={cn(
					"flex items-center w-[calc(100%-8px)] mx-1 gap-2 px-2 py-1 text-[11px] rounded transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring text-left",
					isFolded
						? "hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground"
						: "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
					visualNode.kind === 'file' && appState.activeDocument?.origin && toURI(appState.activeDocument.origin) === toURI(visualNode.origin) && "bg-sidebar-accent text-sidebar-accent-foreground font-medium",
					isRenaming && "bg-sidebar-accent"
				)}
				style="padding-left: {8 + visualNode.depth * 12}px"
				onclick={handleClick}
				oncontextmenu={handleRowContextMenu}
			>
				{#if visualNode.kind === 'directory'}
					<CaretRightIcon
						class={cn(
							"size-3 opacity-60 shrink-0 transition-transform duration-200",
							visualNode.isExpanded && "rotate-90"
						)}
					/>
					<Icon
						resource={visualNode.leafNode.name}
						type="folder"
						folderOpen={visualNode.isExpanded}
						phosphorFallback={visualNode.isExpanded ? FolderOpenIcon : FolderIcon}
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
				{:else if isFolded}
					<span class="min-w-0 flex-1 truncate">
						{#each visualNode.chain as segNode, i (toURI(segNode.origin))}
							{#if i > 0}<span class="opacity-60 select-none">/</span>{/if}<span data-seg={i} role="button" tabindex="0" aria-label={segNode.name} onfocus={() => (focusedSegIndex = i)} onblur={() => { if (focusedSegIndex === i) focusedSegIndex = null; }} class="rounded inline-block p-0.5 hover:bg-accent hover:text-accent-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">{segNode.name}</span>
						{/each}
					</span>
				{:else}
					<span class="truncate py-0.5">{visualNode.name}</span>
				{/if}
			</button>
		</div>
	</ContextMenu.Trigger>
	<ContextMenu.Content>
		<ContextMenu.Item onclick={createNewFile}>
			<PlusIcon/>
			New File
		</ContextMenu.Item>
		<ContextMenu.Item onclick={createNewFolder}>
			<FolderPlusIcon/>
			New Folder
		</ContextMenu.Item>
		<ContextMenu.Separator />
		<ContextMenu.Item onclick={startRename}>
			<PencilSimpleIcon/>
			Rename
		</ContextMenu.Item>
		<ContextMenu.Item onclick={deleteEntry} class="text-destructive">
			<TrashIcon/>
			Delete
		</ContextMenu.Item>
	</ContextMenu.Content>
</ContextMenu.Root>

{#if visualNode.kind === 'directory' && visualNode.isExpanded && visualNode.children}
	<div class="flex flex-col">
		{#each visualNode.children as child (toURI(child.originalNode.origin))}
			<FileTreeItem visualNode={child} />
		{/each}
	</div>
{/if}
