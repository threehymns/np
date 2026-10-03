<script lang="ts">
	import {
		lspManifest,
		type LspLogKind,
		type LspLogLevel,
		type LspLogStore
	} from '@np/core';
	import { useAppState } from '@np/core/state.svelte';
	import { BroomIcon, CaretDownIcon } from 'phosphor-svelte';
	import { onMount } from 'svelte';
	import * as DropdownMenu from '../../components/ui/dropdown-menu';

	/**
	 * The Logs tab: the buffers the plugin already keeps (ADR 0019), filtered
	 * rather than scrolled. Reading the store through its service key keeps the
	 * tab from importing plugin state, and every line shown here came out of a
	 * real pipe.
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

	// Empty string means "no filter", which is what the store's own optional
	// fields mean; translating here keeps undefined out of the component.
	let serverFilter = $state('');
	let kindFilter = $state('');
	let levelFilter = $state('');

	const KINDS: readonly LspLogKind[] = ['server', 'protocol'];
	const LEVELS: readonly LspLogLevel[] = ['error', 'warn', 'info', 'trace'];

	const entries = $derived.by(() => {
		revision;
		return logs?.read(currentFilter()) ?? [];
	});

	const servers = $derived.by(() => {
		revision;
		return logs?.servers() ?? [];
	});

	// Follows the same counter as the list: a truncated buffer that never mentioned
	// its own drops would read as complete.
	const dropped = $derived.by(() => {
		revision;
		return logs?.droppedCount ?? 0;
	});

	function currentFilter(): { server?: string; kind?: LspLogKind; level?: LspLogLevel } {
		return {
			...(serverFilter ? { server: serverFilter } : {}),
			...(kindFilter ? { kind: kindFilter as LspLogKind } : {}),
			...(levelFilter ? { level: levelFilter as LspLogLevel } : {})
		};
	}

	function clear(): void {
		// Clearing the selected server when one is picked, everything otherwise:
		// the buffer that is on screen is the one worth emptying.
		logs?.clear(serverFilter || undefined);
	}

	function shortServer(server: string): string {
		const at = server.lastIndexOf('@');
		return at === -1 ? server : server.slice(at + 1);
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
					{#each servers as server (server)}
						<DropdownMenu.RadioItem value={server}>{shortServer(server)}</DropdownMenu.RadioItem>
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

		<span class="text-[10px] text-muted-foreground">
			{entries.length} {entries.length === 1 ? 'line' : 'lines'}{#if dropped > 0}&nbsp;· {dropped} dropped{/if}
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
		{#if entries.length === 0}
			<p class="text-xs text-muted-foreground">
				No lines match. A server writes here as it starts, syncs a document, and fails.
			</p>
		{:else}
			<ul class="flex flex-col gap-px">
				{#each entries as entry (entry.sequence)}
					<li class="flex gap-2 font-mono text-[11px] leading-relaxed">
						<span class="w-8 shrink-0 {LEVEL_STYLES[entry.level]}">{entry.level}</span>
						<span class="w-32 shrink-0 truncate text-muted-foreground/80" title={entry.server}>
							{shortServer(entry.server)}
						</span>
						<span class="shrink-0 text-muted-foreground/60">{entry.kind}</span>
						<span class="min-w-0 break-all whitespace-pre-wrap text-foreground/90">{entry.message}</span>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>