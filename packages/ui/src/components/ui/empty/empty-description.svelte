<script lang="ts">
	import type { HTMLAttributes } from "svelte/elements";
	import { cn, type WithElementRef } from '@np/core';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLParagraphElement>> = $props();
</script>

<p
	bind:this={ref}
	data-slot="empty-description"
	class={cn("text-xs text-muted-foreground max-w-sm", className)}
	{...restProps}
>
	{@render children?.()}
</p>
