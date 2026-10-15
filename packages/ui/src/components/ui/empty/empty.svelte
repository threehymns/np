<script lang="ts">
	import type { HTMLAttributes } from "svelte/elements";
	import { cn, type WithElementRef } from '@np/core';
	import EmptyMedia from "./empty-media.svelte";
	import EmptyTitle from "./empty-title.svelte";
	import EmptyDescription from "./empty-description.svelte";
	import { FileIcon } from 'phosphor-svelte';

	let {
		ref = $bindable(null),
		class: className,
		title = "No documents open",
		description = "Press Ctrl+N to create a new one, or split a document into this pane.",
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		title?: string;
		description?: string;
	} = $props();
</script>

<div
	bind:this={ref}
	data-slot="empty"
	class={cn(
		"flex h-full w-full flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground bg-background select-none",
		className
	)}
	{...restProps}
>
	{#if children}
		{@render children()}
	{:else}
		<EmptyMedia>
			<FileIcon class="size-6 opacity-60" />
		</EmptyMedia>
		<EmptyTitle>{title}</EmptyTitle>
		<EmptyDescription>{description}</EmptyDescription>
	{/if}
</div>
