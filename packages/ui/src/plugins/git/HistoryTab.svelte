<script lang="ts">
	import type { GitHistoryCommit } from '@np/core';
	import { formatRelativeTime, parseRefTags } from '@np/core/utils';
	import { GitCommitIcon, TagSimpleIcon, ArrowUpIcon, CopyIcon } from 'phosphor-svelte';
	import * as ContextMenu from '../../components/ui/context-menu';
	import { getContext } from 'svelte';
	import type { AppState, ClipboardService } from '@np/core/state.svelte';
	import {
		runHistoryAction,
		handleHistoryKeyDown,
		defaultClipboardService,
		type HistoryAction
	} from './history-actions';
	import VirtualList from './VirtualList.svelte';

	let {
		commits = [],
		aheadCount = 0,
		isLoading = false,
		clipboardService,
		scrollElement = $bindable(null)
	}: {
		commits?: GitHistoryCommit[];
		aheadCount?: number;
		isLoading?: boolean;
		clipboardService?: ClipboardService;
		scrollElement?: HTMLElement | null;
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

	const ROW_HEIGHT = 48;
</script>

{#if commits.length === 0}
	<div class="h-full flex flex-col items-center justify-center p-6 text-center text-muted-foreground select-none" data-slot="history-empty">
		<GitCommitIcon class="size-6 mb-2 opacity-40 text-muted-foreground" />
		<p class="text-xs font-medium">No Commits</p>
		<p class="text-[11px] opacity-75 mt-1 max-w-[200px]">There are no commits on this branch yet.</p>
	</div>
{:else}
	<VirtualList
		items={commits}
		rowHeight={ROW_HEIGHT}
		bind:containerEl={scrollElement}
		class="flex-1 overflow-y-auto p-1.5 select-none"
		data-slot="history-list"
		getKey={(commit) => commit.sha}
	>
		{#snippet children(commit, index)}
			{@const tags = parseRefTags(commit.refDecoration)}
			{@const isAhead = commit.isAhead ?? (aheadCount > 0 && index < aheadCount)}
			<ContextMenu.Root>
				<ContextMenu.Trigger>
					<div
						role="button"
						tabindex="0"
						class="group flex flex-col justify-center px-2 py-1.5 rounded hover:bg-muted/30 transition-colors cursor-pointer select-none text-left"
						style="height: {ROW_HEIGHT}px; box-sizing: border-box;"
						data-sha={commit.sha}
						title={copiedSha === commit.sha ? 'Copied short SHA to clipboard' : 'Click to copy short SHA'}
						onclick={() => handleRowClick(commit)}
						ondblclick={(e) => { e.preventDefault(); }}
						onkeydown={handleKeyDown}
					>
						<!-- Line 1: Subject (truncated) + tag chips + unpushed arrow icon -->
						<div class="flex items-center justify-between min-w-0 gap-1.5">
							<span class="truncate font-medium text-foreground text-xs min-w-0 flex-1" title={commit.subject || '(no commit message)'}>
								{commit.subject || '(no commit message)'}
							</span>

							<div class="flex items-center gap-1 shrink-0">
								{#if tags.length > 0}
									{#each tags.slice(0, 3) as tag (tag)}
										<span
											class="inline-flex items-center gap-1 px-1.5 py-0.25 text-[10px] leading-tight rounded bg-muted text-muted-foreground font-medium shrink-0 border border-border/40 max-w-[90px]"
											title={tag}
											data-slot="history-tag-chip"
										>
											<TagSimpleIcon size={10} class="opacity-60 shrink-0" />
											<span class="truncate">{tag}</span>
										</span>
									{/each}
									{#if tags.length > 3}
										<span
											class="inline-flex items-center px-1.5 py-0.25 text-[10px] leading-tight rounded bg-muted text-muted-foreground font-medium shrink-0 border border-border/40"
											title={tags.slice(3).join(', ')}
											data-slot="history-tag-overflow"
										>
											+{tags.length - 3}
										</span>
									{/if}
								{/if}

								{#if isAhead}
									<span
										class="inline-flex items-center justify-center text-primary shrink-0"
										title="Unpushed (ahead of upstream)"
										aria-label="Unpushed"
										data-slot="history-unpushed-indicator"
									>
										<ArrowUpIcon size={12} class="stroke-2" />
									</span>
								{/if}
							</div>
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
		{/snippet}
	</VirtualList>
{/if}
