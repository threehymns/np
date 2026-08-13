<script lang="ts">
  import { setContext, onMount } from "svelte";
  import { AppState, KeymapStorageProvider } from "@np/core";
  import { MultiSchemeStorage } from "@np/core/storage";
  import { ElectronStorage } from "./ElectronStorage";
  import { JSONFilePersistence } from "./JSONFilePersistence";
  import { SpawnGitAdapter } from "./SpawnGitAdapter";
  
  // Use direct imports to avoid pulling in the entire UI library index
  import AppShell from "@np/ui/AppShell.svelte";
  import * as Tabs from "@np/ui/Tabs";
  import Icon from "@np/ui/Icon.svelte";
  
  import { DiffViewer } from "@np/ui";

  import { X } from "phosphor-svelte";
  import { flip } from "svelte/animate";
  import type { EditorView } from "codemirror";

  const storage = new MultiSchemeStorage();
  storage.registerProvider("file", new ElectronStorage());
  const persistence = new JSONFilePersistence();
  const vcsFactory = (origin: any) => new SpawnGitAdapter(origin);
  const appState = new AppState({ storage, persistence, vcsFactory });
  storage.registerProvider("keymap", new KeymapStorageProvider(appState.keymaps));
  setContext("appState", appState);

  if (typeof window !== "undefined") {
    (window as any).appState = appState;
  }

  // Lazy load heavy components
  let Editor = $state<any>(null);
  let FileExplorer = $state<any>(null);
  let GitPanel = $state<any>(null);

  let draggedId = $state<string | null>(null);
  let editorViews = $state<Record<string, EditorView | undefined>>({});

  function handleDragStart(e: DragEvent, id: string) {
    draggedId = id;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.dropEffect = "move";
    }
  }

  function handleDragEnter(targetId: string) {
    if (!draggedId || draggedId === targetId) return;

    const tabs = appState.workspace.tabs;
    const fromIdx = tabs.findIndex(t => t.id === draggedId);
    const toIdx = tabs.findIndex(t => t.id === targetId);

    if (fromIdx !== -1 && toIdx !== -1) {
      const [movedTab] = tabs.splice(fromIdx, 1);
      tabs.splice(toIdx, 0, movedTab);
    }
  }

  function handleDragEnd() {
    draggedId = null;
  }

  onMount(() => {
    // Basic initialization is enough for the first paint
    if (window.electronAPI?.showWindow) {
      window.electronAPI.showWindow();
    }

    // Load heavy components after the first paint
    Promise.all([
      import("@np/ui/Editor.svelte"),
      import("@np/ui/FileExplorer.svelte"),
      import("@np/ui/GitPanel.svelte")
    ]).then(([editorMod, explorerMod, gitMod]) => {
      Editor = editorMod.default;
      FileExplorer = explorerMod.default;
      GitPanel = gitMod.default;
    }).catch(err => {
      console.error("[App] Failed to load heavy components:", err);
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
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }
</script>

<AppShell>
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

    <Tabs.Root bind:value={appState.activeTabId} class="flex h-full flex-1 flex-col min-w-0">
      {#if appState.workspace.tabs.length > 1 || appState.workspace.tabs.some(t => t.type === 'diff')}
        <Tabs.List class="bg-muted/50 justify-start rounded-none border-b px-2 h-10 items-end gap-1 w-full overflow-visible no-scrollbar">
          {#each appState.workspace.tabs as tab (tab.id)}
            {@const doc = tab.type === 'document' ? appState.documents.find(d => d.id === tab.id) : null}
            {@const title = tab.type === 'diff' ? 'Uncommitted Changes' : (doc?.fileName ?? 'Untitled')}
            {@const isModified = tab.type === 'document' && doc?.isModified}
            {@const deletedOnDisk = tab.type === 'document' && doc?.deletedOnDisk}
            <div 
              animate:flip={{ duration: 150 }}
              class="group relative flex items-center h-full shrink-0 {draggedId === tab.id ? 'opacity-20' : ''}"
              draggable="true"
              ondragstart={(e) => handleDragStart(e, tab.id)}
              ondragover={(e) => e.preventDefault()}
              ondragenter={() => handleDragEnter(tab.id)}
              ondragend={handleDragEnd}
              role="listitem"
            >
              <Tabs.Trigger
                value={tab.id}
                class="data-[state=active]:bg-background px-3 py-1.5 text-xs font-medium pr-8 h-8 rounded-t-sm border-x border-t border-transparent data-[state=active]:border-border transition-colors hover:bg-background/50 focus-visible:ring-inset flex items-center gap-1.5 {deletedOnDisk ? 'line-through opacity-60 text-muted-foreground' : ''}"
                title={deletedOnDisk ? `${title} (deleted on disk)` : title}
              >
                {#if tab.type === 'diff'}
                  <span class="size-3.5 opacity-90 text-primary font-bold">Δ</span>
                {:else}
                  <Icon 
                    resource={title}
                    type="file"
                    class="size-3.5 opacity-90" 
                  />
                {/if}
                {title}
              </Tabs.Trigger>
              <button
                onclick={(e) => {
                  e.stopPropagation();
                  appState.closeTab(tab.id);
                }}
                class="group/close absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded-sm hover:bg-muted transition-opacity focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-primary focus-visible:outline-none {isModified ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}"
                title="Close tab"
              >
                {#if isModified}
                  <div class="w-1.5 h-1.5 rounded-full bg-foreground/40 group-hover:hidden group-focus-visible/close:hidden m-0.5"></div>
                  <X size={10} class="hidden group-hover:block group-focus-visible/close:block" />
                {:else}
                  <X size={10} />
                {/if}
              </button>
            </div>
          {/each}
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
</AppShell>

<style>
  :global(.no-scrollbar::-webkit-scrollbar) {
    display: none;
  }
  :global(.no-scrollbar) {
    -ms-overflow-style: none;
    scrollbar-width: none;
  }
</style>
