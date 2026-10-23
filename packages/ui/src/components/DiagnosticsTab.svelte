<script lang="ts">
	import {
		LSP_DIAGNOSTICS_STORE_SERVICE_KEY,
		fromFileUri,
		toURI,
		type DiagnosticSeverity,
		type DiagnosticsSeverityFilter,
		type DiagnosticsSort,
		type LspDiagnosticsStore
	} from '@np/core';
	import { useAppState } from '@np/core/state.svelte';
	import { CaretDownIcon, WarningCircleIcon } from 'phosphor-svelte';
	import MultiBuffer from './MultiBuffer.svelte';
	import * as DropdownMenu from './ui/dropdown-menu';
	import { diagnosticsView } from './diagnostics-tab';

	/**
	 * The project-wide diagnostics tab (spec #309, issue #309).
	 *
	 * A view over the merged diagnostics store the LSP plugin publishes
	 * (ADR 0008, ADR 0022, ADR 0029): the tab reads the diagnostics the store
	 * holds, never the protocol that filled them, and shows them on the
	 * reusable multibuffer — one section per file, each diagnostic with the lines
	 * around it.
	 *
	 * What the tab shows is `diagnostics-tab`'s decision; this is the markup
	 * over it, plus the subscription that turns a store change into reactive
	 * state and the controls that write the reader's choices into the
	 * workspace's session for this tab.
	 */

	let { tabId }: { tabId: string } = $props();

	const appState = useAppState();
	const store = $derived(appState.plugins.getService<LspDiagnosticsStore>(LSP_DIAGNOSTICS_STORE_SERVICE_KEY));
	// The session belongs to the tab, not to this view: switching away and back
	// has to find the filter the reader chose.
	const session = $derived(appState.workspace.getDiagnosticsSession(tabId));

	// The store is not reactive, and neither is a server's report arriving: the
	// revision counter is what turns the store's notification into state the
	// list below can be derived from.
	let revision = $state(0);
	$effect(() => {
		const currentStore = store;
		if (currentStore) {
			const unsubscribe = currentStore.subscribe(() => {
				revision++;
			});
			return () => unsubscribe();
		}
	});

	// The text of the files the workspace has open. The tab shows the text the
	// editor has — the unsaved edits in it — and a file the workspace has no
	// document for has no text here at all.
	const openTexts = $derived.by(() => {
		revision;
		const texts = new Map<string, string>();
		for (const doc of appState.workspace.documents) {
			// Key by the same path form the view looks up with: the URI
			// round-trip through the file-URI conversion, so a Windows origin
			// path like `C:/x` (whose URI is `file:///C:/x`) matches the
			// `fromFileUri` lookup in diagnosticsView and keeps its excerpts.
			if (doc.origin) texts.set(fromFileUri(toURI(doc.origin)) ?? doc.origin.path, doc.content);
		}
		return texts;
	});

	const view = $derived.by(() => {
		revision;
		return diagnosticsView(store, {
			filter: session.filter,
			sort: session.sort,
			readText: (path) => openTexts.get(path),
			rootPath: appState.workspace.project.rootOrigin?.path ?? null
		});
	});

	const sectionsByPath = $derived(new Map(view.sections.map((section) => [section.filepath, section])));

	const FILTERS: readonly DiagnosticsSeverityFilter[] = ['all', 'error', 'warning', 'info', 'hint'];
	const SORTS: readonly DiagnosticsSort[] = ['severity', 'path'];

	const FILTER_LABELS: Record<DiagnosticsSeverityFilter, string> = {
		all: 'All severities',
		error: 'Errors',
		warning: 'Warnings',
		info: 'Info',
		hint: 'Hints'
	};

	const SORT_LABELS: Record<DiagnosticsSort, string> = {
		severity: 'By severity',
		path: 'By file'
	};

	const SEVERITY_STYLES: Record<DiagnosticSeverity, string> = {
		error: 'text-destructive',
		warning: 'text-amber-600 dark:text-amber-400',
		info: 'text-sky-600 dark:text-sky-400',
		hint: 'text-muted-foreground'
	};

	const SEVERITY_BORDERS: Record<DiagnosticSeverity, string> = {
		error: 'border-l-destructive',
		warning: 'border-l-amber-500',
		info: 'border-l-sky-500',
		hint: 'border-l-muted-foreground/50'
	};

	/**
	 * The picker hands back the string it was given; the session wants the
	 * filter it names. A value the tab does not offer is ignored, so a stray
	 * selection cannot put the list in a state no control shows.
	 */
	function selectFilter(value: string): void {
		const filter = FILTERS.find((offered) => offered === value);
		if (filter) session.filter = filter;
	}

	function selectSort(value: string): void {
		const sort = SORTS.find((offered) => offered === value);
		if (sort) session.sort = sort;
	}
</script>

