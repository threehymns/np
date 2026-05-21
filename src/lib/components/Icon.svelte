<script lang="ts">
	import type { Component } from 'svelte';
	import { File } from 'phosphor-svelte';

	interface Props {
		icon: string | Component<any> | null | undefined;
		themeFallback?: string | Component<any> | null | undefined;
		phosphorFallback?: Component<any>;
		size?: number | string;
		class?: string;
		alt?: string;
		[key: string]: any;
	}

	let { 
		icon, 
		themeFallback,
		phosphorFallback = File,
		size = 16, 
		class: className = '', 
		alt = 'icon', 
		...restProps 
	}: Props = $props();

	let primaryError = $state(false);
	let themeFallbackError = $state(false);
</script>

{#if icon && !primaryError}
	{#if typeof icon === 'string'}
		<img
			src={icon}
			alt={alt}
			style="width: {typeof size === 'number' ? size + 'px' : size}; height: {typeof size === 'number' ? size + 'px' : size};"
			class="select-none {className}"
			onerror={() => primaryError = true}
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
{:else if themeFallback && !themeFallbackError}
	{#if typeof themeFallback === 'string'}
		<img
			src={themeFallback}
			alt={alt}
			style="width: {typeof size === 'number' ? size + 'px' : size}; height: {typeof size === 'number' ? size + 'px' : size};"
			class="select-none {className}"
			onerror={() => themeFallbackError = true}
			data-icon-theme-fallback="true"
			{...restProps}
		/>
	{:else}
		{@const IconComponent = themeFallback}
		<IconComponent
			size={size}
			class={className}
			data-icon-theme-fallback="true"
			{...restProps}
		/>
	{/if}
{:else}
	{@const FallbackComponent = phosphorFallback}
	<FallbackComponent
		size={size}
		class={className}
		data-icon-error="true"
		{...restProps}
	/>
{/if}
