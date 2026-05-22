<script lang="ts">
	import type { Component } from 'svelte';
	import { File } from 'phosphor-svelte';
	import { iconRegistry } from '@np/core';
	import type { ResolvedIcon } from '@np/core';

	interface Props {
		// New resolver props
		resource?: string;
		type?: 'file' | 'folder' | 'product';
		languageMode?: string;
		folderOpen?: boolean;

		// Legacy explicit/override props
		icon?: string | Component<any> | null | undefined;
		themeFallback?: string | Component<any> | null | undefined;
		phosphorFallback?: Component<any>;

		size?: number | string;
		class?: string;
		alt?: string;
		[key: string]: any;
	}

	let { 
		resource,
		type,
		languageMode,
		folderOpen = false,
		icon, 
		themeFallback,
		phosphorFallback = File,
		size = 16, 
		class: className = '', 
		alt = 'icon', 
		...restProps 
	}: Props = $props();

	// Set of URLs that have failed loading
	let failedUrls = $state<Set<string>>(new Set());

	// Reset error state if inputs change
	$effect(() => {
		resource;
		type;
		languageMode;
		folderOpen;
		icon;
		themeFallback;
		failedUrls = new Set();
	});

	// Derive the active resolved icon based on props and loading failures
	let activeResolved = $derived.by((): ResolvedIcon => {
		// 1. If explicit props are passed (legacy mode/overrides)
		if (icon) {
			const primarySrc = typeof icon === 'string' ? icon : '';
			if (primarySrc && failedUrls.has(primarySrc)) {
				// Try themeFallback
				if (themeFallback) {
					const fallbackSrc = typeof themeFallback === 'string' ? themeFallback : '';
					if (fallbackSrc && failedUrls.has(fallbackSrc)) {
						return { type: 'component', value: phosphorFallback };
					}
					return typeof themeFallback === 'string' 
						? { type: 'url', value: themeFallback } 
						: { type: 'component', value: themeFallback };
				}
				return { type: 'component', value: phosphorFallback };
			}
			return typeof icon === 'string'
				? { type: 'url', value: icon }
				: { type: 'component', value: icon };
		}

		// 2. If clean resolver props are passed
		if (resource !== undefined) {
			let chain: ResolvedIcon[] = [];
			if (type === 'folder') {
				chain = iconRegistry.resolveFolderIconChain(resource, { expanded: folderOpen });
			} else if (type === 'product') {
				chain = iconRegistry.resolveProductIconChain(resource);
			} else {
				chain = iconRegistry.resolveFileIconChain(resource, { language: languageMode });
			}

			// Find first in chain that hasn't failed
			for (const resolved of chain) {
				if (resolved.type === 'url' && failedUrls.has(resolved.value)) {
					continue;
				}
				return resolved;
			}
			return { type: 'component', value: phosphorFallback };
		}

		// 3. Fallback if nothing resolved
		if (themeFallback) {
			const fallbackSrc = typeof themeFallback === 'string' ? themeFallback : '';
			if (fallbackSrc && failedUrls.has(fallbackSrc)) {
				return { type: 'component', value: phosphorFallback };
			}
			return typeof themeFallback === 'string' 
				? { type: 'url', value: themeFallback } 
				: { type: 'component', value: themeFallback };
		}

		return { type: 'component', value: phosphorFallback };
	});

	let hasError = $derived.by(() => {
		// 1. If explicit props are passed (legacy mode/overrides)
		if (icon) {
			const primarySrc = typeof icon === 'string' ? icon : '';
			if (primarySrc && failedUrls.has(primarySrc)) {
				// Try themeFallback
				if (themeFallback) {
					const fallbackSrc = typeof themeFallback === 'string' ? themeFallback : '';
					if (fallbackSrc && failedUrls.has(fallbackSrc)) {
						return true;
					}
				} else {
					return true;
				}
			}
		}

		// 2. If clean resolver props are passed
		if (resource !== undefined) {
			let chain: ResolvedIcon[] = [];
			if (type === 'folder') {
				chain = iconRegistry.resolveFolderIconChain(resource, { expanded: folderOpen });
			} else if (type === 'product') {
				chain = iconRegistry.resolveProductIconChain(resource);
			} else {
				chain = iconRegistry.resolveFileIconChain(resource, { language: languageMode });
			}

			// We have an error if there was at least one URL in the chain, and all URLs in the chain have failed.
			const urls = chain.filter(r => r.type === 'url') as { type: 'url'; value: string }[];
			if (urls.length > 0 && urls.every(u => failedUrls.has(u.value))) {
				return true;
			}
		}

		// 3. Fallback if nothing resolved but legacy fallback is present and failed
		if (!icon && resource === undefined && themeFallback) {
			const fallbackSrc = typeof themeFallback === 'string' ? themeFallback : '';
			if (fallbackSrc && failedUrls.has(fallbackSrc)) {
				return true;
			}
		}

		return false;
	});

	const sizePx = $derived(typeof size === 'number' ? size + 'px' : size);
	const isThemeFallback = $derived(
		activeResolved.type === 'url' && (
			activeResolved.value === themeFallback ||
			activeResolved.value === iconRegistry.getThemeDefaultFileIcon() ||
			activeResolved.value === iconRegistry.getThemeDefaultFolderIcon() ||
			activeResolved.value === iconRegistry.getThemeDefaultFolderExpandedIcon()
		)
	);
</script>

{#if activeResolved.type === 'url'}
	<img
		src={activeResolved.value}
		alt={alt}
		style="width: {sizePx}; height: {sizePx};"
		class="select-none {className}"
		onerror={() => {
			failedUrls.add(activeResolved.value);
			failedUrls = new Set(failedUrls);
		}}
		data-icon-theme-fallback={isThemeFallback ? "true" : undefined}
		{...restProps}
	/>
{:else if activeResolved.type === 'component'}
	{@const IconComponent = activeResolved.value}
	<IconComponent
		size={size}
		class={className}
		data-icon-error={hasError ? "true" : undefined}
		{...restProps}
	/>
{:else}
	{@const FallbackComponent = phosphorFallback}
	<FallbackComponent
		size={size}
		class={className}
		data-icon-error={hasError ? "true" : undefined}
		{...restProps}
	/>
{/if}
