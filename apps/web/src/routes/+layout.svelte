<script lang="ts">
	import { setContext } from "svelte";
	import { AppState, MultiSchemeStorage } from "@np/core";
	import { BrowserStorage, IsomorphicGitAdapter, IndexedDBWorkspacePersistence } from "@np/adapters-browser";
	import { AppShell } from "@np/ui";
	import "./layout.css";

	const storage = new MultiSchemeStorage();
	storage.registerProvider('browser', new BrowserStorage());
	const persistence = new IndexedDBWorkspacePersistence();
	const vcsFactory = (origin: any) => new IsomorphicGitAdapter(origin);
	const appState = new AppState({ storage, persistence, vcsFactory });
	setContext("appState", appState);

	if (typeof window !== "undefined") {
		(window as any).appState = appState;
	}

	let { children } = $props();
</script>

<AppShell>
	{@render children()}
</AppShell>
