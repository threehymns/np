export type NumericOrGetter = number | (() => number);

export interface VirtualListOptions {
	itemCount?: NumericOrGetter;
	rowHeight?: NumericOrGetter;
	overscan?: NumericOrGetter;
	viewportHeight?: number;
}

export interface VirtualRow<T> {
	/** The item this row renders. */
	item: T;
	/** The row's absolute index in the full item list. */
	index: number;
	/**
	 * The key the row is rendered under.
	 *
	 * The key is what makes a row recyclable: a row whose key is unchanged
	 * when the window moves keeps its DOM node instead of being torn down and
	 * rebuilt, so scrolling reuses the rows that are still on screen.
	 */
	key: string | number;
}

/**
 * The rows a virtual list renders for one window of its items.
 *
 * The window is the half-open range `[startIndex, endIndex)` of the full
 * list, so the rows are a slice of the list and never the whole of it
 * unless the list is shorter than the window.
 *
 * The bounds are clamped to the list, so a window that runs past the end
 * (the list shrank, or the scroll offset was beyond the last row) yields
 * the rows that exist rather than rows for items that do not.
 */
export function visibleRows<T>(
	items: T[],
	startIndex: number,
	endIndex: number,
	getKey?: (item: T, index: number) => string | number
): VirtualRow<T>[] {
	const start = Math.max(0, Math.min(startIndex, items.length));
	const end = Math.max(start, Math.min(endIndex, items.length));
	const rows: VirtualRow<T>[] = [];
	for (let index = start; index < end; index++) {
		const item = items[index];
		rows.push({ item, index, key: getKey ? getKey(item, index) : index });
	}
	return rows;
}

function resolveNumeric(val: NumericOrGetter | undefined, fallback: number): number {
	if (val === undefined) return fallback;
	return typeof val === 'function' ? val() : val;
}

/**
 * Controller managing fixed-height windowed virtualization math,
 * visible range slices, and scroll/resize synchronization.
 */
export class VirtualListController {
	private _itemCount: NumericOrGetter;
	private _rowHeight: NumericOrGetter;
	private _overscan: NumericOrGetter;
	scrollTop = $state(0);
	viewportHeight = $state(600);
	lastScrollTop = 0;

	constructor(options?: VirtualListOptions) {
		this._itemCount = options?.itemCount ?? 0;
		this._rowHeight = options?.rowHeight ?? 48;
		this._overscan = options?.overscan ?? 5;
		if (options?.viewportHeight !== undefined) this.viewportHeight = options.viewportHeight;
	}

	get itemCount(): number {
		return resolveNumeric(this._itemCount, 0);
	}

	set itemCount(val: NumericOrGetter) {
		this._itemCount = val;
	}

	get rowHeight(): number {
		return resolveNumeric(this._rowHeight, 48);
	}

	set rowHeight(val: NumericOrGetter) {
		this._rowHeight = val;
	}

	get overscan(): number {
		return resolveNumeric(this._overscan, 5);
	}

	set overscan(val: NumericOrGetter) {
		this._overscan = val;
	}

	get totalHeight(): number {
		return this.itemCount * this.rowHeight;
	}

	/**
	 * The scroll offset actually used for window math, clamped to the
	 * list's maximum scrollable position. `scrollTop` can go stale when
	 * the list shrinks (e.g. a refresh returns fewer commits): without
	 * the clamp, `startIndex` runs past the end of the list and the
	 * window renders nothing with a huge top padding until a scroll
	 * event corrects it.
	 */
	get effectiveScrollTop(): number {
		const maxScroll = Math.max(0, this.totalHeight - this.viewportHeight);
		return Math.min(Math.max(0, this.scrollTop), maxScroll);
	}

	get startIndex(): number {
		const h = this.rowHeight;
		const count = this.itemCount;
		if (h <= 0 || count <= 0) return 0;
		const rawStart = Math.floor(this.effectiveScrollTop / h);
		return Math.max(0, rawStart - this.overscan);
	}

	get endIndex(): number {
		const h = this.rowHeight;
		const count = this.itemCount;
		if (h <= 0 || count <= 0) return 0;
		const effectiveViewport = this.viewportHeight > 0 ? this.viewportHeight : 600;
		const rawEnd = Math.ceil((this.effectiveScrollTop + effectiveViewport) / h);
		return Math.min(count, rawEnd + this.overscan);
	}

	get topPadding(): number {
		return this.startIndex * this.rowHeight;
	}

	get bottomPadding(): number {
		return Math.max(0, (this.itemCount - this.endIndex) * this.rowHeight);
	}

	get visibleCount(): number {
		return Math.max(0, this.endIndex - this.startIndex);
	}

	handleScroll(newScrollTop: number): void {
		this.scrollTop = Math.max(0, newScrollTop);
		this.lastScrollTop = this.scrollTop;
	}

	handleResize(newHeight: number): void {
		if (newHeight > 0) {
			this.viewportHeight = newHeight;
		}
	}

	updateItemCount(count: number): void {
		this._itemCount = count;
	}
}
