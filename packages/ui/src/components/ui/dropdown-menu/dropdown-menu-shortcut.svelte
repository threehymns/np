<script lang="ts">
	import { cn, type WithElementRef } from "@np/core";
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
	data-slot="dropdown-menu-shortcut"
	class={cn("text-muted-foreground group-focus/dropdown-menu-item:text-accent-foreground ml-auto text-[0.625rem] tracking-widest", className)}
	{...restProps}
>
	{@render children?.()}
</span>
