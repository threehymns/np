<script lang="ts">
  import { onMount } from 'svelte';
  import { appState } from '$lib/state.svelte.js';
  import * as Tabs from "$lib/components/ui/tabs/index.js";
  import { X } from "phosphor-svelte";
  import { flip } from 'svelte/animate';

  function handleUpdate(e?: Event) {
    const target = (e?.target || document.querySelector('textarea')) as HTMLTextAreaElement;
    if (!target) return;
    
    const textBeforeCursor = target.value.substring(0, target.selectionStart);
    const lines = textBeforeCursor.split('\n');
    appState.line = lines.length;
    appState.column = lines[lines.length - 1].length + 1;
    
    if (e?.type === 'input' && appState.activeDocument) {
      appState.activeDocument.updateContent(target.value);
    }
  }

  let draggedIdx = $state<number | null>(null);

  function handleDragStart(e: DragEvent, idx: number) {
    draggedIdx = idx;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.dropEffect = 'move';
    }
  }

  function handleDragOver(e: DragEvent, idx: number) {
    e.preventDefault();
    if (draggedIdx === null || draggedIdx === idx) return;

    const docs = [...appState.documents];
    const [movedDoc] = docs.splice(draggedIdx, 1);
    docs.splice(idx, 0, movedDoc);
    appState.documents = docs;
    draggedIdx = idx;
  }

  function handleDragEnd() {
    draggedIdx = null;
  }

  onMount(() => {
    handleUpdate();
  });
</script>

<Tabs.Root bind:value={appState.activeDocumentId} class="flex h-full w-full flex-col">
  {#if appState.documents.length > 1}
    <Tabs.List class="bg-muted/50 justify-start rounded-none border-b px-2 py-0 h-9 gap-1 w-full overflow-x-auto overflow-y-hidden no-scrollbar">
      {#each appState.documents as doc, i (doc.id)}
        <div 
          animate:flip={{ duration: 200 }}
          class="group relative flex items-center h-full shrink-0 {draggedIdx === i ? 'opacity-50' : ''}"
          draggable="true"
          ondragstart={(e) => handleDragStart(e, i)}
          ondragover={(e) => handleDragOver(e, i)}
          ondragend={handleDragEnd}
          role="listitem"
        >
          <Tabs.Trigger
            value={doc.id}
            class="data-[state=active]:bg-background px-3 py-1.5 text-xs font-medium pr-8 h-8 rounded-t-sm border-x border-t border-transparent data-[state=active]:border-border transition-colors hover:bg-background/50"
          >
            {doc.fileName}{doc.isModified ? '*' : ''}
          </Tabs.Trigger>
          <button
            onclick={(e) => {
              e.stopPropagation();
              appState.closeDocument(doc.id);
            }}
            class="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded-sm hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity"
            title="Close tab"
          >
            <X size={10} />
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
        <textarea
          class="bg-background text-foreground h-full w-full resize-none p-4 font-mono focus:outline-none"
          spellcheck="false"
          style="font-size: {appState.prefs.zoom}%;"
          wrap={appState.prefs.wordWrap ? 'soft' : 'off'}
          value={doc.content}
          oninput={handleUpdate}
          onclick={handleUpdate}
          onkeyup={handleUpdate}
        ></textarea>
      </Tabs.Content>
    {/each}
  {/if}
</Tabs.Root>

<style>
  .no-scrollbar::-webkit-scrollbar {
    display: none;
  }
  .no-scrollbar {
    -ms-overflow-style: none;
    scrollbar-width: none;
  }
</style>
