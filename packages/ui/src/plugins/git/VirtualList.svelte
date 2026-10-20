<script lang="ts" generics="T">
	import type { Snippet } from 'svelte';
	import { VirtualListController, visibleRows } from './virtual-list.svelte';

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

	// Preserve scroll position across item updates / re-renders.
	// The restore target is clamped to the list's current maximum scroll
	// position: if the list shrank since the position was recorded,
	// restoring the raw value would ask for an impossible offset.
	$effect(() => {
		items;
		if (containerEl && controller.lastScrollTop > 0) {
			const maxScroll = Math.max(0, controller.totalHeight - controller.viewportHeight);
			const target = Math.min(controller.lastScrollTop, maxScroll);
			if (containerEl.scrollTop !== target) {
				containerEl.scrollTop = target;
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

	let rows = $derived(visibleRows(items, controller.startIndex, controller.endIndex, getKey));
</script>

<div
	bind:this={containerEl}
	onscroll={onScroll}
	class={className}
	data-slot={dataSlot}
>
	<div style="padding-top: {controller.topPadding}px; padding-bottom: {controller.bottomPadding}px; box-sizing: border-box;">
		{#each rows as row (row.key)}
			{#if children}
				{@render children(row.item, row.index)}
			{/if}
		{/each}
	</div>
</div>
