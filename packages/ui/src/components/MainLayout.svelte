<script lang="ts">
  import { onMount } from 'svelte';
  import { useAppState } from '@np/core/state.svelte';
  
  import * as Tabs from "../components/ui/tabs/index";
  import Icon from "./Icon.svelte";
  
  import { XIcon, GitDiffIcon } from 'phosphor-svelte';
  import { flip } from 'svelte/animate';
  import type { EditorView } from '@codemirror/view';

  import DiffViewer from './DiffViewer.svelte';
  import type EditorComponent from './Editor.svelte';
  import type FileExplorerComponent from './FileExplorer.svelte';
  import type GitPanelComponent from './GitPanel.svelte';
  import * as Tooltip from './ui/tooltip';
  import { cn } from '@np/core';

  const appState = useAppState();

  // Lazy load heavy components
  let Editor = $state<typeof EditorComponent | null>(null);
  let FileExplorer = $state<typeof FileExplorerComponent | null>(null);
  let GitPanel = $state<typeof GitPanelComponent | null>(null);

  let draggedId = $state<string | null>(null);
  let initialTabIds: string[] | null = null;
  let didDrop = false;
  let editorViews = $state<Record<string, EditorView | undefined>>({});

  $effect(() => {
    appState.activeEditorView = appState.activeTabId ? editorViews[appState.activeTabId] : undefined;
  });

  function handleDragStart(e: DragEvent, id: string) {
    draggedId = id;
    didDrop = false;
    initialTabIds = appState.workspace.tabs.map(t => t.id);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.dropEffect = 'move';
    }
  }

  function handleDragEnter(targetId: string) {
    if (!draggedId || draggedId === targetId) return;

    const tabs = appState.workspace.tabs;
    const fromIdx = tabs.findIndex(t => t.id === draggedId);
    const toIdx = tabs.findIndex(t => t.id === targetId);

    if (fromIdx !== -1 && toIdx !== -1) {
      appState.workspace.moveTab(fromIdx, toIdx);
    }
  }

  function handleDrop() {
    didDrop = true;
    initialTabIds = null;
  }

  function handleDragEnd() {
    if (!didDrop && initialTabIds) {
      const tabMap = new Map(appState.workspace.tabs.map(t => [t.id, t]));
      const restored = initialTabIds.map(id => tabMap.get(id)).filter(Boolean) as typeof appState.workspace.tabs;
      if (restored.length === appState.workspace.tabs.length) {
        appState.workspace.setTabs(restored);
      }
    }
    draggedId = null;
    initialTabIds = null;
    didDrop = false;
  }

  onMount(() => {
    // Load heavy components after the first paint
    Promise.all([
      import("./Editor.svelte"),
      import("./FileExplorer.svelte"),
      import("./GitPanel.svelte")
    ]).then(([editorMod, explorerMod, gitMod]) => {
      Editor = editorMod.default;
      FileExplorer = explorerMod.default;
      GitPanel = gitMod.default;
    }).catch(err => {
      console.error("[MainLayout] Failed to load components:", err);
    });
  });

  let isDragging = $state(false);

  function startResize(e: MouseEvent) {
    e.preventDefault();
    isDragging = true;

    function onMouseMove(moveEvent: MouseEvent) {
      if (!isDragging) return;
      const newWidth = Math.max(150, Math.min(600, moveEvent.clientX));
      appState.prefs.sidebarWidth = newWidth;
    }

    function onMouseUp() {
      isDragging = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    }

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }
</script>

