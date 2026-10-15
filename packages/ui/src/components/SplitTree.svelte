<script lang="ts">
	import type { LayoutNode } from '@np/core';
	import type EditorComponent from './Editor.svelte';
	import type { EditorView } from '@codemirror/view';
	import PaneView from './Pane.svelte';
	import SplitTree from './SplitTree.svelte';

	let {
		node,
		Editor = null,
		editorViews = $bindable({}),
	}: {
		node: LayoutNode;
		Editor?: typeof EditorComponent | null;
		editorViews?: Record<string, EditorView | undefined>;
	} = $props();
</script>

{#if node.type === 'pane'}
	<PaneView pane={node} {Editor} bind:editorViews />
{:else if node.type === 'axis'}
	<div
		class="flex flex-1 min-w-0 min-h-0 h-full w-full overflow-hidden divide-border {node.axis === 'horizontal' ? 'flex-row divide-x' : 'flex-col divide-y'}"
	>
		{#each node.children as child (child.id)}
			<div
				class="min-w-0 min-h-0 overflow-hidden flex flex-col"
				style="flex: {child.flex ?? 1} 1 0px;"
			>
				<SplitTree node={child} {Editor} bind:editorViews />
			</div>
		{/each}
	</div>
{/if}
