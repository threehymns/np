<script lang="ts">
	import type { Component } from 'svelte';
	import { File } from 'phosphor-svelte';

	interface Props {
		icon: string | Component<any> | null | undefined;
		size?: number | string;
		class?: string;
		alt?: string;
		[key: string]: any;
	}

	let { icon, size = 16, class: className = '', alt = 'icon', ...restProps }: Props = $props();
	let error = $state(false);
</script>

{#if icon && !error}
	{#if typeof icon === 'string'}
		<img
			src={icon}
			alt={alt}
			style="width: {typeof size === 'number' ? size + 'px' : size}; height: {typeof size === 'number' ? size + 'px' : size};"
			class="select-none {className}"
			onerror={() => error = true}
			{...restProps}
		/>
	{:else}
		{@const IconComponent = icon}
		<IconComponent
			size={size}
			class={className}
			{...restProps}
		/>
	{/if}
{:else if icon && error}
	<File
		size={size}
		class={className}
		{...restProps}
	/>
{/if}
