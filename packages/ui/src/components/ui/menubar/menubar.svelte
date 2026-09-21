<script lang="ts">
	import { Menubar as MenubarPrimitive } from "bits-ui";
	import { cn } from '@np/core';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: MenubarPrimitive.RootProps = $props();
</script>

<MenubarPrimitive.Root
	bind:ref
	data-slot="menubar"
	class={cn("rounded-lg flex items-center", className)}
	{...restProps}
/>
