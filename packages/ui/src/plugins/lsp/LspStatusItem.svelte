<script lang="ts">
	import {
		lspManifest,
		type LspServerState,
		type LspServerStatus,
		type LspServerStatusApi
	} from '@np/core';
	import { useAppState } from '@np/core/state.svelte';
	import { ArrowClockwiseIcon, StopIcon } from 'phosphor-svelte';
	import { onMount } from 'svelte';
	import * as DropdownMenu from '../../components/ui/dropdown-menu';

	/**
	 * The status item's menu lives here, not in the contribution: a status bar
	 * item is rendered as a bare component with its props, so there is nowhere
	 * else for a menu to go (ADR 0015).
	 *
	 * Every action below is a registered command, so the same entry also appears
	 * in the command palette and the two can never disagree about what stopping a
	 * server does.
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

	const rows = $derived.by((): LspServerStatus[] => {
		revision;
		return runtime?.getStatusRows() ?? [];
	});

	const running = $derived(rows.filter((row) => row.state === 'running').length);

	// One dot for the whole item, honest about what it summarises: grey while no
	// server has started, amber while none of them is running, green otherwise.
	const indicator = $derived(
		running > 0
			? 'bg-emerald-500'
			: rows.length > 0
				? 'bg-amber-500'
				: 'bg-muted-foreground/40'
	);

	const STATE_LABELS: Record<LspServerState, string> = {
		running: 'running',
		starting: 'starting',
		stopped: 'stopped',
		failed: 'failed'
	};

	const STATE_DOTS: Record<LspServerState, string> = {
		running: 'bg-emerald-500',
		starting: 'bg-amber-500 animate-pulse',
		stopped: 'bg-muted-foreground/50',
		failed: 'bg-destructive'
	};

	function restart(server: string): void {
		void appState.commands.execute('lsp.restartServer', server);
	}

	function stop(server: string): void {
		void appState.commands.execute('lsp.stopServer', server);
	}

	function restartAll(): void {
		void appState.commands.execute('lsp.restartAllServers');
	}

	function stopAll(): void {
		void appState.commands.execute('lsp.stopAllServers');
	}

	function viewLogs(): void {
		void appState.commands.execute('lsp.viewLogs');
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				type="button"
				class="flex items-center gap-1.5 rounded px-1.5 py-0.5 font-medium text-foreground/80 transition-colors hover:bg-accent/50 hover:text-foreground"
				title={rows.length === 0
					? 'Language servers: none running'
					: `Language servers: ${running} of ${rows.length} running`}
				aria-label="Language servers"
			>
				<span class="size-1.5 rounded-full {indicator}"></span>
				<span class="text-xs">LSP</span>
				{#if rows.length > 0}
					<span class="text-[10px] text-muted-foreground">{running}/{rows.length}</span>
				{/if}
			</button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="start" class="w-72 font-sans">
		{#if rows.length === 0}
			<DropdownMenu.Item disabled>No language servers yet</DropdownMenu.Item>
		{:else}
			{#each rows as row (row.server)}
				<DropdownMenu.Sub>
					<DropdownMenu.SubTrigger title={`${row.server}${row.marker ? ` (via ${row.marker})` : ''}`}>
						<span class="size-1.5 shrink-0 rounded-full {STATE_DOTS[row.state]}"></span>
						<span class="truncate">{row.descriptorId}</span>
						<span class="ml-auto text-muted-foreground">{STATE_LABELS[row.state]}</span>
						<!-- The details slot: empty until the version and memory
						     follow-ups land, and already in the row when they do. -->
						{#each row.details as detail (detail.label)}
							<span class="ml-2 text-muted-foreground">{detail.label} {detail.value}</span>
						{/each}
					</DropdownMenu.SubTrigger>
					<DropdownMenu.SubContent>
						<DropdownMenu.Item onclick={() => restart(row.server)}>
							<ArrowClockwiseIcon />
							Restart this server
						</DropdownMenu.Item>
						<DropdownMenu.Item
							onclick={() => stop(row.server)}
							variant="destructive"
							disabled={row.state === 'stopped'}
						>
							<StopIcon />
							Stop this server
						</DropdownMenu.Item>
					</DropdownMenu.SubContent>
				</DropdownMenu.Sub>
			{/each}
		{/if}
		<DropdownMenu.Separator />
		<DropdownMenu.Item onclick={restartAll} disabled={rows.length === 0}>
			<ArrowClockwiseIcon />
			Restart All Servers
		</DropdownMenu.Item>
		<DropdownMenu.Item onclick={stopAll} variant="destructive" disabled={rows.length === 0}>
			<StopIcon />
			Stop All Servers
		</DropdownMenu.Item>
		<DropdownMenu.Separator />
		<DropdownMenu.Item onclick={viewLogs}>View Logs</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>
