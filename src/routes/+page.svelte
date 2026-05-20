<script lang="ts">
  import { onMount } from 'svelte';
  import { appState } from '$lib/state.svelte.js';
  import * as Tabs from "$lib/components/ui/tabs/index.js";
  import { X } from "phosphor-svelte";
  import { flip } from 'svelte/animate';
  import Editor from '$lib/components/Editor.svelte';
  import FileExplorer from '$lib/components/FileExplorer.svelte';
  import type { EditorView } from 'codemirror';

  let draggedId = $state<string | null>(null);
  let editorViews = $state<Record<string, EditorView | undefined>>({});

  $effect(() => {
    appState.activeEditorView = editorViews[appState.activeDocumentId];
  });

  function handleUpdate(e?: Event) {}

  function handleDragStart(e: DragEvent, id: string) {
    draggedId = id;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.dropEffect = 'move';
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
    handleUpdate();
  });
</script>

<div class="flex h-full w-full overflow-hidden">
  {#if appState.workspace.rootHandle}
    <aside class="w-64 shrink-0 border-r bg-muted/20 flex flex-col overflow-auto py-2">
      <FileExplorer />
    </aside>
  {/if}

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
              class="data-[state=active]:bg-background px-3 py-1.5 text-xs font-medium pr-8 h-8 rounded-t-sm border-x border-t border-transparent data-[state=active]:border-border transition-colors hover:bg-background/50 focus-visible:ring-inset"
            >
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
          <Editor 
            doc={doc} 
            bind:view={editorViews[doc.id]}
            style="font-size: {appState.prefs.zoom}%;"
            wrap={appState.prefs.wordWrap}
          />
        </Tabs.Content>
      {/each}
    {/if}
  </Tabs.Root>
</div>

<style>
  .no-scrollbar::-webkit-scrollbar {
    display: none;
  }
  .no-scrollbar {
    -ms-overflow-style: none;
    scrollbar-width: none;
  }
</style>
