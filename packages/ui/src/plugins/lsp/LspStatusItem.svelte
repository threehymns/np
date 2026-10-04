<script lang="ts">
	import { lspManifest, type LspServerStatusApi } from '@np/core';
	import { useAppState } from '@np/core/state.svelte';
	import { ArrowClockwiseIcon, StopIcon } from 'phosphor-svelte';
	import { onMount } from 'svelte';
	import * as DropdownMenu from '../../components/ui/dropdown-menu';
	import { lspStatusItemView, type LspStatusAction } from './status-view';

	/**
	 * The status item's menu lives here, not in the contribution: a status bar
	 * item is rendered as a bare component with its props, so there is nowhere
	 * else for a menu to go (ADR 0015).
	 *
	 * Every action below is a registered command, so the same entry also appears
	 * in the command palette and the two can never disagree about what stopping a
	 * server does. Which ids those are, what each entry says and when it is
	 * offered is `status-view`'s decision, kept out of here so it can be asserted
	 * against the registry rather than against rendered text.
	 */
	const appState = useAppState();
	// The plugin's own status API, keyed from the manifest id the same way the
	// plugin publishes it: the host keeps a service opaque (ADR 0008), and a
	// plugin that is not active publishes nothing, so the item shows no servers
	// rather than failing inside the status bar. Typed as the status contract
	// rather than the runtime, because starting and stopping a server is reached
	// through registered commands and this component needs to read nothing else.
	const runtime = appState.plugins.getService<LspServerStatusApi>(`${lspManifest.id}:runtime`);

	// Server state changes come from a process, not from the UI, so there is no
	// reactive source to follow. The subscription is turned into one: bumping the
	// counter is what makes the rows re-read.
	let revision = $state(0);
	onMount(() => runtime?.subscribe(() => {
		revision++;
	}));

	const view = $derived.by(() => {
		revision;
		return lspStatusItemView(runtime?.getStatusRows() ?? []);
	});

	function run(action: LspStatusAction): void {
		void appState.commands.execute(action.id, ...(action.server ? [action.server] : []));
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				type="button"
				class="flex items-center gap-1.5 rounded px-1.5 py-0.5 font-medium text-foreground/80 transition-colors hover:bg-accent/50 hover:text-foreground"
				title={view.title}
				aria-label="Language servers"
			>
				<span class="size-1.5 rounded-full {view.indicator}"></span>
				<span class="text-xs">LSP</span>
				{#if view.count}
					<span class="text-[10px] text-muted-foreground">{view.count}</span>
				{/if}
			</button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="start" class="w-72 font-sans">
		{#if view.empty}
			<DropdownMenu.Item disabled>No language servers yet</DropdownMenu.Item>
		{:else}
			{#each view.rows as row (row.server)}
				<DropdownMenu.Sub>
					<DropdownMenu.SubTrigger title={row.title}>
						<span class="size-1.5 shrink-0 rounded-full {row.dot}"></span>
						<span class="truncate">{row.descriptorId}</span>
						<span class="ml-auto text-muted-foreground">{row.label}</span>
						<!-- The details slot: empty until the version and memory
						     follow-ups land, and already in the row when they do. -->
						{#each row.details as detail (detail.label)}
							<span class="ml-2 text-muted-foreground">{detail.label} {detail.value}</span>
						{/each}
					</DropdownMenu.SubTrigger>
					<DropdownMenu.SubContent>
						<DropdownMenu.Item onclick={() => run(row.actions.restart)}>
							<ArrowClockwiseIcon />
							{row.actions.restart.label}
						</DropdownMenu.Item>
						<DropdownMenu.Item
							onclick={() => run(row.actions.stop)}
							variant="destructive"
							disabled={row.actions.stop.disabled}
						>
							<StopIcon />
							{row.actions.stop.label}
						</DropdownMenu.Item>
					</DropdownMenu.SubContent>
				</DropdownMenu.Sub>
			{/each}
		{/if}
		<DropdownMenu.Separator />
		<DropdownMenu.Item
			onclick={() => run(view.actions.restartAll)}
			disabled={view.actions.restartAll.disabled}
		>
			<ArrowClockwiseIcon />
			{view.actions.restartAll.label}
		</DropdownMenu.Item>
		<DropdownMenu.Item
			onclick={() => run(view.actions.stopAll)}
			variant="destructive"
			disabled={view.actions.stopAll.disabled}
		>
			<StopIcon />
			{view.actions.stopAll.label}
		</DropdownMenu.Item>
		<DropdownMenu.Separator />
		<DropdownMenu.Item onclick={() => run(view.actions.viewLogs)}>
			{view.actions.viewLogs.label}
		</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>
