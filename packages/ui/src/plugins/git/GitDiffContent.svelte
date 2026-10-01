<script lang="ts">
	import { useAppState } from '@np/core/state.svelte';
	import DiffViewer from '../../components/DiffViewer.svelte';

	const appState = useAppState();
</script>

<div class="h-full w-full overflow-hidden">
	<DiffViewer changes={appState.workspace.repository?.changes ?? []} />
</div>
