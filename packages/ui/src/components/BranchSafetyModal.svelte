<script lang="ts">
	import * as AlertDialog from './ui/alert-dialog';
	import { Button } from './ui/button';
	import type { RepositorySafetyReport } from '@np/core';

	let {
		report,
		targetBranch,
		onConfirm,
		onCancel
	}: {
		report: RepositorySafetyReport,
		targetBranch: string,
		onConfirm: () => void,
		onCancel: () => void
	} = $props();
</script>

<AlertDialog.Root open={true} onOpenChange={(open) => !open && onCancel()}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Cannot Switch Branch</AlertDialog.Title>
			<AlertDialog.Description>
				You have unsaved or uncommitted changes that would be overwritten by switching to <strong>{targetBranch}</strong>.
			</AlertDialog.Description>
		</AlertDialog.Header>

		<div class="space-y-4 my-4">
			{#if report.unsavedFiles.length > 0}
				<div class="space-y-1.5">
					<h4 class="text-sm font-semibold text-destructive">Unsaved Changes (Editor)</h4>
					<ul class="text-xs space-y-1 opacity-70 list-disc pl-4">
						{#each report.unsavedFiles as file}
							<li>{file}</li>
						{/each}
					</ul>
					<p class="text-[11px] opacity-50 italic">Please save or discard these changes in the editor first.</p>
				</div>
			{/if}

			{#if report.uncommittedFiles.length > 0}
				<div class="space-y-1.5">
					<h4 class="text-sm font-semibold text-destructive">Uncommitted Changes (Disk)</h4>
					<ul class="text-xs space-y-1 opacity-70 list-disc pl-4">
						{#each report.uncommittedFiles as file}
							<li>{file}</li>
						{/each}
					</ul>
					<p class="text-[11px] opacity-50 italic">Please commit or stash these changes using a Git client.</p>
				</div>
			{/if}
		</div>

		<AlertDialog.Footer>
			<AlertDialog.Cancel onclick={onCancel}>Cancel</AlertDialog.Cancel>
			<Button variant="outline" onclick={onConfirm}>Re-check</Button>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
