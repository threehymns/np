<script lang="ts">
	import { useAppState, toURI, type FileOrigin } from '@np/core';
	import { CaretUpDown, FolderOpen } from 'phosphor-svelte';
	import * as Command from './ui/command';
	import * as Popover from './ui/popover';

	const appState = useAppState();
	const workspace = appState.workspace;
	let open = $state(false);
	let root = $derived(workspace.rootOrigin);

	async function select(origin?: FileOrigin) {
		if (workspace.projectMutationBusy) return;
		open = false;
		await workspace.openDirectory(origin);
	}
</script>

<div class="min-w-0 flex-1">
	{#if root}
		<Popover.Root bind:open>
			<Popover.Trigger>
				{#snippet child({ props })}
					<button {...props} type="button" aria-label={`Switch project: ${root.name}`} title={toURI(root)} disabled={workspace.projectMutationBusy} class="flex h-8 max-w-full items-center gap-1 rounded-md px-2 text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">
						<span class="truncate">{root.name}</span>
						<CaretUpDown class="size-3 shrink-0" />
					</button>
				{/snippet}
			</Popover.Trigger>
			<Popover.Content aria-label="Recent projects" align="start" class="w-80 max-w-[calc(100vw-1rem)] p-0">
				<Command.Root>
					<Command.Input aria-label="Search recent projects" placeholder="Search recent projects" />
					<Command.List class="max-h-64 p-1">
						<Command.Empty>No projects found.</Command.Empty>
						{#each workspace.recentFolders as folder (toURI(folder))}
							<Command.Item value={toURI(folder)} keywords={[folder.name, folder.path]} onSelect={() => select(folder)} disabled={workspace.projectMutationBusy} class="flex min-w-0 gap-2 text-xs">
								<div class="min-w-0 flex-1" title={toURI(folder)}>
									<div class="truncate">{folder.name}</div>
									<div class="truncate text-[10px] text-muted-foreground">{toURI(folder)}</div>
								</div>
								{#if toURI(folder) === workspace.projectUri}<span class="shrink-0 text-[10px]">Current</span>{/if}
							</Command.Item>
						{/each}
					</Command.List>
				</Command.Root>
				<div class="border-t p-1">
					<button type="button" onclick={() => select()} disabled={workspace.projectMutationBusy} class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"><FolderOpen class="size-4" />Open Folder</button>
				</div>
			</Popover.Content>
		</Popover.Root>
	{:else}
		<button type="button" onclick={() => select()} disabled={workspace.projectMutationBusy} class="flex h-8 items-center gap-2 rounded-md px-2 text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"><FolderOpen class="size-4" />Open Folder</button>
	{/if}
</div>
