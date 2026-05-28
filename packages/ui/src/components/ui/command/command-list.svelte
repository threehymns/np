<script lang="ts">
	import { Command as CommandPrimitive } from "bits-ui";
	import { cn } from '@np/core';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: CommandPrimitive.ListProps = $props();
</script>

<CommandPrimitive.List
	bind:ref
	data-slot="command-list"
	class={cn("max-h-72 overflow-y-auto overflow-x-hidden scroll-py-1 outline-none", className)}
	{...restProps}
>
	{@render children?.()}
</CommandPrimitive.List>
