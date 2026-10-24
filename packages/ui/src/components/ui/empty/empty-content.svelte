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
	data-slot="empty-content"
	class={cn("flex flex-col items-center gap-2 mt-2", className)}
	{...restProps}
>
	{@render children?.()}
</div>
