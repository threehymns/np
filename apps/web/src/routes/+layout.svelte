<script lang="ts">
	import { setContext } from "svelte";
	import { AppState, KeymapStorageProvider } from "@np/core";
	import { MultiSchemeStorage } from "@np/core/storage";
	import { BrowserStorage, IsomorphicGitAdapter, IndexedDBSessionPersistence } from "@np/adapters-browser";
	import AppShell from "@np/ui/AppShell.svelte";
	import "./layout.css";

	const storage = new MultiSchemeStorage();
	storage.registerProvider('browser', new BrowserStorage());
	const persistence = new IndexedDBSessionPersistence();
	const vcsFactory = (origin: any) => new IsomorphicGitAdapter(origin);
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
	storage.registerProvider('keymap', new KeymapStorageProvider(appState.keymaps));
	setContext("appState", appState);

	if (typeof window !== "undefined") {
		(window as any).appState = appState;
		console.log('[Layout] AppState exposed on window. documents count:', appState.documents.length);
	}

	let { children } = $props();
</script>

<AppShell>
	{@render children()}
</AppShell>
