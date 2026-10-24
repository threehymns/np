<script lang="ts" module>
	import { tv } from "tailwind-variants";
	import type { ButtonSize } from '../button/button.svelte';

	/**
	 * The menubar trigger carries a text label, so the icon sizes of the
	 * button scale have no separate shape here: they reuse the label size of
	 * the same step.
	 */
	const labelSizes = {
		default: "px-2 py-[calc(--spacing(0.85))] text-xs/relaxed",
		xs: "px-1.5 py-[calc(--spacing(0.4))] text-[0.625rem]",
		sm: "px-2 py-[calc(--spacing(0.65))] text-xs/relaxed",
		lg: "px-2.5 py-[calc(--spacing(1.05))] text-xs/relaxed"
	};

	export const menubarTriggerVariants = tv({
		base: "hover:bg-muted aria-expanded:bg-muted rounded-[calc(var(--radius-md)-2px)] font-medium flex items-center outline-hidden select-none",
		variants: {
			size: {
				...labelSizes,
				icon: labelSizes.default,
				"icon-xs": labelSizes.xs,
				"icon-sm": labelSizes.sm,
				"icon-lg": labelSizes.lg
			}
		},
		defaultVariants: {
			size: "default"
		}
	});
</script>

<script lang="ts">
	import { Menubar as MenubarPrimitive } from "bits-ui";
	import { cn } from '@np/core';

	let {
		ref = $bindable(null),
		class: className,
		size = "default",
		...restProps
	}: MenubarPrimitive.TriggerProps & { size?: ButtonSize } = $props();
</script>

<MenubarPrimitive.Trigger
	bind:ref
	data-slot="menubar-trigger"
	class={cn(menubarTriggerVariants({ size }), className)}
	{...restProps}
/>
