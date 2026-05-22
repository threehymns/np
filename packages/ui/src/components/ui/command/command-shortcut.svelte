<script lang="ts">
	import { cn, type WithElementRef } from '@np/core';
	import type { HTMLAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLSpanElement>> = $props();
</script>

<span
	bind:this={ref}
	data-slot="command-shortcut"
	class={cn("text-muted-foreground group-data-selected/command-item:text-foreground ml-auto text-[0.625rem] tracking-widest", className)}
	{...restProps}
>
	{@render children?.()}
</span>
