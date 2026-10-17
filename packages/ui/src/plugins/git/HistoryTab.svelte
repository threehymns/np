<script lang="ts">
	import type { GitHistoryCommit } from '@np/core';
	import { formatRelativeTime } from '@np/core/utils';
	import { GitCommitIcon } from 'phosphor-svelte';

	let {
		commits = [],
		isLoading = false
	}: {
		commits?: GitHistoryCommit[];
		isLoading?: boolean;
	} = $props();
</script>

{#if commits.length === 0}
	<div class="h-full flex flex-col items-center justify-center p-6 text-center text-muted-foreground select-none" data-slot="history-empty">
		<GitCommitIcon class="size-6 mb-2 opacity-40 text-muted-foreground" />
		<p class="text-xs font-medium">No Commits</p>
		<p class="text-[11px] opacity-75 mt-1 max-w-[200px]">There are no commits on this branch yet.</p>
	</div>
{:else}
	<div class="flex-1 overflow-y-auto p-1.5 space-y-0.5 select-none" data-slot="history-list">
		{#each commits as commit (commit.sha)}
			<div
				role="listitem"
				class="group flex flex-col px-2 py-1.5 rounded hover:bg-muted/30 transition-colors cursor-pointer"
				data-sha={commit.sha}
			>
				<!-- Line 1: Subject (truncated) -->
				<div class="flex items-center justify-between min-w-0">
					<span class="truncate font-medium text-foreground text-xs" title={commit.subject || '(no commit message)'}>
						{commit.subject || '(no commit message)'}
					</span>
				</div>

				<!-- Line 2: Author, relative timestamp, short SHA (muted) -->
				<div class="flex items-center gap-1.5 text-[10px] text-muted-foreground mt-0.5 min-w-0">
					<span class="truncate max-w-[120px]" title={commit.author}>
						{commit.author}
					</span>
					<span class="opacity-40">·</span>
					<span class="shrink-0 whitespace-nowrap">
						{formatRelativeTime(commit.timestamp)}
					</span>
					<span class="opacity-40">·</span>
					<span class="font-mono text-[9px] shrink-0 opacity-80">
						{commit.shortSha}
					</span>
				</div>
			</div>
		{/each}
	</div>
{/if}
