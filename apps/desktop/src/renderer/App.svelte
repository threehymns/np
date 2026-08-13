<script lang="ts">
  import { setContext, onMount } from "svelte";
  import { AppState, KeymapStorageProvider } from "@np/core";
  import { MultiSchemeStorage } from "@np/core/storage";
  import { ElectronStorage } from "./ElectronStorage";
  import { JSONFilePersistence } from "./JSONFilePersistence";
  import { SpawnGitAdapter } from "./SpawnGitAdapter";
  
  import AppShell from "@np/ui/AppShell.svelte";
  import { MainLayout } from "@np/ui";

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

  onMount(() => {
    if (window.electronAPI?.showWindow) {
      window.electronAPI.showWindow();
    }
  });
</script>

<AppShell>
  <MainLayout />
</AppShell>
