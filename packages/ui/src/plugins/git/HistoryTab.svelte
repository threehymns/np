<script lang="ts">
	import type { GitHistoryCommit } from '@np/core';
	import { formatRelativeTime, parseRefTags } from '@np/core/utils';
	import { GitCommitIcon, TagSimpleIcon, ArrowUpIcon, CopyIcon } from 'phosphor-svelte';
	import * as ContextMenu from '../../components/ui/context-menu';
	import { getContext } from 'svelte';
	import type { Snippet } from 'svelte';
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
	let copiedAction = $state<HistoryAction>('copyShortSha');
	let copiedTimeout: ReturnType<typeof setTimeout> | null = null;

	const copiedLabel: Record<HistoryAction, string> = {
		copyShortSha: 'Copied short SHA to clipboard',
		copySha: 'Copied full SHA to clipboard',
		copySubject: 'Copied subject to clipboard'
	};

	function triggerVisualFeedback(sha: string, action: HistoryAction) {
		copiedSha = sha;
		copiedAction = action;
		if (copiedTimeout) clearTimeout(copiedTimeout);
		copiedTimeout = setTimeout(() => {
			if (copiedSha === sha) copiedSha = null;
		}, 1500);
	}

	async function handleRowClick(commit: GitHistoryCommit) {
		const success = await runHistoryAction('copyShortSha', commit, clipboard);
		if (success) {
			triggerVisualFeedback(commit.sha, 'copyShortSha');
		}
	}

	async function handleAction(action: HistoryAction, commit: GitHistoryCommit) {
		const success = await runHistoryAction(action, commit, clipboard);
		if (success) {
			triggerVisualFeedback(commit.sha, action);
		}
	}

	function handleKeyDown(event: KeyboardEvent, commit: GitHistoryCommit) {
		if (handleHistoryKeyDown(event)) return;
		// Rows carry role="button", so they must be keyboard-activatable:
		// Space copies the short SHA like a click does. Enter stays a
		// reserved no-op for the v2 commit detail page.
		if (event.key === ' ') {
			event.preventDefault();
			handleRowClick(commit);
		}
	}

	const ROW_HEIGHT = 48;

	/**
	 * How many rows beyond the viewport the list renders.
	 *
	 * The compositor moves the pixels before the main thread updates the DOM,
	 * so the rendered window is always one frame behind the scroll position.
	 * The overscan is the only buffer covering that gap, and it has to be at
	 * least the distance a fast scroll covers in a single frame: 30 rows is
	 * 1 440 px, which covers a 1 000 px/frame flick. With fewer rows the list
	 * lands on rows that were never rendered and shows blank space.
	 */
	const OVERSCAN = 30;

	/**
	 * The commit the shared context menu is acting on.
	 *
	 * There is one menu for the whole list, so its items cannot close over a
	 * row's commit the way a per-row menu could — they act on this instead.
	 */
	let activeCommit = $state<GitHistoryCommit | null>(null);

	const commitsBySha = $derived(new Map(commits.map((commit) => [commit.sha, commit])));

	/**
	 * Resolve the row a right-click landed on.
	 *
	 * The shared menu's trigger wraps the rows, so this runs for every
	 * right-click inside it. A right-click that misses every row leaves the
	 * menu with no target and its items disabled.
	 */
	function resolveContextTarget(event: MouseEvent) {
		const sha = (event.target as HTMLElement | null)
			?.closest('[data-sha]')
			?.getAttribute('data-sha');
		activeCommit = sha ? (commitsBySha.get(sha) ?? null) : null;
	}
</script>

{#snippet historyRow(commit: GitHistoryCommit, index: number)}
	{@const tags = parseRefTags(commit.refDecoration)}
	{@const isAhead = commit.isAhead ?? (aheadCount > 0 && index < aheadCount)}
	<div
		role="button"
		tabindex="0"
		class="group flex flex-col justify-center px-2 py-1.5 rounded hover:bg-muted/30 transition-colors cursor-pointer select-none text-left"
		style="height: {ROW_HEIGHT}px; box-sizing: border-box;"
		data-sha={commit.sha}
		title={copiedSha === commit.sha ? copiedLabel[copiedAction] : 'Click to copy short SHA'}
		onclick={() => handleRowClick(commit)}
		ondblclick={(e) => { e.preventDefault(); }}
		onkeydown={(e) => handleKeyDown(e, commit)}
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
							class="inline-flex items-center gap-1 px-1.5 py-0.25 text-[10px] leading-tight rounded bg-muted text-muted-foreground font-medium shrink-0 border border-border/40"
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
				title={copiedSha === commit.sha ? copiedLabel[copiedAction] : 'Click to copy SHA'}
			>
				{copiedSha === commit.sha ? 'Copied!' : commit.shortSha}
			</span>
		</div>
	</div>
{/snippet}

<!--
	One context menu for the whole list, wrapping the rows.

	The trigger has to be a single element: bits-ui keeps one anchor per menu,
	so a trigger per row would leave the menu positioned at the last row
	instead of the one that was clicked.
-->
{#snippet menuGroup(renderRows: Snippet)}
	<ContextMenu.Root>
		<ContextMenu.Trigger>
			{#snippet child({ props }: { props: Record<string, any> })}
				{@const merged = {
					...props,
					// `type` only means something on a <button>; bits-ui adds it
					// for its own default trigger, not for a custom child.
					type: undefined,
					// bits-ui composes same-named handlers into a single
					// function, so the target can be resolved next to the
					// handler that opens the menu.
					oncontextmenu: (event: MouseEvent) => {
						resolveContextTarget(event);
						const handler = props.oncontextmenu;
						if (typeof handler === 'function') handler(event);
					}
				}}
				<div {...merged}>
					{@render renderRows()}
				</div>
			{/snippet}
		</ContextMenu.Trigger>
		<ContextMenu.Content class="w-48 font-sans">
			<ContextMenu.Item
				disabled={!activeCommit}
				onclick={() => activeCommit && handleAction('copySha', activeCommit)}
			>
				<CopyIcon size={11} />
				Copy SHA
			</ContextMenu.Item>
			<ContextMenu.Item
				disabled={!activeCommit}
				onclick={() => activeCommit && handleAction('copySubject', activeCommit)}
			>
				<CopyIcon size={11} />
				Copy subject
			</ContextMenu.Item>
		</ContextMenu.Content>
	</ContextMenu.Root>
{/snippet}

{#if commits.length === 0 && isLoading}
	<div class="h-full flex items-center justify-center p-6 text-xs text-muted-foreground select-none" data-slot="history-loading">
		Loading history…
	</div>
{:else if commits.length === 0}
	<div class="h-full flex flex-col items-center justify-center p-6 text-center text-muted-foreground select-none" data-slot="history-empty">
		<GitCommitIcon class="size-6 mb-2 opacity-40 text-muted-foreground" />
		<p class="text-xs font-medium">No Commits</p>
		<p class="text-[11px] opacity-75 mt-1 max-w-[200px]">There are no commits on this branch yet.</p>
	</div>
{:else}
	<VirtualList
		items={commits}
		rowHeight={ROW_HEIGHT}
		overscan={OVERSCAN}
		bind:containerEl={scrollElement}
		class="flex-1 overflow-y-auto p-1.5 select-none"
		data-slot="history-list"
		getKey={(commit) => commit.sha}
		row={historyRow}
		rowGroup={menuGroup}
	/>
{/if}
