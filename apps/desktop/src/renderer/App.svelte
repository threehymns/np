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
  
  import { X } from "phosphor-svelte";
  import { flip } from "svelte/animate";
  import type { EditorView } from "@codemirror/view";

  const storage = new MultiSchemeStorage();
  storage.registerProvider("file", new ElectronStorage());
  const persistence = new JSONFilePersistence();
  const vcsFactory = (origin: any) => new SpawnGitAdapter(origin);
  const appState = new AppState({
    storage,
    persistence,
    vcsFactory,
    clipboardService: {
      writeText: async (text) => {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        }
      },
      readText: async () => {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
          return await navigator.clipboard.readText();
        }
        return '';
      }
    }
  });
  storage.registerProvider("keymap", new KeymapStorageProvider(appState.keymaps));
  setContext("appState", appState);

  if (typeof window !== "undefined") {
    (window as any).appState = appState;
  }

  // Lazy load heavy components
  let Editor = $state<any>(null);
  let FileExplorer = $state<any>(null);

  let draggedId = $state<string | null>(null);
  let editorViews = $state<Record<string, EditorView | undefined>>({});

  $effect(() => {
    appState.activeEditorView = editorViews[appState.activeDocumentId];
  });

  function handleUpdate(e?: Event) {}

  function handleDragStart(e: DragEvent, id: string) {
    draggedId = id;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.dropEffect = "move";
    }
  }

  function handleDragEnter(targetId: string) {
    if (!draggedId || draggedId === targetId) return;

    const fromIdx = appState.documents.findIndex(d => d.id === draggedId);
    const toIdx = appState.documents.findIndex(d => d.id === targetId);
    
    if (fromIdx === -1 || toIdx === -1) return;

    const docs = [...appState.documents];
    const [movedDoc] = docs.splice(fromIdx, 1);
    docs.splice(toIdx, 0, movedDoc);
    appState.workspace.reorderDocuments(docs);
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
      import("@np/ui/FileExplorer.svelte")
    ]).then(([editorMod, explorerMod]) => {
      Editor = editorMod.default;
      FileExplorer = explorerMod.default;
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
        {#if FileExplorer}
          <FileExplorer />
        {:else}
          <div class="p-4 space-y-2 animate-pulse">
            <div class="h-4 bg-muted rounded w-3/4"></div>
            <div class="h-4 bg-muted rounded w-1/2"></div>
            <div class="h-4 bg-muted rounded w-2/3"></div>
          </div>
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

    <Tabs.Root bind:value={appState.activeDocumentId} class="flex h-full flex-1 flex-col min-w-0">
      {#if appState.documents.length > 1}
        <Tabs.List class="bg-muted/50 justify-start rounded-none border-b px-2 h-10 items-end gap-1 w-full overflow-visible no-scrollbar">
          {#each appState.documents as doc (doc.id)}
            <div 
              animate:flip={{ duration: 150 }}
              class="group relative flex items-center h-full shrink-0 {draggedId === doc.id ? 'opacity-20' : ''}"
              draggable="true"
              ondragstart={(e) => handleDragStart(e, doc.id)}
              ondragover={(e) => e.preventDefault()}
              ondragenter={() => handleDragEnter(doc.id)}
              ondragend={handleDragEnd}
              role="listitem"
            >
              <Tabs.Trigger
                value={doc.id}
                class="data-[state=active]:bg-background px-3 py-1.5 text-xs font-medium pr-8 h-8 rounded-t-sm border-x border-t border-transparent data-[state=active]:border-border transition-colors hover:bg-background/50 focus-visible:ring-inset flex items-center gap-1.5 {doc.deletedOnDisk ? 'line-through opacity-60 text-muted-foreground' : ''}"
                title={doc.deletedOnDisk ? `${doc.fileName} (deleted on disk)` : doc.fileName}
              >
                <Icon 
                  resource={doc.fileName}
                  type="file"
                  class="size-3.5 opacity-90" 
                />
                {doc.fileName}
              </Tabs.Trigger>
              <button
                onclick={(e) => {
                  e.stopPropagation();
                  appState.closeDocument(doc.id);
                }}
                class="group/close absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded-sm hover:bg-muted transition-opacity focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-primary focus-visible:outline-none {doc.isModified ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}"
                title="Close tab"
              >
                {#if doc.isModified}
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
      {#if appState.documents.length === 0}
        <div class="flex-1 flex items-center justify-center text-muted-foreground bg-background">
          <p>No documents open. Press Ctrl+N to create a new one.</p>
        </div>
      {:else}
        {#each appState.documents as doc (doc.id)}
          <Tabs.Content value={doc.id} class="flex-1 overflow-hidden focus-visible:outline-none m-0 p-0">
            {#if appState.activeDocumentId === doc.id}
              {#if Editor}
                <Editor 
                  doc={doc} 
                  active={true}
                  bind:view={editorViews[doc.id]}
                  style="font-size: {appState.prefs.zoom}%;"
                  wrap={appState.prefs.wordWrap}
                />
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
