<script lang="ts">
	import { lspManifest, type LspLogKind, type LspLogLevel, type LspLogStore } from '@np/core';
	import { useAppState } from '@np/core/state.svelte';
	import { BroomIcon, CaretDownIcon } from 'phosphor-svelte';
	import { onMount } from 'svelte';
	import * as DropdownMenu from '../../components/ui/dropdown-menu';
	import * as Tooltip from '../../components/ui/tooltip/index';
	import { applyLogsFocus, lspLogFilter, lspLogsView, shortServer } from './logs-view';

	/**
	 * The Logs tab: the buffers the plugin already keeps (ADR 0020), filtered
	 * rather than scrolled. Reading the store through its service key keeps the
	 * tab from importing plugin state, and every line shown here came out of a
	 * real pipe. What the three selections select is `logs-view`'s decision.
	 */
	const appState = useAppState();
	const logs = appState.plugins.getService<LspLogStore>(`${lspManifest.id}:log-store`);

	// A protocol trace grows by a line per keystroke and a server writes to
	// stderr whenever it is confused, so the list follows the store rather than
	// polling. The subscription is turned into reactive state because nothing
	// about a pipe write is reactive.
	let revision = $state(0);
	onMount(() => logs?.subscribe(() => {
		revision++;
	}));

	let serverFilter = $state('');
	let kindFilter = $state('');
	let levelFilter = $state('');
	// The RPC-trace toggle (ticket #282): a checkbox on the existing kind
	// filter, nothing more. Checked is the tab as it reads today; unchecked
	// drops the protocol feed, which grows by a line per keystroke.
	let showTrace = $state(true);

	// Which server the View Logs command last asked for, read through the same
	// revision as the entries: a request arrives from a command rather than from a
	// pipe, and the store notifies about it exactly as it notifies about a write.
	const focus = $derived.by(() => {
		revision;
		return logs?.focused;
	});

	// A request narrows the tab even when it is already open, which is the ordinary
	// case — the command comes from the status menu beside it. The picker cannot be
	// derived: the reader writes it too, and a derived cannot remember which
	// request it has already answered, so the one thing that has to cross is the
	// request number. That is what `applyLogsFocus` keys on, which is why this
	// effect fires on every line of protocol trace and changes nothing.
	let adoptedFocus = -1;
	$effect(() => {
		const decision = applyLogsFocus(serverFilter, focus, adoptedFocus);
		if (decision.adopted === adoptedFocus && decision.filter === serverFilter) return;
		adoptedFocus = decision.adopted;
		serverFilter = decision.filter;
	});

	const KINDS: readonly LspLogKind[] = ['server', 'protocol'];
	const LEVELS: readonly LspLogLevel[] = ['error', 'warn', 'info', 'trace'];

	// One read of the store per change, whatever changed: the filter and the
	// counter come off the same revision so a truncated buffer cannot report a
	// line count the drop count does not explain.
	const view = $derived.by(() => {
		revision;
		return lspLogsView(logs, lspLogFilter(serverFilter, kindFilter, levelFilter), showTrace);
	});

	function clear(): void {
		// Clearing the selected server when one is picked, everything otherwise:
		// the buffer that is on screen is the one worth emptying.
		logs?.clear(serverFilter || undefined);
	}

	const LEVEL_STYLES: Record<LspLogLevel, string> = {
		error: 'text-destructive',
		warn: 'text-amber-600 dark:text-amber-400',
		info: 'text-muted-foreground',
		trace: 'text-muted-foreground/70'
	};
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
						aria-label="Filter by server"
					>
						<span class="truncate">{serverFilter || 'All servers'}</span>
						<CaretDownIcon class="size-3 opacity-70" />
					</button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="start">
				<DropdownMenu.RadioGroup bind:value={serverFilter}>
					<DropdownMenu.RadioItem value="">All servers</DropdownMenu.RadioItem>
					{#each view.serverOptions as option (option.value)}
						<DropdownMenu.RadioItem value={option.value}>{option.label}</DropdownMenu.RadioItem>
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
						class="flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-foreground/80 hover:bg-accent/50"
						aria-label="Filter by kind"
					>
						<span>{kindFilter || 'All kinds'}</span>
						<CaretDownIcon class="size-3 opacity-70" />
					</button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="start">
				<DropdownMenu.RadioGroup bind:value={kindFilter}>
					<DropdownMenu.RadioItem value="">All kinds</DropdownMenu.RadioItem>
					{#each KINDS as kind (kind)}
						<DropdownMenu.RadioItem value={kind}>{kind}</DropdownMenu.RadioItem>
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
						class="flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-foreground/80 hover:bg-accent/50"
						aria-label="Filter by level"
					>
						<span>{levelFilter || 'All levels'}</span>
						<CaretDownIcon class="size-3 opacity-70" />
					</button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="start">
				<DropdownMenu.RadioGroup bind:value={levelFilter}>
					<DropdownMenu.RadioItem value="">All levels</DropdownMenu.RadioItem>
					{#each LEVELS as level (level)}
						<DropdownMenu.RadioItem value={level}>{level}</DropdownMenu.RadioItem>
					{/each}
				</DropdownMenu.RadioGroup>
			</DropdownMenu.Content>
		</DropdownMenu.Root>

		<div class="flex-1"></div>

		<label
			class="flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-0.5 font-medium text-foreground/80 hover:bg-accent/50"
		>
			<input type="checkbox" bind:checked={showTrace} aria-label="Show RPC trace" class="size-3" />
			RPC trace
		</label>

		<span class="text-[10px] text-muted-foreground">
			{view.lineCount}{#if view.droppedNote}&nbsp;· {view.droppedNote}{/if}
		</span>
		<button
			type="button"
			class="flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-foreground/80 hover:bg-accent/50"
			onclick={clear}
		>
			<BroomIcon class="size-3" />
			Clear
		</button>
	</div>

	<div class="flex-1 overflow-y-auto px-3 py-2">
		{#if view.empty}
			<p class="text-xs text-muted-foreground">
				No lines match. A server writes here as it starts, syncs a document, and fails.
			</p>
		{:else}
			<Tooltip.Provider>
				<ul class="flex flex-col gap-px">
					{#each view.entries as entry (entry.sequence)}
						<li class="flex gap-2 font-mono text-[11px] leading-relaxed">
							<span class="w-8 shrink-0 {LEVEL_STYLES[entry.level]}">{entry.level}</span>
							<!-- The column is truncated, so the full server key is the tooltip. -->
							<Tooltip.Root>
								<Tooltip.Trigger>
									{#snippet child({ props })}
										<span {...props} class="w-32 shrink-0 truncate text-muted-foreground/80">
											{shortServer(entry.server)}
										</span>
									{/snippet}
								</Tooltip.Trigger>
								<Tooltip.Content>{entry.server}</Tooltip.Content>
							</Tooltip.Root>
							<span class="shrink-0 text-muted-foreground/60">{entry.kind}</span>
							<span class="min-w-0 break-all whitespace-pre-wrap text-foreground/90">{entry.message}</span>
						</li>
					{/each}
				</ul>
			</Tooltip.Provider>
		{/if}
	</div>
</div>
