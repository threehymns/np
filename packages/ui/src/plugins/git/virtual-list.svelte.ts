export type NumericOrGetter = number | (() => number);

export interface VirtualListOptions {
	itemCount?: NumericOrGetter;
	rowHeight?: NumericOrGetter;
	overscan?: NumericOrGetter;
	viewportHeight?: number;
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

	get startIndex(): number {
		const h = this.rowHeight;
		const count = this.itemCount;
		if (h <= 0 || count <= 0) return 0;
		const rawStart = Math.floor(this.scrollTop / h);
		return Math.max(0, rawStart - this.overscan);
	}

	get endIndex(): number {
		const h = this.rowHeight;
		const count = this.itemCount;
		if (h <= 0 || count <= 0) return 0;
		const effectiveViewport = this.viewportHeight > 0 ? this.viewportHeight : 600;
		const rawEnd = Math.ceil((this.scrollTop + effectiveViewport) / h);
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
