<script lang="ts">
	import { appState } from "$lib/state.svelte.js";
	import { Folder, FileText, CaretRight, CaretDown } from "phosphor-svelte";

	let { rootHandle } = $props<{ rootHandle: FileSystemDirectoryHandle }>();
	let entries = $state<FileSystemHandle[]>([]);
	let expanded = $state(true);

	$effect(() => {
		appState.storage.readDirectory(rootHandle).then(e => {
			entries = e.sort((a, b) => {
				if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
				return a.name.localeCompare(b.name);
			});
		});
	});

	async function handleClick(entry: FileSystemHandle) {
		if (entry.kind === 'file') {
			if (await appState.storage.verifyPermission(entry)) {
				await appState.workspace.openFile(entry as FileSystemFileHandle);
			}
		}
	}
</script>

<div class="flex flex-col text-xs">
	<button 
		class="flex items-center gap-1 px-2 py-1 hover:bg-muted/50 font-semibold uppercase tracking-wider text-muted-foreground"
		onclick={() => expanded = !expanded}
	>
		{#if expanded}<CaretDown size={12} />{:else}<CaretRight size={12} />{/if}
		{rootHandle.name}
	</button>
	
	{#if expanded}
		<div class="flex flex-col ml-2">
			{#each entries as entry}
				{#if entry.kind === 'file'}
					<button 
						class="flex items-center gap-2 px-2 py-1 hover:bg-muted transition-colors text-left"
						onclick={() => handleClick(entry)}
					>
						<FileText size={14} class="text-muted-foreground" />
						<span class="truncate">{entry.name}</span>
					</button>
				{:else}
					<div class="flex items-center gap-2 px-2 py-1 text-muted-foreground/50 italic">
						<Folder size={14} />
						<span class="truncate">{entry.name}</span>
					</div>
				{/if}
			{/each}
		</div>
	{/if}
</div>
