<script lang="ts" generics="T">
	import type { Snippet } from 'svelte';
	import { untrack } from 'svelte';
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
		rowGroup = null,
		containerEl = $bindable(null)
	}: {
		items?: T[];
		/**
		 * The nominal height of a row, in pixels.
		 *
		 * The list measures the height the rows actually render at and
		 * uses that instead, so a row sized in rem (three rem, say) keeps
		 * the windowing right when the text size changes. This value is
		 * what the list uses until the first measurement lands.
		 */
		rowHeight?: number;
		overscan?: number;
		getKey?: (item: T, index: number) => string | number;
		row?: Snippet<[item: T, index: number]>;
		children?: Snippet<[item: T, index: number]>;
		class?: string;
		'data-slot'?: string;
		/**
		 * Wraps the rendered rows.
		 *
		 * Some chrome has to sit *around* the rows rather than inside each of
		 * them — a context menu shared by the whole list, for instance, which
		 * cannot have a trigger per row. The caller supplies that wrapper and
		 * is handed a snippet that renders the rows, so it never has to know
		 * how the windowing works.
		 */
		rowGroup?: Snippet<[Snippet]> | null;
		containerEl?: HTMLElement | null;
	} = $props();

	const controller = new VirtualListController({
		itemCount: () => items.length,
		rowHeight: () => measuredRowHeight ?? rowHeight,
		overscan: () => overscan
	});

	/** The element the rendered rows live in. */
	let rowsEl = $state<HTMLElement | null>(null);

	/**
	 * The height the rows actually render at, in pixels.
	 *
	 * The windowing needs a pixel height, and a row whose height comes from
	 * the text size (three rem, say) is only a fixed number of pixels at
	 * the text size the list happened to be built at. The rows are measured
	 * instead of trusted, so the window follows the text size when it
	 * changes. All the rows have to be the same height for the measurement
	 * to mean anything, which is the rule the list already worked under.
	 */
	let measuredRowHeight = $state<number | null>(null);
	let lastMeasuredHeight = 0;

	function measureRowHeight() {
		const el = rowsEl;
		if (!el) return;
		// The row count is read untracked: the effect that calls this must
		// not depend on the window, or the watch would be torn down and
		// rebuilt on every scroll.
		const count = untrack(() => rows.length);
		if (count === 0) return;
		const height = el.getBoundingClientRect().height / count;
		// A threshold keeps a fractional height from re-rendering the list
		// on every measurement.
		if (height > 0 && Math.abs(height - lastMeasuredHeight) > 0.5) {
			lastMeasuredHeight = height;
			measuredRowHeight = height;
		}
	}

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

	/**
	 * Watch the rendered rows for a change in height.
	 *
	 * The rows' wrapper is watched rather than a row, because the wrapper
	 * outlives the rows: a window that moves recycles the row elements, and
	 * a watch on a row would follow the recycling instead of the height.
	 * The wrapper's height only changes when the rows' height does, so the
	 * watch stays quiet while the list scrolls.
	 */
	$effect(() => {
		const el = rowsEl;
		if (!el) return;

		// Measure once up front, so the first frame is already right.
		measureRowHeight();

		if (typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(() => measureRowHeight());
		ro.observe(el);
		return () => ro.disconnect();
	});

	let rows = $derived(visibleRows(items, controller.startIndex, controller.endIndex, getKey));
</script>

<div
	bind:this={containerEl}
	onscroll={onScroll}
	class={className}
	data-slot={dataSlot}
>
	{#snippet renderRows()}
		{#each rows as row (row.key)}
			{#if children}
				{@render children(row.item, row.index)}
			{/if}
		{/each}
	{/snippet}

	<div style="padding-top: {controller.topPadding}px; padding-bottom: {controller.bottomPadding}px; box-sizing: border-box;">
		<div bind:this={rowsEl}>
			{#if rowGroup}
				{@render rowGroup(renderRows)}
			{:else}
				{@render renderRows()}
			{/if}
		</div>
	</div>
</div>
