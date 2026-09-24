<script lang="ts">
	import { useAppState, toURI, type FileOrigin } from '@np/core';
	import { FolderOpen } from 'phosphor-svelte';
	import * as Command from './ui/command';
	import * as Popover from './ui/popover';
	import * as Tooltip from './ui/tooltip';
	import Button, { type ButtonSize } from './ui/button/button.svelte';


	const appState = useAppState();
	const workspace = appState.workspace;
	let { open = $bindable(false), size = 'default' }: { open?: boolean; size?: ButtonSize } = $props();
	let root = $derived(workspace.rootOrigin);
	let trigger = $state<HTMLButtonElement | null>(null);
	let restoreFocus = false;

	async function select(origin?: FileOrigin) {
		if (workspace.projectMutationBusy) return;
		open = false;
		await workspace.openDirectory(origin);
	}

	function toDisplayPath(origin: FileOrigin): string {
		return origin.scheme === 'file' ? origin.path : toURI(origin);
	}
</script>

<div class="min-w-0 flex-1">
	{#if root}
		<Tooltip.Provider delayDuration={400}>
		<Popover.Root bind:open>
			<Tooltip.Root disabled={open}>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<span {...props} class="inline-flex min-w-0">
							<Popover.Trigger bind:ref={trigger}>
								{#snippet child({ props: popoverProps })}
									<Button {...popoverProps}
									  type="button"
										aria-label={`Switch project: ${root.name}`}
										disabled={workspace.projectMutationBusy}
										variant="ghost"
										size={size}
									>
										<span class="truncate">{root.name}</span>
									</Button>
								{/snippet}
							</Popover.Trigger>
						</span>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content side="bottom" align="start" class="text-[10px] px-2 py-1 max-w-xs break-all">
					{toDisplayPath(root)}
				</Tooltip.Content>
			</Tooltip.Root>
			<Popover.Content
				trapFocus={false}
				onOpenAutoFocus={() => restoreFocus = false}
				onEscapeKeydown={() => restoreFocus = true}
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					if (restoreFocus) trigger?.focus();
				}}
				aria-label="Recent projects" align="start" class="w-80 max-w-[calc(100vw-1rem)] p-0">
				<Command.Root>
					<Command.Input aria-label="Search recent projects" placeholder="Search recent projects" />
					<Command.List class="max-h-64 p-1">
						<Command.Empty>No projects found.</Command.Empty>
					{#each workspace.recentFolders as folder (toURI(folder))}
						<Tooltip.Root>
							<Tooltip.Trigger>
								{#snippet child({ props })}
									<Command.Item {...props} value={folder.path} keywords={[folder.name, folder.path]} onSelect={() => select(folder)} disabled={workspace.projectMutationBusy} class="flex min-w-0 gap-2 text-xs">
										<div class="min-w-0 flex-1">
											<div class="truncate">{folder.name}</div>
											<div class="truncate text-[10px] text-muted-foreground">{toDisplayPath(folder)}</div>
										</div>
										{#if toURI(folder) === workspace.projectUri}<span class="shrink-0 text-[10px]">Current</span>{/if}
									</Command.Item>
								{/snippet}
							</Tooltip.Trigger>
							<Tooltip.Content side="right" align="center" class="text-[10px] px-2 py-1 max-w-xs break-all">
								{toDisplayPath(folder)}
							</Tooltip.Content>
						</Tooltip.Root>
					{/each}
					</Command.List>
				</Command.Root>
				<div class="border-t p-1">
					<button type="button" onclick={() => select()} disabled={workspace.projectMutationBusy} class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"><FolderOpen class="size-4" />Open Folder</button>
				</div>
			</Popover.Content>
		</Popover.Root>
		</Tooltip.Provider>
	{:else}
		<Button
			type="button"
			onclick={() => select()}
			disabled={workspace.projectMutationBusy}
			aria-label="Open folder"
			variant="ghost"
			size={size}
		>
			<FolderOpen />Open Folder
		</Button>
	{/if}
</div>
