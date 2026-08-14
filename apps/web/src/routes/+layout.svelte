<script lang="ts">
	import { setContext } from "svelte";
	import { AppState, KeymapStorageProvider, Repository, toURI, parseURI } from "@np/core";
	import { MultiSchemeStorage } from "@np/core/storage";
	import { BrowserStorage, IsomorphicGitAdapter, IndexedDBSessionPersistence, browserHandleRegistry, git } from "@np/adapters-browser";
	import AppShell from "@np/ui/AppShell.svelte";
	import "./layout.css";

	const storage = new MultiSchemeStorage();
	storage.registerProvider('browser', new BrowserStorage());
	const persistence = new IndexedDBSessionPersistence();
	const vcsFactory = (origin: any) => new IsomorphicGitAdapter(origin);
	const appState = new AppState({ storage, persistence, vcsFactory });
	storage.registerProvider('keymap', new KeymapStorageProvider(appState.keymaps));
	setContext("appState", appState);

	if (typeof window !== "undefined") {
		(window as any).appState = appState;
		(window as any).toURI = toURI;
		(window as any).parseURI = parseURI;
		(window as any).browserHandleRegistry = browserHandleRegistry;
		(window as any).Repository = Repository;
		(window as any).git = git;
		console.log('[Layout] AppState exposed on window. documents count:', appState.documents.length);
	}

	let { children } = $props();
</script>

<AppShell>
	{@render children()}
</AppShell>
