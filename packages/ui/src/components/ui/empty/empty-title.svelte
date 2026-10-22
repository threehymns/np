<script lang="ts">
	import type { HTMLAttributes } from "svelte/elements";
	import { cn, type WithElementRef } from '@np/core';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLHeadingElement>> = $props();
</script>

<h3
	bind:this={ref}
	data-slot="empty-title"
	class={cn("text-sm font-medium text-foreground", className)}
	{...restProps}
>
	{@render children?.()}
</h3>
