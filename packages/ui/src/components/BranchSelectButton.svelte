<script lang="ts">
	import { useAppState } from '@np/core';
	import { onDestroy } from 'svelte';
	import { CheckIcon, GitBranchIcon } from "phosphor-svelte";
	import * as Command from './ui/command';
	import * as Popover from './ui/popover';
	import BranchSafetyModal from './BranchSafetyModal.svelte';
	import type { RepositorySafetyReport } from '@np/core';
	import { cn } from '@np/core';

	let { class: className = '', open = $bindable(false) }: { class?: string; open?: boolean } = $props();

	const appState = useAppState();
	const workspace = appState.workspace;
	let trigger = $state<HTMLButtonElement | null>(null);
	let restoreFocus = false;
	let pending = $state<{ branch: string; target: ReturnType<typeof workspace.captureProject>; report: RepositorySafetyReport | null; error: string | null } | null>(null);
	let checking = $state(false);
	let request = 0;
	let visiblePending = $derived(pending && workspace.isCurrentProject(pending.target) && !workspace.projectOpening ? pending : null);

	function cancel() {
		request++;
		pending = null;
		checking = false;
	}

	async function switchBranch(branch: string, target = workspace.captureProject()) {
		if (checking || workspace.projectMutationBusy || !workspace.isCurrentProject(target)) return;
		open = false;
		if (branch === workspace.currentBranch) return;
		const id = ++request;
		checking = true;
		try {
			const report = await workspace.getBranchSafetyReport(branch, target);
			if (id !== request || !workspace.isCurrentProject(target) || !report) return;
			if (!report.canSwitch) {
				pending = { branch, target, report, error: null };
				return;
			}
			const result = await workspace.switchBranch(branch, target);
			if (id !== request || !workspace.isCurrentProject(target)) return;
			if (result.status === 'blocked') {
				pending = { branch, target, report: { canSwitch: false, unsavedFiles: [], uncommittedFiles: result.files }, error: null };
			} else if (result.status === 'error') {
				pending = { branch, target, report: null, error: result.message };
			} else {
				pending = null;
			}
		} catch (error) {
			if (id === request && workspace.isCurrentProject(target)) {
				pending = { branch, target, report: null, error: error instanceof Error ? error.message : String(error) };
			}
		} finally {
			if (id === request) checking = false;
		}
	}

	onDestroy(cancel);

	function recheckSafety() {
		if (visiblePending) void switchBranch(visiblePending.branch, visiblePending.target);
	}

</script>

{#if appState.workspace.hasRootPermission && appState.workspace.currentBranch}
	<Popover.Root bind:open={open}>
		<Popover.Trigger bind:ref={trigger}>
			{#snippet child({ props })}
				<button
					{...props}
					type="button"
					disabled={checking || workspace.projectMutationBusy}
					aria-label={`Switch branch: ${workspace.currentBranch}`}
					aria-busy={checking || workspace.projectMutationBusy}
					title={workspace.currentBranch ?? undefined}
					class={cn("flex h-8 min-w-0 max-w-full items-center gap-1 rounded-md px-2 text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50", className)}
				>
					{#if checking || workspace.projectMutationBusy}
						<div class="size-3 shrink-0 animate-spin border-2 border-current border-t-transparent rounded-full"></div>
					{:else}
						<GitBranchIcon class="size-3 shrink-0" />
					{/if}
					<span class="truncate">{appState.workspace.currentBranch}</span>
				</button>
			{/snippet}
		</Popover.Trigger>
		<Popover.Content
			trapFocus={false}
			onOpenAutoFocus={() => restoreFocus = false}
			onEscapeKeydown={() => restoreFocus = true}
			onCloseAutoFocus={(event) => {
				event.preventDefault();
				if (restoreFocus) trigger?.focus();
			}}
			aria-label="Branches" class="max-w-[calc(100vw-1rem)] p-0 flex flex-col group/branch-pop" align="start">
			<Command.Root class="flex-1 p-0 group-data-[side=top]/branch-pop:flex-col-reverse">
				<Command.Input aria-label="Search branches" placeholder="Switch Branch" class="h-8" />
				<Command.List class="px-1 py-1">
					<Command.Empty class="py-2 text-[11px] text-center">No branches found.</Command.Empty>
					{#each appState.workspace.branches as branch (branch)}
						<Command.Item
							value={branch}
							aria-current={workspace.currentBranch === branch ? 'true' : undefined}
							title={branch}
							disabled={checking || workspace.projectMutationBusy}
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

{#if visiblePending}
	<BranchSafetyModal
		report={visiblePending.report ?? { canSwitch: false, unsavedFiles: [], uncommittedFiles: [] }}
		error={visiblePending.error}
		busy={checking || workspace.projectMutationBusy}
		targetBranch={visiblePending.branch}
		onConfirm={recheckSafety}
		onCancel={cancel}
	/>
{/if}

<style>
	:global(.group\/branch-pop[data-side='top'] [data-slot='command-input-wrapper']) {
		padding-top: 0;
		padding-bottom: 0.25rem;
	}
</style>