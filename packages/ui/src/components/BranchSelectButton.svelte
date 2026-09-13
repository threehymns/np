<script lang="ts">
	import { useAppState } from '@np/core';
	import { CheckIcon, GitBranchIcon } from "phosphor-svelte";
	import * as Command from './ui/command';
	import * as Popover from './ui/popover';
	import BranchSafetyModal from './BranchSafetyModal.svelte';
	import type { RepositorySafetyReport } from '@np/core';
	import { cn } from '@np/core';

	let { class: className = '' }: { class?: string } = $props();

	const appState = useAppState();
	let branchComboOpen = $state(false);
	let safetyReport = $state<RepositorySafetyReport | null>(null);
	let pendingBranch = $state<string | null>(null);

	async function switchBranch(branch: string) {
		const report = await appState.workspace.getBranchSafetyReport(branch);
		if (report && !report.canSwitch) {
			safetyReport = report;
			pendingBranch = branch;
			branchComboOpen = false;
			return;
		}
		await appState.workspace.switchBranch(branch);
		branchComboOpen = false;
	}

	async function recheckSafety() {
		if (!pendingBranch) return;
		const report = await appState.workspace.getBranchSafetyReport(pendingBranch);
		if (report && report.canSwitch) {
			const branch = pendingBranch;
			safetyReport = null;
			pendingBranch = null;
			await appState.workspace.switchBranch(branch);
		} else {
			safetyReport = report;
		}
	}

</script>

{#if appState.workspace.hasRootPermission && appState.workspace.currentBranch}
	<Popover.Root bind:open={branchComboOpen}>
		<Popover.Trigger>
			{#snippet child({ props })}
				<button
					{...props}
					class={cn("flex items-center gap-1 opacity-50 hover:opacity-100 hover:bg-sidebar-accent transition-all px-1 rounded-sm py-0.5 -ml-0.5 truncate", className)}
				>
					{#if appState.workspace.repository?.isBusy}
						<div class="size-3 animate-spin border-2 border-sidebar-foreground/50 border-t-sidebar-foreground rounded-full"></div>
					{:else}
						<GitBranchIcon class="size-3 shrink-0" />
					{/if}
					<span class="text-[10px] truncate max-w-[80px]">{appState.workspace.currentBranch}</span>
				</button>
			{/snippet}
		</Popover.Trigger>
		<Popover.Content class="p-0 flex flex-col group/branch-pop" align="start">
			<Command.Root class="flex-1 p-0 group-data-[side=top]/branch-pop:flex-col-reverse">
				<Command.Input placeholder="Switch Branch" class="h-8" />
				<Command.List class="px-1 py-1">
					<Command.Empty class="py-2 text-[11px] text-center">No branches found.</Command.Empty>
					{#each appState.workspace.branches as branch (branch)}
						<Command.Item
							value={branch}
							onSelect={() => switchBranch(branch)}
							class="text-[11px] flex items-center justify-between gap-2 px-2 py-1.5"
						>
							<div class="flex items-center gap-2 truncate">
								<GitBranchIcon class="size-3 opacity-50" />
								<span class="truncate">{branch}</span>
							</div>
							{#if appState.workspace.currentBranch === branch}
								<CheckIcon class="size-3 opacity-50" />
							{/if}
						</Command.Item>
					{/each}
				</Command.List>
			</Command.Root>
		</Popover.Content>
	</Popover.Root>
{/if}

{#if safetyReport && pendingBranch}
	<BranchSafetyModal 
		report={safetyReport} 
		targetBranch={pendingBranch} 
		onConfirm={recheckSafety}
		onCancel={() => { safetyReport = null; pendingBranch = null; }}
	/>
{/if}

<style>
	/* When bits-ui flips the popover above the trigger (data-side="top"),
	   flex-col-reverse puts the filter input at the bottom, closest to the
	   trigger. Flip its asymmetric padding so spacing stays identical. */
	:global(.group\/branch-pop[data-side='top'] [data-slot='command-input-wrapper']) {
		padding-top: 0;
		padding-bottom: 0.25rem;
	}
</style>