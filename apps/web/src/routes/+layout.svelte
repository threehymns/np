<script lang="ts">
	import { setContext } from "svelte";
	import { AppState } from "@np/core/state.svelte";
	import { MultiSchemeStorage } from "@np/core/storage";
	import { BrowserStorage, IsomorphicGitAdapter, IndexedDBWorkspacePersistence } from "@np/adapters-browser";
	import AppShell from "@np/ui/AppShell.svelte";
	import "./layout.css";

	const storage = new MultiSchemeStorage();
	storage.registerProvider('browser', new BrowserStorage());
	const persistence = new IndexedDBWorkspacePersistence();
	const vcsFactory = (origin: any) => new IsomorphicGitAdapter(origin);
	const appState = new AppState({ storage, persistence, vcsFactory });
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
