<script lang="ts">
	import type { HTMLAttributes } from "svelte/elements";
	import { cn, type WithElementRef } from '@np/core';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<div
	bind:this={ref}
	data-slot="empty-media"
	class={cn(
		"flex size-12 items-center justify-center rounded-lg bg-muted/50 text-muted-foreground mb-1 [&>svg]:size-6",
		className
	)}
	{...restProps}
>
	{@render children?.()}
</div>