<div class="flex h-full flex-col overflow-hidden bg-background font-sans">
	<div class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<button
						{...props}
						type="button"
						class="flex max-w-56 items-center gap-1 rounded px-1.5 py-0.5 font-medium text-foreground/80 hover:bg-accent/50"
						aria-label="Filter by severity"
					>
						<span class="truncate">{FILTER_LABELS[session.filter]}</span>
						<CaretDownIcon class="size-3 opacity-70" />
					</button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="start">
				<DropdownMenu.RadioGroup value={session.filter} onValueChange={selectFilter}>
					{#each FILTERS as filter (filter)}
						<DropdownMenu.RadioItem value={filter}>{FILTER_LABELS[filter]}</DropdownMenu.RadioItem>
					{/each}
				</DropdownMenu.RadioGroup>
			</DropdownMenu.Content>
		</DropdownMenu.Root>

		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<button
						{...props}
						type="button"
						class="flex max-w-56 items-center gap-1 rounded px-1.5 py-0.5 font-medium text-foreground/80 hover:bg-accent/50"
						aria-label="Sort diagnostics"
					>
						<span class="truncate">{SORT_LABELS[session.sort]}</span>
						<CaretDownIcon class="size-3 opacity-70" />
					</button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="start">
				<DropdownMenu.RadioGroup value={session.sort} onValueChange={selectSort}>
					{#each SORTS as sort (sort)}
						<DropdownMenu.RadioItem value={sort}>{SORT_LABELS[sort]}</DropdownMenu.RadioItem>
					{/each}
				</DropdownMenu.RadioGroup>
			</DropdownMenu.Content>
		</DropdownMenu.Root>

		<div class="flex-1"></div>

		<span class="text-[10px] text-muted-foreground">{view.count}</span>
	</div>

	<MultiBuffer
		sections={view.sections}
		isCollapsed={() => false}
		idPrefix="diagnostics-"
		emptyState={emptyState}
		header={sectionHeader}
		content={sectionContent}
	/>
</div>

{#snippet emptyState()}
	<div class="flex h-full flex-col items-center justify-center p-12 text-center text-muted-foreground">
		<WarningCircleIcon class="mb-2 size-6 text-primary opacity-80" />
		<p class="text-xs font-bold">No diagnostics</p>
		<p class="mt-0.5 text-[9px] opacity-75">
			{#if store}
				{#if store.uris().length > 0}
					No diagnostics match this filter.
				{:else}
					No language server has reported anything.
				{/if}
			{:else}
				No language server is running.
			{/if}
		</p>
	</div>
{/snippet}

{#snippet sectionHeader(filepath: string)}
	{@const section = sectionsByPath.get(filepath)}
	{#if section}
		<div class="flex items-center justify-between gap-2 font-mono text-[10.5px]">
			<span class="truncate font-bold text-foreground">{section.filepath}</span>
			<span class="shrink-0 text-[9px] text-muted-foreground">
				{section.entries.length}
				{section.entries.length === 1 ? 'diagnostic' : 'diagnostics'}
			</span>
		</div>
	{/if}
{/snippet}

{#snippet sectionContent(filepath: string)}
	{@const section = sectionsByPath.get(filepath)}
	{#if section}
		<div class="flex flex-col gap-3 px-2 py-2">
			{#each section.entries as entry, index (entry.uri + ':' + entry.line + ':' + entry.character + ':' + index + ':' + entry.message + ':' + (entry.source ?? '') + ':' + (entry.code ?? ''))}
				<div class="flex flex-col gap-1 border-l-2 pl-2 {SEVERITY_BORDERS[entry.severity]}">
					<div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
						<span class="font-mono text-[10px] font-bold uppercase {SEVERITY_STYLES[entry.severity]}">
							{entry.severity}
						</span>
						<span class="font-mono text-[10px] text-muted-foreground">line {entry.line + 1}</span>
						<span class="text-xs text-foreground/90">{entry.message}</span>
						{#if entry.source || entry.code}
							<span class="font-mono text-[9px] text-muted-foreground/80">
								{entry.source ?? ''}{entry.source && entry.code ? ' ' : ''}{entry.code ? `(${entry.code})` : ''}
							</span>
						{/if}
					</div>
					{#if entry.excerpt}
						<div class="overflow-x-auto rounded border border-border/60 bg-muted/20 font-mono text-[11px] leading-relaxed">
							{#each entry.excerpt as line (line.number)}
								<div class="flex gap-2 px-2 {line.flagged ? 'bg-destructive/10' : ''}">
									<span class="w-8 shrink-0 select-none text-right text-muted-foreground/60">{line.number}</span>
									<span class="whitespace-pre text-foreground/85 {line.flagged ? 'font-medium' : ''}">{line.text}</span>
								</div>
							{/each}
						</div>
					{:else}
						<p class="text-[10px] text-muted-foreground/70">
							No source to show: the workspace has no text for this file.
						</p>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
{/snippet}
