<script lang="ts">
  import { setContext, onMount } from "svelte";
  import { AppState, KeymapStorageProvider, ManifestIconProvider, type ExportService } from "@np/core";
  import { iconRegistry } from "@np/ui";
  import { MultiSchemeStorage } from "@np/core/storage";
  import { ElectronStorage } from "./ElectronStorage";
  import { ElectronSessionPersistence } from "./ElectronSessionPersistence";
  import { SpawnGitAdapter } from "./SpawnGitAdapter";

  import AppShell from "@np/ui/AppShell.svelte";
  import { MainLayout } from "@np/ui";

  const storage = new MultiSchemeStorage();
  storage.registerProvider("file", new ElectronStorage());
  const persistence = new ElectronSessionPersistence();
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
    vcsFactory,
    dialogService: {
      alert: (msg) => {
        if (typeof window !== 'undefined' && typeof window.alert === 'function') {
          window.alert(msg);
        }
      },
      confirm: (msg) => {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          return window.confirm(msg);
        }
        return false;
      }
    },
    iconRegistry,
    exportService,
    clipboardService: {
      writeText: async (text) => {
        if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
          // edit.cut deletes the selection only when this resolves.
          throw new Error('Clipboard API is unavailable');
        }
        await navigator.clipboard.writeText(text);
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
