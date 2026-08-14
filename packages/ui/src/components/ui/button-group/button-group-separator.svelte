<script lang="ts">
	import { cn } from "@np/core";
	import type { ComponentProps } from "svelte";
	import { Separator } from "../separator";

	let {
		ref = $bindable(null),
		class: className,
		orientation = "vertical",
		...restProps
	}: ComponentProps<typeof Separator> = $props();
</script>

<Separator
	bind:ref
	data-slot="button-group-separator"
	{orientation}
	class={cn(
		"bg-input relative self-stretch data-[orientation=vertical]:mx-px data-[orientation=vertical]:w-auto data-[orientation=horizontal]:my-px data-[orientation=horizontal]:h-auto",
		className
	)}
	{...restProps}
/>
