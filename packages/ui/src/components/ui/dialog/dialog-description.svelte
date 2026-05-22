<script lang="ts">
	import { Dialog as DialogPrimitive } from "bits-ui";
	import { cn } from '@np/core';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: DialogPrimitive.DescriptionProps = $props();
</script>

<DialogPrimitive.Description
	bind:ref
	data-slot="dialog-description"
	class={cn("text-muted-foreground *:[a]:hover:text-foreground text-xs/relaxed *:[a]:underline *:[a]:underline-offset-3", className)}
	{...restProps}
/>
