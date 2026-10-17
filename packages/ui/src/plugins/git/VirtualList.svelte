<script lang="ts" generics="T">
	import type { Snippet } from 'svelte';
	import { VirtualListController } from './virtual-list.svelte';

	let {
		items = [],
		rowHeight = 48,
		overscan = 5,
		getKey,
		row,
		children = row,
		class: className = '',
		'data-slot': dataSlot = 'history-list',
		containerEl = $bindable(null)
	}: {
		items?: T[];
		rowHeight?: number;
		overscan?: number;
		getKey?: (item: T, index: number) => string | number;
		row?: Snippet<[item: T, index: number]>;
		children?: Snippet<[item: T, index: number]>;
		class?: string;
		'data-slot'?: string;
		containerEl?: HTMLElement | null;
	} = $props();

	const controller = new VirtualListController({
		itemCount: () => items.length,
		rowHeight: () => rowHeight,
		overscan: () => overscan
	});

	// Preserve scroll position across item updates / re-renders
	$effect(() => {
		items;
		if (containerEl && controller.lastScrollTop > 0) {
			if (containerEl.scrollTop !== controller.lastScrollTop) {
				containerEl.scrollTop = controller.lastScrollTop;
			}
		}
	});

	function onScroll(e: Event) {
		const target = e.currentTarget as HTMLElement;
		if (target) {
			controller.handleScroll(target.scrollTop);
		}
	}

	$effect(() => {
		const el = containerEl;
		if (!el) return;

		// Initial measurement
		if (el.clientHeight > 0) {
			controller.handleResize(el.clientHeight);
		}

		if (typeof ResizeObserver !== 'undefined') {
			const ro = new ResizeObserver((entries) => {
				for (const entry of entries) {
					const h = entry.contentRect.height || el.clientHeight;
					if (h > 0) {
						controller.handleResize(h);
					}
				}
			});
			ro.observe(el);
			return () => ro.disconnect();
		}
	});

	let visibleItems = $derived(items.slice(controller.startIndex, controller.endIndex));
</script>

<div
	bind:this={containerEl}
	onscroll={onScroll}
	class={className}
	data-slot={dataSlot}
>
	<div style="padding-top: {controller.topPadding}px; padding-bottom: {controller.bottomPadding}px; box-sizing: border-box;">
		{#each visibleItems as item, idx (getKey ? getKey(item, controller.startIndex + idx) : controller.startIndex + idx)}
			{#if children}
				{@render children(item, controller.startIndex + idx)}
			{/if}
		{/each}
	</div>
</div>
