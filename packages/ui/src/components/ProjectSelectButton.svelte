<script lang="ts">
	import { useAppState, toURI, type FileOrigin } from '@np/core';
	import { FolderOpen } from 'phosphor-svelte';
	import PickerPopover from './PickerPopover.svelte';
	import type { PickerRow } from './picker-row';
	import Button, { type ButtonSize } from './ui/button/button.svelte';


	const appState = useAppState();
	const workspace = appState.workspace;
	let { open = $bindable(false), size = 'default', class: className = '' }: { open?: boolean; size?: ButtonSize; class?: string } = $props();
	let root = $derived(workspace.project.rootOrigin);

	async function select(origin?: FileOrigin) {
		if (workspace.projectMutationBusy) return;
		open = false;
		await workspace.openDirectory(origin);
	}

	function toDisplayPath(origin: FileOrigin): string {
		return origin.scheme === 'file' ? origin.path : toURI(origin);
	}

	let rows = $derived(
		workspace.recentFolders.map((folder): PickerRow => {
			const uri = toURI(folder);
			return {
				key: uri,
				value: folder.path,
				keywords: [folder.name, folder.path],
				label: folder.name,
				description: toDisplayPath(folder),
				tooltip: toDisplayPath(folder),
				current: uri === workspace.projectUri
			};
		})
	);

	function selectRow(item: PickerRow) {
		const folder = workspace.recentFolders.find((candidate) => toURI(candidate) === item.key);
		if (folder) void select(folder);
	}
</script>

{#if root}
	<PickerPopover
		bind:open
		{size}
		label={root.name}
		ariaLabel={`Switch project: ${root.name}`}
		tooltip={toDisplayPath(root)}
		popupLabel="Recent projects"
		inputLabel="Search recent projects"
		emptyText="No projects found."
		{rows}
		onSelect={selectRow}
		disabled={workspace.projectMutationBusy}
		busy={workspace.projectMutationBusy}
		class={className}
	>
		{#snippet row(item: PickerRow)}
			<div class="min-w-0 flex-1">
				<div class="truncate">{item.label}</div>
				<div class="truncate text-[10px] text-muted-foreground">{item.description}</div>
			</div>
			{#if item.current}
				<span class="shrink-0 text-[10px]">Current</span>
			{/if}
		{/snippet}
		{#snippet footer()}
			<button type="button" onclick={() => select()} disabled={workspace.projectMutationBusy} class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"><FolderOpen class="size-4" />Open Folder</button>
		{/snippet}
	</PickerPopover>
{:else}
	<Button
		type="button"
		onclick={() => select()}
		disabled={workspace.projectMutationBusy}
		aria-label="Open folder"
		variant="ghost"
		{size}
		class={className}
	>
		<FolderOpen />Open Folder
	</Button>
{/if}
