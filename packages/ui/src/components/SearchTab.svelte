<script lang="ts">
	import { useAppState } from '@np/core/state.svelte';
	import type { FileSearchResult, SearchMatch } from '@np/core';
	import MultiBuffer, { type MultibufferSection } from './MultiBuffer.svelte';
	import Icon from './Icon.svelte';
	import { CaretRightIcon, CaretDownIcon, MagnifyingGlassIcon } from 'phosphor-svelte';
	import { SvelteSet } from 'svelte/reactivity';

	interface Props {
		tabId?: string;
	}

	let { tabId }: Props = $props();

	const appState = useAppState();
	const activeId = $derived(tabId ?? appState.workspace.activeTabId);
	const session = $derived(appState.workspace.getSearchSession(activeId));

	let fileResults = $state<FileSearchResult[]>([]);
	let isSearching = $state(false);
	let isTruncated = $state(false);
	let truncationReason = $state<'files' | 'matches' | undefined>(undefined);
	let searchTimeout: any = null;
	let currentAbortController: AbortController | null = null;
	const collapsedPaths = new SvelteSet<string>();

	let totalMatches = $derived(fileResults.reduce((sum, r) => sum + r.matches.length, 0));

	let sections = $derived<MultibufferSection[]>(
		fileResults.map((r) => ({
			filepath: r.filepath,
			key: r.filepath
		}))
	);

	function toggleCollapse(filepath: string) {
		if (collapsedPaths.has(filepath)) {
			collapsedPaths.delete(filepath);
		} else {
			collapsedPaths.add(filepath);
		}
	}

	function handleInput() {
		if (searchTimeout) {
			clearTimeout(searchTimeout);
		}
		searchTimeout = setTimeout(() => {
			runSearch();
		}, 150);
	}

	function toggleCaseSensitive() {
		session.toggleCaseSensitive();
		runSearch();
	}

	function toggleWholeWord() {
		session.toggleWholeWord();
		runSearch();
	}

	function toggleRegex() {
		session.toggleRegex();
		runSearch();
	}

	async function runSearch() {
		if (currentAbortController) {
			currentAbortController.abort();
			currentAbortController = null;
		}

		if (session.regexError) {
			fileResults = [];
			isSearching = false;
			isTruncated = false;
			truncationReason = undefined;
			return;
		}

		const query = session.toQuery();
		if (!query.pattern) {
			fileResults = [];
			isSearching = false;
			isTruncated = false;
			truncationReason = undefined;
			return;
		}

		currentAbortController = new AbortController();
		const signal = currentAbortController.signal;

		fileResults = [];
		isSearching = true;
		isTruncated = false;
		truncationReason = undefined;

		try {
			const backend = appState.workspace.project.searchBackend;
			const stream = backend.search(query, { signal });

			for await (const result of stream) {
				if (signal.aborted) break;
				fileResults = [...fileResults, result];
			}

			if (!signal.aborted) {
				isTruncated = stream.progress.truncated;
				truncationReason = stream.progress.truncationReason;
			}
		} catch (e) {
			if (!signal.aborted) {
				console.error('[SearchTab] Search failed:', e);
			}
		} finally {
			if (currentAbortController?.signal === signal) {
				isSearching = false;
			}
		}
	}

	async function openFile(result?: FileSearchResult) {
		if (!result) return;
		await appState.workspace.openFile(result.origin);
	}

	async function jumpToMatch(result: FileSearchResult, match: SearchMatch) {
		const doc = await appState.workspace.openFile(result.origin);
		if (doc) {
			doc.pendingLineToScroll = match.line;
			doc.pendingColumn = match.column;
			doc.pendingMatchLength = match.matchLength;
		}
	}
</script>

