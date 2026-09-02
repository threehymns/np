<script lang="ts">
	import { setContext } from "svelte";
	import { AppState, KeymapStorageProvider, ManifestIconProvider, Repository, type ExportService } from "@np/core";
	import { iconRegistry } from "@np/ui";
	import { MultiSchemeStorage } from "@np/core/storage";
	import { BrowserStorage, IsomorphicGitAdapter, IndexedDBSessionPersistence, git } from "@np/adapters-browser";
	import AppShell from "@np/ui/AppShell.svelte";
	import "./layout.css";

	const storage = new MultiSchemeStorage();
	storage.registerProvider('browser', new BrowserStorage());
	const persistence = new IndexedDBSessionPersistence();
	const vcsFactory = (origin: any) => new IsomorphicGitAdapter(origin);

	const exportService: ExportService = {
		exportFile: async ({ content, suggestedName, mimeType, types }) => {
			const fileName = suggestedName || 'export.html';
			if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
				try {
					const handle = await (window as any).showSaveFilePicker({
						suggestedName: fileName,
						types: types ?? (mimeType ? [{ description: 'Files', accept: { [mimeType]: [] } }] : undefined)
					});
					const writable = await handle.createWritable();
					await writable.write(content);
					await writable.close();
				} catch (e) {
					if ((e as { name?: string } | null | undefined)?.name !== 'AbortError') throw e;
				}
			} else if (typeof document !== 'undefined') {
				const blob = new Blob([content], { type: mimeType || 'application/octet-stream' });
				const url = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = url;
				a.download = fileName;
				a.click();
				// Deferred revocation: revoking synchronously can cancel the
				// download before it starts in Firefox and Safari.
				setTimeout(() => URL.revokeObjectURL(url), 1000);
			}
		}
	};

	const appState = new AppState({
		storage,
		persistence,
		vcsFactory,
		iconRegistry,
		exportService
	});
	storage.registerProvider('keymap', new KeymapStorageProvider(appState.keymaps));
	setContext("appState", appState);

	if (typeof window !== "undefined") {
		(window as any).appState = appState;
		(window as any).ManifestIconProvider = ManifestIconProvider;
		(window as any).Repository = Repository;
		(window as any).git = git;
		console.log('[Layout] AppState exposed on window. documents count:', appState.documents.length);
	}

	let { children } = $props();
</script>

<AppShell>
	{@render children()}
</AppShell>
