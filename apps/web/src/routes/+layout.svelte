<script lang="ts">
	import { setContext } from "svelte";
	import { AppState, MultiSchemeStorage, IsomorphicGitAdapter } from "@np/core";
	import { AppShell } from "@np/ui";
	import "./layout.css";

	const storage = new MultiSchemeStorage();
	const vcsFactory = (rootHandle: FileSystemDirectoryHandle) => new IsomorphicGitAdapter(rootHandle);
	const appState = new AppState({ storage, vcsFactory });
	setContext("appState", appState);

	if (typeof window !== "undefined") {
		(window as any).appState = appState;
	}

	let { children } = $props();
</script>

<AppShell>
	{@render children()}
</AppShell>