<div class="flex flex-col h-full w-full bg-background text-foreground overflow-hidden">
	<!-- Query bar on top -->
	<div class="border-b border-border/40 p-3 bg-muted/20 flex flex-col gap-2 shrink-0">
		<div class="relative flex items-center">
			<MagnifyingGlassIcon class="absolute left-2.5 size-4 text-muted-foreground pointer-events-none" />
			<input
				type="text"
				bind:value={session.query}
				oninput={handleInput}
				placeholder="Search project..."
				class="w-full bg-background border border-input rounded-md pl-9 pr-24 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				aria-label="Search query"
			/>
			<div class="absolute right-1.5 flex items-center gap-0.5">
				<button
					type="button"
					class="px-1.5 py-0.5 text-xs font-mono rounded border transition-colors {session.caseSensitive ? 'bg-primary/20 text-primary border-primary/40 font-semibold' : 'text-muted-foreground border-transparent hover:bg-muted hover:text-foreground'}"
					aria-label="Match Case"
					aria-pressed={session.caseSensitive}
					title="Match Case"
					onclick={toggleCaseSensitive}
				>
					Aa
				</button>
				<button
					type="button"
					class="px-1.5 py-0.5 text-xs font-mono rounded border transition-colors {session.wholeWord ? 'bg-primary/20 text-primary border-primary/40 font-semibold' : 'text-muted-foreground border-transparent hover:bg-muted hover:text-foreground'}"
					aria-label="Match Whole Word"
					aria-pressed={session.wholeWord}
					title="Match Whole Word"
					onclick={toggleWholeWord}
				>
					\b
				</button>
				<button
					type="button"
					class="px-1.5 py-0.5 text-xs font-mono rounded border transition-colors {session.isRegex ? 'bg-primary/20 text-primary border-primary/40 font-semibold' : 'text-muted-foreground border-transparent hover:bg-muted hover:text-foreground'}"
					aria-label="Use Regular Expression"
					aria-pressed={session.isRegex}
					title="Use Regular Expression"
					onclick={toggleRegex}
				>
					.*
				</button>
			</div>
		</div>

		{#if session.regexError}
			<div class="text-xs text-destructive font-medium px-0.5 flex items-center gap-1" role="alert">
				<span>{session.regexError}</span>
			</div>
		{/if}

		<!-- File include and exclude globs -->
		<div class="grid grid-cols-2 gap-2">
			<input
				type="text"
				bind:value={session.includePattern}
				oninput={handleInput}
				placeholder="files to include (e.g. *.ts, src/**)"
				aria-label="Files to include"
				class="w-full bg-background border border-input rounded-md px-2.5 py-1 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
			/>
			<input
				type="text"
				bind:value={session.excludePattern}
				oninput={handleInput}
				placeholder="files to exclude (e.g. *.test.ts, build/**)"
				aria-label="Files to exclude"
				class="w-full bg-background border border-input rounded-md px-2.5 py-1 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
			/>
		</div>

		<!-- Status and truncation bar -->
		<div class="flex items-center justify-between text-xs px-0.5">
			<div class="flex items-center gap-2">
				{#if isSearching}
					<span class="text-muted-foreground animate-pulse">Searching...</span>
				{:else if !session.query}
					<span class="text-muted-foreground">Type a query to search</span>
				{:else if fileResults.length === 0}
					<span class="text-muted-foreground">No results found</span>
				{:else}
					<span class="text-muted-foreground">
						{totalMatches} {totalMatches === 1 ? 'match' : 'matches'} across {fileResults.length} {fileResults.length === 1 ? 'file' : 'files'}
					</span>
				{/if}
			</div>

			{#if isTruncated}
				<div class="text-amber-500 font-medium" role="status">
					Results truncated: capped at {truncationReason === 'files' ? '5,000 files' : '10,000 matches'}
				</div>
			{/if}
		</div>
	</div>

	<!-- Grouped results below using MultiBuffer -->
	<div class="flex-1 overflow-hidden flex flex-col">
		<MultiBuffer
			{sections}
			isCollapsed={(fp) => collapsedPaths.has(fp)}
			idPrefix="search-"
		>
			{#snippet header(filepath: string)}
				{@const fileResult = fileResults.find((r) => r.filepath === filepath)}
				<div
					class="flex items-center gap-2 py-1 px-2 hover:bg-muted/30 rounded cursor-pointer select-none"
					onclick={() => toggleCollapse(filepath)}
					role="button"
					tabindex="0"
					onkeydown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							toggleCollapse(filepath);
						}
					}}
				>
					<button
						type="button"
						aria-label={collapsedPaths.has(filepath) ? `Expand ${filepath}` : `Collapse ${filepath}`}
						class="p-0.5 hover:bg-muted rounded text-muted-foreground"
						onclick={(e) => {
							e.stopPropagation();
							toggleCollapse(filepath);
						}}
					>
						{#if collapsedPaths.has(filepath)}
							<CaretRightIcon size={14} />
						{:else}
							<CaretDownIcon size={14} />
						{/if}
					</button>

					<Icon resource={filepath} type="file" class="size-4 opacity-90" />

					<button
						type="button"
						class="font-medium text-xs text-foreground hover:underline truncate text-left"
						onclick={(e) => {
							e.stopPropagation();
							openFile(fileResult);
						}}
					>
						{filepath}
					</button>

					<span class="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full font-mono">
						{fileResult?.matches.length ?? 0}
					</span>
				</div>
			{/snippet}

			{#snippet content(filepath: string)}
				{@const fileResult = fileResults.find((r) => r.filepath === filepath)}
				{#if fileResult}
					<div class="flex flex-col py-1">
						{#each fileResult.matches as match (match.offset)}
							<div
								role="button"
								tabindex="0"
								class="group hover:bg-accent/40 px-3 py-1 cursor-pointer transition-colors border-l-2 border-transparent hover:border-primary font-mono text-xs"
								onclick={() => jumpToMatch(fileResult, match)}
								onkeydown={(e) => {
									if (e.key === 'Enter' || e.key === ' ') {
										e.preventDefault();
										jumpToMatch(fileResult, match);
									}
								}}
							>
								<!-- Context lines before -->
								{#each match.contextBefore as ctx (ctx.line)}
									<div class="text-muted-foreground/50 flex gap-2">
										<span class="w-10 text-right select-none opacity-60 shrink-0">{ctx.line}</span>
										<span class="whitespace-pre overflow-x-hidden text-ellipsis">{ctx.text}</span>
									</div>
								{/each}

								<!-- Match line -->
								<div class="flex gap-2 font-medium text-foreground">
									<span class="w-10 text-right select-none text-primary/80 font-bold shrink-0">{match.line}</span>
									<span class="whitespace-pre overflow-x-hidden text-ellipsis">
										{match.lineText.slice(0, match.column - 1)}<mark class="bg-primary/30 text-primary font-bold rounded-xs px-0.5">{match.lineText.slice(match.column - 1, match.column - 1 + match.matchLength)}</mark>{match.lineText.slice(match.column - 1 + match.matchLength)}
									</span>
								</div>

								<!-- Context lines after -->
								{#each match.contextAfter as ctx (ctx.line)}
									<div class="text-muted-foreground/50 flex gap-2">
										<span class="w-10 text-right select-none opacity-60 shrink-0">{ctx.line}</span>
										<span class="whitespace-pre overflow-x-hidden text-ellipsis">{ctx.text}</span>
									</div>
								{/each}
							</div>
						{/each}
					</div>
				{/if}
			{/snippet}

			{#snippet emptyState()}
				<div class="flex-1 flex flex-col items-center justify-center p-8 text-muted-foreground text-sm">
					{#if session.query.trim()}
						<p>No results found for &ldquo;{session.query}&rdquo;</p>
					{:else}
						<p>Type a query above to search the project.</p>
					{/if}
				</div>
			{/snippet}
		</MultiBuffer>
	</div>
</div>
