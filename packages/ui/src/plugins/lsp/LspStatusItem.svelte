<script lang="ts">
	import { lspManifest, type LspServerStatusApi } from '@np/core';
	import { useAppState } from '@np/core/state.svelte';
import { ArrowClockwiseIcon, LightningIcon, ScrollIcon, StopIcon } from 'phosphor-svelte';
	import { onMount } from 'svelte';
	import { buttonVariants } from '../../components/ui/button';
	import * as DropdownMenu from '../../components/ui/dropdown-menu';
	import * as Tooltip from '../../components/ui/tooltip/index';
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

<Tooltip.Provider>
	<DropdownMenu.Root>
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<!-- An icon with a dot on it, the way every other status bar button
					     is: the trigger is `size-5` because the bar's other buttons are,
					     and `relative` because the dot hangs off its corner. The bar's own
					     background is the dot's border, so the dot sits on the bar rather
					     than inside the button. The button names itself with the summary,
					     which is where the numbers now live. -->
					<DropdownMenu.Trigger
						{...props}
						class={buttonVariants({
							variant: 'ghost',
							size: 'icon-xs',
							class: 'relative text-foreground/80 hover:bg-accent/50 hover:text-foreground'
						})}
						aria-label={view.title}
					>
						<LightningIcon weight="duotone" />
						<span
							aria-hidden="true"
							class="absolute right-0.5 bottom-0.5 size-1.5 rounded-full border border-background {view.indicator}"
						></span>
					</DropdownMenu.Trigger>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content>{view.title}</Tooltip.Content>
		</Tooltip.Root>
		<DropdownMenu.Content align="start" class="w-56 font-sans">
			{#if view.empty}
				<DropdownMenu.Item disabled>No language servers yet</DropdownMenu.Item>
			{:else}
				{#each view.rows as row (row.server)}
					<DropdownMenu.Sub>
						<Tooltip.Root>
							<Tooltip.Trigger>
								{#snippet child({ props })}
									<!-- The dot carries the state; the label rides along for assistive
									     tech, which cannot read a colour. -->
									<DropdownMenu.SubTrigger {...props} aria-label={`${row.descriptorId} (${row.label})`}>
										<span class="size-1.5 shrink-0 rounded-full {row.dot}"></span>
										<span class="truncate">{row.descriptorId}</span>
										<!-- Only for a server that is not running: a word beside every
						     running server would make the ones that need saying harder
						     to see. -->
										{#if row.stateNote}
											<span class="ml-2 text-muted-foreground">{row.stateNote}</span>
										{/if}
										<!-- The details slot: empty until the version and memory
						     follow-ups land, and already in the row when they do. -->
										{#each row.details as detail (detail.label)}
											<span class="ml-2 text-muted-foreground">{detail.label} {detail.value}</span>
										{/each}
									</DropdownMenu.SubTrigger>
								{/snippet}
							</Tooltip.Trigger>
							<Tooltip.Content>{row.title}</Tooltip.Content>
						</Tooltip.Root>
						<DropdownMenu.SubContent>
							<DropdownMenu.Item onclick={() => run(row.actions.restart)}>
								<ArrowClockwiseIcon />
								{row.actions.restart.label}
							</DropdownMenu.Item>
							<DropdownMenu.Item onclick={() => run(row.actions.viewLogs)}>
								<ScrollIcon />
								{row.actions.viewLogs.label}
							</DropdownMenu.Item>
							<!-- Absent, not disabled, once the server has no process left. -->
							{#if row.actions.stop.visible}
								<DropdownMenu.Item onclick={() => run(row.actions.stop)} variant="destructive">
									<StopIcon />
									{row.actions.stop.label}
								</DropdownMenu.Item>
							{/if}
						</DropdownMenu.SubContent>
					</DropdownMenu.Sub>
				{/each}
			{/if}
			<!-- The separator belongs to the whole-item group: alone at the bottom of an
			     empty menu it separates nothing. Which of the two entries appear is
			     `status-view`'s decision, so the markup only asks. -->
			{#if view.bulkVisible}
				<DropdownMenu.Separator />
				{#if view.actions.restartAll.visible}
					<DropdownMenu.Item onclick={() => run(view.actions.restartAll)}>
						<ArrowClockwiseIcon />
						{view.actions.restartAll.label}
					</DropdownMenu.Item>
				{/if}
				{#if view.actions.stopAll.visible}
					<DropdownMenu.Item onclick={() => run(view.actions.stopAll)} variant="destructive">
						<StopIcon />
						{view.actions.stopAll.label}
					</DropdownMenu.Item>
				{/if}
			{/if}
		</DropdownMenu.Content>
	</DropdownMenu.Root>
</Tooltip.Provider>
