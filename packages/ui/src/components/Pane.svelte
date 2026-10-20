<script lang="ts">
	import type { Pane as PaneType } from '@np/core';
	import { useAppState, cn, type UIContributionIcon } from '@np/core';
	import * as Tabs from './ui/tabs/index';
	import * as Tooltip from './ui/tooltip';
	import Icon from './Icon.svelte';
	import { Empty } from './ui/empty';
	import { XIcon } from 'phosphor-svelte';
	import { flip } from 'svelte/animate';
	import type { EditorView } from '@codemirror/view';
	import type EditorComponent from './Editor.svelte';

	let {
		pane,
		Editor = null,
		editorViews = $bindable({}),
	}: {
		pane: PaneType;
		Editor?: typeof EditorComponent | null;
		editorViews?: Record<string, EditorView | undefined>;
	} = $props();

	const appState = useAppState();

	let isActive = $derived(appState.workspace.activePaneId === pane.id);
	let allPanes = $derived(appState.workspace.getAllPanes());
	let isSplit = $derived(allPanes.length > 1);
	let showTabBar = $derived(isSplit || pane.tabs.length > 1 || pane.tabs.some(t => t.pluginId));

	function toPhosphorIcon(icon: UIContributionIcon | undefined): typeof XIcon {
		return (icon ?? XIcon) as unknown as typeof XIcon;
	}

	let draggedId = $state<string | null>(null);
	let initialTabIds: string[] | null = null;
	let didDrop = false;

	function handleDragStart(e: DragEvent, id: string) {
		draggedId = id;
		didDrop = false;
		initialTabIds = pane.tabs.map(t => t.id);
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.dropEffect = 'move';
		}
	}

	function handleDragEnter(targetId: string) {
		if (!draggedId || draggedId === targetId) return;

		const tabs = pane.tabs;
		const fromIdx = tabs.findIndex(t => t.id === draggedId);
		const toIdx = tabs.findIndex(t => t.id === targetId);

		if (fromIdx !== -1 && toIdx !== -1) {
			const [moved] = pane.tabs.splice(fromIdx, 1);
			pane.tabs.splice(toIdx, 0, moved);
		}
	}

	function handleDrop() {
		didDrop = true;
		initialTabIds = null;
	}

	function handleDragEnd() {
		if (!didDrop && initialTabIds) {
			const tabMap = new Map(pane.tabs.map(t => [t.id, t]));
			const restored = initialTabIds.map(id => tabMap.get(id)).filter(Boolean) as typeof pane.tabs;
			if (restored.length === pane.tabs.length) {
				pane.tabs = restored;
			}
		}
		draggedId = null;
		initialTabIds = null;
		didDrop = false;
	}

	function handleActivate() {
		if (appState.workspace.activePaneId !== pane.id) {
			appState.workspace.activePaneId = pane.id;
		}
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
	data-pane-id={pane.id}
	tabindex="-1"
	onfocusin={handleActivate}
	onclick={handleActivate}
	role="region"
	aria-label="Editor pane"
	class="flex flex-1 flex-col min-w-0 min-h-0 h-full w-full overflow-hidden relative select-auto outline-none"
>
	<Tabs.Root bind:value={pane.activeTabId} class="flex flex-1 flex-col min-w-0 min-h-0 h-full">
		{#if showTabBar}
			<Tabs.List
				class={cn(
					"bg-accent/50 justify-start rounded-none items-end gap-0 pb-0 w-full overflow-x-auto overflow-y-hidden no-scrollbar transition-opacity duration-150",
					isActive ? "opacity-100" : "opacity-60 hover:opacity-80"
				)}
			>
				<Tooltip.Provider delayDuration={400}>
					{#each pane.tabs as tab (tab.id)}
						{@const tabDocument = appState.documents.find(d => d.id === (tab.docId ?? tab.id))}
						{@const tabContent = tab.pluginId ? appState.plugins.getTabContent(tab.pluginId) : undefined}
						{@const title = tabContent?.title ?? tabDocument?.fileName ?? 'Untitled'}
						{@const isModified = tabDocument?.isModified}
						{@const deletedOnDisk = tabDocument?.deletedOnDisk}
						<div
							animate:flip={{ duration: 150 }}
							class="group relative flex h-full -bottom-[1px] shrink-0 {draggedId === tab.id ? 'opacity-20' : ''}"
							draggable="true"
							role="presentation"
							ondragstart={(e) => handleDragStart(e, tab.id)}
							ondragover={(e) => e.preventDefault()}
							ondragenter={() => handleDragEnter(tab.id)}
							ondrop={handleDrop}
							ondragend={handleDragEnd}
						>
							<Tooltip.Root>
								<Tooltip.Trigger>
									<Tabs.Trigger
										value={tab.id}
										onclick={handleActivate}
										class="data-[state=active]:bg-background! data-[state=active]:border-border! px-1 py-0 text-xs font-medium pr-6 border-b-0! rounded-none border-transparent! hover:bg-accent flex items-center gap-1.5 {deletedOnDisk ? 'line-through opacity-60 text-muted-foreground' : ''}"
									>
										{#if tabContent?.icon}
											{@const TabIcon = toPhosphorIcon(tabContent.icon)}
											<TabIcon class="size-3.5 opacity-90 text-primary shrink-0" />
										{:else}
											<Icon
												resource={title}
												type="file"
												class="size-3.5 opacity-90"
											/>
										{/if}
										{title}
									</Tabs.Trigger>
								</Tooltip.Trigger>
								<Tooltip.Content side="bottom">
									{deletedOnDisk ? `${title} (deleted on disk)` : tabDocument?.origin?.path}
								</Tooltip.Content>
							</Tooltip.Root>

							<Tooltip.Provider delayDuration={400}>
								<Tooltip.Root>
									<Tooltip.Trigger>
										<button
											onclick={(e) => {
												e.stopPropagation();
												appState.closeTab(tab.id, pane.id);
											}}
											class="group/close absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded-sm hover:bg-muted transition-opacity focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-primary focus-visible:outline-none {isModified ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}"
										>
											{#if isModified}
												<div class="w-1.5 h-1.5 rounded-full bg-foreground/40 group-hover:hidden group-focus-visible/close:hidden m-0.5"></div>
												<XIcon size={10} class="hidden group-hover:block group-focus-visible/close:block" />
											{:else}
												<XIcon size={10} />
											{/if}
										</button>
									</Tooltip.Trigger>
									<Tooltip.Content side="bottom" align="start" arrowPadding={7} class="-translate-x-3">Close tab</Tooltip.Content>
								</Tooltip.Root>
							</Tooltip.Provider>
							<span class={cn("absolute group-hover:hidden bg-border h-2/3 w-[1px] top-1/2 -translate-y-1/2 -translate-x-[1px]", pane.activeTabId === tab.id && "hidden")}></span>
						</div>
					{/each}
				</Tooltip.Provider>
				<div class="flex-1 h-full min-w-4"></div>
			</Tabs.List>
		{/if}

		{#if pane.tabs.length === 0}
			<Empty />
		{:else}
			{#each pane.tabs as tab (tab.id)}
				{@const tabDocument = appState.documents.find(d => d.id === (tab.docId ?? tab.id))}
				{@const tabContent = tab.pluginId ? appState.plugins.getTabContent(tab.pluginId) : undefined}
				<Tabs.Content value={tab.id} class="flex-1 overflow-hidden focus-visible:outline-none m-0 p-0 h-full min-h-0">
					{#if pane.activeTabId === tab.id}
						{#if tab.pluginId && tabContent}
							{@const TabComponent = tabContent.component}
							<TabComponent {...(tabContent.props ?? {})} />
						{:else if Editor}
							{#if tabDocument}
								<!--
									Every rendered editor is live, so a cloned view in another
									pane shows the edits made in the pane that has focus.
									The focus-sensitive state (word wrap, vim mode, the
									global keymap contexts) belongs to the focused
									editor alone.
								-->
								<Editor
									doc={tabDocument}
									active={true}
									focused={isActive}
									bind:view={editorViews[`${pane.id}:${tab.id}`]}
									paneId={pane.id}
									style="font-size: {appState.prefs.zoom}%;"
									wrap={appState.prefs.wordWrap}
								/>
							{/if}
						{:else}
							<div class="flex-1 bg-background animate-pulse"></div>
						{/if}
					{/if}
				</Tabs.Content>
			{/each}
		{/if}
	</Tabs.Root>
</div>
