<script lang="ts">
	import { useAppState } from '@np/core/state.svelte';
	import { GitBranchIcon } from 'phosphor-svelte';
	import * as Tooltip from '../../components/ui/tooltip/index';

	const appState = useAppState();

	let repo = $derived(appState.workspace.repository);
	let branch = $derived(appState.workspace.currentBranch);
	let dirtyCount = $derived(repo?.changes?.length ?? 0);
	let visible = $derived(!!repo && !!branch);
</script>

{#if visible}
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<button
					{...props}
					type="button"
					class="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors tabular-nums"
					aria-label={dirtyCount > 0 ? `Branch ${branch}, ${dirtyCount} uncommitted changes` : `Branch ${branch}, clean`}
					onclick={() => {
						appState.activeSidebarTab = 'git';
						appState.prefs.sidebarVisible = true;
					}}
				>
					<GitBranchIcon class="size-3.5 shrink-0" />
					<span class="text-[11px] font-medium max-w-[120px] truncate">{branch}</span>
					{#if dirtyCount > 0}
						<span
							class="min-w-3 h-3 px-0.5 rounded-full bg-primary/15 text-primary text-[9px] font-bold flex items-center justify-center font-mono"
							aria-hidden="true"
						>
							{dirtyCount}
						</span>
					{/if}
				</button>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content side="top" align="start" class="text-[10px] px-2 py-1">
			{branch}{#if dirtyCount > 0} — {dirtyCount} uncommitted change{dirtyCount === 1 ? '' : 's'}{:else} — clean{/if}
		</Tooltip.Content>
	</Tooltip.Root>
{/if}
