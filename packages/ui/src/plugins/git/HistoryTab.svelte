<script lang="ts">
	import type { GitHistoryCommit } from '@np/core';
	import { formatRelativeTime } from '@np/core/utils';
	import { GitCommitIcon, CopyIcon } from 'phosphor-svelte';
	import * as ContextMenu from '../../components/ui/context-menu';
	import { getContext } from 'svelte';
	import type { AppState, ClipboardService } from '@np/core/state.svelte';
	import {
		runHistoryAction,
		handleHistoryKeyDown,
		defaultClipboardService,
		type HistoryAction
	} from './history-actions';

	let {
		commits = [],
		isLoading = false,
		clipboardService
	}: {
		commits?: GitHistoryCommit[];
		isLoading?: boolean;
		clipboardService?: ClipboardService;
	} = $props();

	const appState = getContext<AppState | undefined>('appState');
	const clipboard = $derived(clipboardService ?? appState?.clipboardService ?? defaultClipboardService);

	let copiedSha = $state<string | null>(null);
	let copiedTimeout: ReturnType<typeof setTimeout> | null = null;

	function triggerVisualFeedback(sha: string) {
		copiedSha = sha;
		if (copiedTimeout) clearTimeout(copiedTimeout);
		copiedTimeout = setTimeout(() => {
			if (copiedSha === sha) copiedSha = null;
		}, 1500);
	}

	async function handleRowClick(commit: GitHistoryCommit) {
		const success = await runHistoryAction('copyShortSha', commit, clipboard);
		if (success) {
			triggerVisualFeedback(commit.sha);
		}
	}

	async function handleAction(action: HistoryAction, commit: GitHistoryCommit) {
		const success = await runHistoryAction(action, commit, clipboard);
		if (success) {
			triggerVisualFeedback(commit.sha);
		}
	}

	function handleKeyDown(event: KeyboardEvent) {
		handleHistoryKeyDown(event);
	}
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
			<ContextMenu.Root>
				<ContextMenu.Trigger>
					<div
						role="button"
						tabindex="0"
						class="group flex flex-col px-2 py-1.5 rounded hover:bg-muted/30 transition-colors cursor-pointer select-none text-left"
						data-sha={commit.sha}
						title={copiedSha === commit.sha ? 'Copied short SHA to clipboard' : 'Click to copy short SHA'}
						onclick={() => handleRowClick(commit)}
						ondblclick={(e) => { e.preventDefault(); }}
						onkeydown={handleKeyDown}
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
							<span
								class="font-mono text-[9px] shrink-0 opacity-80"
								title={copiedSha === commit.sha ? 'Copied short SHA' : 'Click to copy SHA'}
							>
								{copiedSha === commit.sha ? 'Copied!' : commit.shortSha}
							</span>
						</div>
					</div>
				</ContextMenu.Trigger>
				<ContextMenu.Content class="w-48 font-sans">
					<ContextMenu.Item onclick={() => handleAction('copySha', commit)}>
						<CopyIcon size={11} />
						Copy SHA
					</ContextMenu.Item>
					<ContextMenu.Item onclick={() => handleAction('copySubject', commit)}>
						<CopyIcon size={11} />
						Copy subject
					</ContextMenu.Item>
				</ContextMenu.Content>
			</ContextMenu.Root>
		{/each}
	</div>
{/if}
