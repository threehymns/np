<script lang="ts">
  import { onMount } from 'svelte';
  import { useAppState } from '@np/core/state.svelte';
  import type { EditorView } from '@codemirror/view';

  import type EditorComponent from './Editor.svelte';
  import type FileExplorerComponent from './FileExplorer.svelte';
  import SplitTree from './SplitTree.svelte';

  const appState = useAppState();

  let Editor = $state<typeof EditorComponent | null>(null);
  let FileExplorer = $state<typeof FileExplorerComponent | null>(null);

  let editorViews = $state<Record<string, EditorView | undefined>>({});

  $effect(() => {
    const activePane = appState.workspace.activePane;
    appState.activeEditorView = (activePane && activePane.activeTabId)
      ? editorViews[`${activePane.id}:${activePane.activeTabId}`]
      : undefined;
  });

  onMount(() => {
    // Load heavy components after the first paint
    Promise.all([
      import("./Editor.svelte"),
      import("./FileExplorer.svelte")
    ]).then(([editorMod, explorerMod]) => {
      Editor = editorMod.default;
      FileExplorer = explorerMod.default;
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
      {:else if appState.plugins.getSidebarPanel(appState.activeSidebarTab)}
        {@const panel = appState.plugins.getSidebarPanel(appState.activeSidebarTab)!}
        {@const PanelComponent = panel.component}
        <PanelComponent {...(panel.props ?? {})} />
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

  <main class="flex flex-1 flex-col min-w-0 min-h-0 h-full w-full overflow-hidden">
    <SplitTree node={appState.workspace.layout} {Editor} bind:editorViews />
  </main>
</div>
