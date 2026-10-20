<script lang="ts">
	import { useAppState } from '@np/core';
	import { onDestroy } from 'svelte';
	import { CheckIcon, GitBranchIcon } from "phosphor-svelte";
	import BranchSafetyModal from './BranchSafetyModal.svelte';
	import type { RepositorySafetyReport } from '@np/core';
	import PickerPopover from './PickerPopover.svelte';
	import type { PickerRow } from './picker-row';
	import type { ButtonSize } from './ui/button/button.svelte';

	let { class: className = '', open = $bindable(false), size = 'default' }: { class?: string; open?: boolean; size?: ButtonSize } = $props();

	const appState = useAppState();
	const workspace = appState.workspace;
	let pending = $state<{ branch: string; target: ReturnType<typeof workspace.captureProject>; report: RepositorySafetyReport | null; error: string | null } | null>(null);
	let checking = $state(false);
	let request = 0;
	let visiblePending = $derived(pending && workspace.isCurrentProject(pending.target) && !workspace.projectOpening ? pending : null);
	let busy = $derived(checking || workspace.projectMutationBusy);

	let rows = $derived(
		workspace.branches.map(
			(branch): PickerRow => ({
				value: branch,
				label: branch,
				tooltip: branch,
				current: branch === workspace.currentBranch
			})
		)
	);

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

{#if workspace.project.hasRootPermission && workspace.currentBranch}
	<PickerPopover
		bind:open
		{size}
		label={workspace.currentBranch}
		ariaLabel={`Switch branch: ${workspace.currentBranch}`}
		popupLabel="Branches"
		inputLabel="Search branches"
		inputPlaceholder="Switch Branch"
		emptyText="No branches found."
		{rows}
		onSelect={(item) => switchBranch(item.value)}
		disabled={busy}
		{busy}
		flipInputOnTop
		class={className}
		maxWidth="max-w-[50%]"
	>
		{#snippet icon()}
			{#if busy}
				<svg class="animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
					<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-dasharray="42 57" />
				</svg>
			{:else}
				<GitBranchIcon />
			{/if}
		{/snippet}
		{#snippet row(item: PickerRow)}
			<div class="flex min-w-0 items-center gap-2 truncate">
				<GitBranchIcon class="size-3 shrink-0 opacity-50" />
				<span class="truncate">{item.label}</span>
			</div>
			{#if item.current}
				<CheckIcon class="size-3 shrink-0 opacity-50" />
			{/if}
		{/snippet}
	</PickerPopover>
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
