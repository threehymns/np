<script lang="ts">
  import { setContext, onMount } from "svelte";
  import { AppState, KeymapStorageProvider, ManifestIconProvider, type ExportService } from "@np/core";
  import { iconRegistry } from "@np/ui";
  import { MultiSchemeStorage } from "@np/core/storage";
  import { ElectronStorage } from "./ElectronStorage";
  import { ElectronSessionPersistence } from "./ElectronSessionPersistence";
  import { ElectronConfigStorage } from "./ElectronConfigStorage";
  import { SpawnGitAdapter } from "./SpawnGitAdapter";

  import AppShell from "@np/ui/AppShell.svelte";
  import { MainLayout } from "@np/ui";

  const storage = new MultiSchemeStorage();
  storage.registerProvider("file", new ElectronStorage());
  const persistence = new ElectronSessionPersistence();
  const prefsStorage = new ElectronConfigStorage();
  const vcsFactory = (origin: any) => new SpawnGitAdapter(origin);

  const exportService: ExportService = {
    exportFile: async ({ content, suggestedName, types }) => {
      const fileName = suggestedName || 'export.html';
      const filters = types?.map(t => ({
        name: t.description,
        extensions: Object.values(t.accept).flat().map(ext => ext.replace(/^\./, ''))
      })) ?? [{ name: 'All Files', extensions: ['*'] }];

      if (window.electronAPI?.saveFileDialog) {
        const filePath = await window.electronAPI.saveFileDialog({
          defaultPath: fileName,
          filters
        });
        if (filePath) {
          await window.electronAPI.writeFile(filePath, content);
        }
      }
    }
  };

  const appState = new AppState({
    storage,
    persistence,
    prefsStorage,
    vcsFactory,
    iconRegistry,
    exportService
  });
  storage.registerProvider("keymap", new KeymapStorageProvider(appState.keymaps));
  setContext("appState", appState);

  if (typeof window !== "undefined") {
    (window as any).appState = appState;
    (window as any).ManifestIconProvider = ManifestIconProvider;
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