<div class="flex h-full w-full overflow-hidden" class:select-none={isDragging}>
  <aside 
    class="relative shrink-0 bg-sidebar flex flex-col overflow-hidden"
    class:border-r={appState.prefs.sidebarVisible}
    class:transition-[width]={!isDragging}
    class:duration-300={!isDragging}
    class:ease-in-out={!isDragging}
    style="width: {appState.prefs.sidebarVisible ? appState.prefs.sidebarWidth : 0}px;"
    inert={!appState.prefs.sidebarVisible}
  >
    <div style="width: {appState.prefs.sidebarWidth}px;" class="flex-1 min-h-0 flex flex-col">
      {#if appState.activeSidebarTab === 'explorer'}
        {#if FileExplorer}
          <FileExplorer />
        {:else}
          <div class="p-4 space-y-2 animate-pulse">
            <div class="h-4 bg-muted rounded w-3/4"></div>
            <div class="h-4 bg-muted rounded w-1/2"></div>
            <div class="h-4 bg-muted rounded w-2/3"></div>
          </div>
        {/if}
      {:else if appState.activeSidebarTab === 'git'}
        {#if GitPanel}
          <GitPanel />
        {:else}
          <div class="p-4 space-y-2 animate-pulse">
            <div class="h-4 bg-muted rounded w-3/4"></div>
            <div class="h-4 bg-muted rounded w-1/2"></div>
            <div class="h-4 bg-muted rounded w-2/3"></div>
          </div>
        {/if}
      {/if}
    </div>
    
    <!-- Resize Handle -->
    <button 
      type="button"
      aria-label="Resize Sidebar"
      tabindex="-1"
      onmousedown={startResize}
      class="absolute top-0 right-0 w-1.5 -mr-[3px] h-full cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors z-50 select-none outline-none border-none p-0 bg-transparent"
    ></button>
  </aside>

  <Tabs.Root bind:value={appState.activeTabId} class="flex flex-1 flex-col min-w-0">
    {#if appState.workspace.tabs.length > 1 || appState.workspace.tabs.some(t => t.type === 'diff')}
      <Tabs.List class="bg-accent/50 justify-start rounded-none items-end gap-0 pb-0 w-full overflow-x-auto overflow-y-hidden no-scrollbar">
        <Tooltip.Provider delayDuration={400}>
          {#each appState.workspace.tabs as tab (tab.id)}
            {@const doc = tab.type === 'document' ? appState.documents.find(d => d.id === tab.id) : null}
            {@const title = tab.type === 'diff' ? 'Uncommitted Changes' : (doc?.fileName ?? 'Untitled')}
            {@const isModified = tab.type === 'document' && doc?.isModified}
            {@const deletedOnDisk = tab.type === 'document' && doc?.deletedOnDisk}
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
                    class="data-[state=active]:bg-background! data-[state=active]:border-border! px-1 py-0 text-xs font-medium pr-6 border-b-0! rounded-none border-transparent! hover:bg-accent flex items-center gap-1.5 {deletedOnDisk ? 'line-through opacity-60 text-muted-foreground' : ''}"
                  >
                    {#if tab.type === 'diff'}
                      <GitDiffIcon class="size-3.5 opacity-90 text-primary shrink-0" />
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
                  {deletedOnDisk ? `${title} (deleted on disk)` : doc?.origin?.path}
                </Tooltip.Content>
              </Tooltip.Root>
  
              <Tooltip.Provider delayDuration={400}>
                <Tooltip.Root>
                  <Tooltip.Trigger>              
                    <button
                      onclick={(e) => {
                        e.stopPropagation();
                        appState.closeTab(tab.id);
                      }}
                      class="group/close absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded-sm hover:bg-muted transition-opacity focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-primary focus-visible:outline-none {isModified ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}"
                    >
                      {#if isModified} group-tab-active:hidden
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
              <span class={cn("absolute group-hover:hidden bg-border h-2/3 w-[1px] top-1/2 -translate-y-1/2 -translate-x-[1px]", appState.activeTabId === tab.id && "hidden")}></span>
            </div>
          {/each}
        </Tooltip.Provider>
        <div class="flex-1 h-full min-w-4"></div>
      </Tabs.List>
    {/if}
    {#if appState.workspace.tabs.length === 0}
      <div class="flex-1 flex items-center justify-center text-muted-foreground bg-background">
        <p>No documents open. Press Ctrl+N to create a new one.</p>
      </div>
    {:else}
      {#each appState.workspace.tabs as tab (tab.id)}
        <Tabs.Content value={tab.id} class="flex-1 overflow-hidden focus-visible:outline-none m-0 p-0 h-full">
          {#if appState.activeTabId === tab.id}
            {#if tab.type === 'diff'}
              <div class="h-full w-full overflow-hidden">
                <DiffViewer 
                  changes={appState.workspace.repository?.changes ?? []}
                />
              </div>
            {:else if Editor}
              {@const doc = appState.documents.find(d => d.id === tab.id)}
              {#if doc}
                <Editor 
                  doc={doc} 
                  active={true}
                  bind:view={editorViews[tab.id]}
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
