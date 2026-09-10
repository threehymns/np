<script lang="ts">
  import { setContext, onMount } from "svelte";
  import { AppState, KeymapStorageProvider, ManifestIconProvider, type ExportService } from "@np/core";
  import { toURI } from "@np/core/storage";
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

    const unsubscribeConfig = window.electronAPI?.onConfigChanged?.((newContent: string) => {
      prefsStorage.updateFromExternal(newContent);
      // Reload regardless of validity so invalid content resets preferences to
      // their in-memory defaults until the external file is corrected.
      appState.prefs.reload();
    });

    // Main-process before-quit handshake: persist the latest workspace state
    // via awaited IPC saves, then ask main to flush the debounced engine to
    // disk. The preload notifies main on completion (even on error) so quit
    // proceeds; flushSync in main remains the final safety net.
    const unsubscribeFlush = window.electronAPI?.onSessionFlushRequest?.(async () => {
      try {
        const folderUri = appState.workspace.rootOrigin ? toURI(appState.workspace.rootOrigin) : '';
        await appState.workspace.saveFolderState(folderUri);
        await window.electronAPI.persistenceFlush();
      } catch (e) {
        console.error('[App] Session flush before quit failed', e);
      }
    });

    return () => {
      unsubscribeConfig?.();
      unsubscribeFlush?.();
    };
  });
</script>

<AppShell>
  <MainLayout />
</AppShell>
