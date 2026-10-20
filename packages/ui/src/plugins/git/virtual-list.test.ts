import "../../../../../tests/contract/rune-setup";
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { VirtualListController, visibleRows } from "./virtual-list.svelte";

interface Commit {
	sha: string;
	subject: string;
}

const commits = (count: number): Commit[] =>
	Array.from({ length: count }, (_, i) => ({
		sha: `sha${String(i).padStart(5, "0")}`,
		subject: `commit ${i}`
	}));

const ROW_HEIGHT = 48;
const VIEWPORT_HEIGHT = 600;
const OVERSCAN = 5;
/**
 * The most rows a window can hold: a viewport's worth of rows plus the
 * overscan on each side. The number of items in the list does not enter
 * into it, which is the whole point of virtualising.
 */
const MAX_ROWS = Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + 2 * OVERSCAN;

const controllerFor = (itemCount: number) =>
	new VirtualListController({
		itemCount,
		rowHeight: ROW_HEIGHT,
		viewportHeight: VIEWPORT_HEIGHT,
		overscan: OVERSCAN
	});

const bySha = (commit: Commit) => commit.sha;

describe("VirtualList windowing", () => {
	it("renders a window of the items rather than all of them", () => {
		const items = commits(10_000);
		const controller = controllerFor(items.length);

		const rows = visibleRows(items, controller.startIndex, controller.endIndex, bySha);

		// A window, not the list: 10,000 items, a couple of dozen rows.
		expect(rows.length).toBeLessThan(items.length);
		expect(rows.length).toBeLessThanOrEqual(MAX_ROWS);

		// The window is the head of the list, in order, one row per item.
		expect(rows[0].index).toBe(0);
		expect(rows[rows.length - 1].index).toBe(rows.length - 1);
		expect(rows.map((row) => row.item)).toEqual(items.slice(0, rows.length));
	});

	it("keeps the row count bounded by the viewport, not by the number of items", () => {
		const short = commits(10);
		const long = commits(10_000);

		const shortController = controllerFor(short.length);
		const longController = controllerFor(long.length);
		const shortRows = visibleRows(short, shortController.startIndex, shortController.endIndex, bySha);
		const longRows = visibleRows(long, longController.startIndex, longController.endIndex, bySha);

		// A list shorter than the viewport renders every item; a list that
		// does not renders no more rows than the window holds.
		expect(shortRows.length).toBe(10);
		expect(longRows.length).toBeLessThanOrEqual(MAX_ROWS);
	});

	it("recycles the rows that stay in the window as the window moves", () => {
		const items = commits(10_000);
		const controller = controllerFor(items.length);
		// A key that reads the index, so a row that keeps its key keeps
		// showing the item it was showing.
		const keyOf = (commit: Commit, index: number) => `${index}:${commit.sha}`;

		const before = visibleRows(items, controller.startIndex, controller.endIndex, keyOf);
		// Scroll by one row: the window slides by one and every other row
		// stays on screen.
		controller.handleScroll(ROW_HEIGHT);
		const after = visibleRows(items, controller.startIndex, controller.endIndex, keyOf);

		// The window moved: the last row of the old window is no longer the last.
		expect(after[after.length - 1].index).toBe(before[before.length - 1].index + 1);

		// The key of every row that is still on screen is unchanged, so the
		// keyed list reuses that row's DOM node instead of tearing it down
		// and building a new one.
		const keyBefore = new Map(before.map((row) => [row.index, row.key]));
		const stillVisible = after.filter((row) => keyBefore.has(row.index));
		expect(stillVisible.length).toBeGreaterThan(0);
		for (const row of stillVisible) {
			expect(row.key).toBe(keyBefore.get(row.index));
		}

		// A key names one row, so no two rows in the window share one.
		expect(new Set(after.map((row) => row.key)).size).toBe(after.length);

		// Scrolling does not accumulate rows: the window stays a window.
		expect(after.length).toBeLessThanOrEqual(MAX_ROWS);
	});

	it("keys a row by its absolute index in the list, not its position in the window", () => {
		const items = commits(100);
		const seen: Array<{ item: Commit; index: number }> = [];

		visibleRows(items, 40, 50, (commit, index) => {
			seen.push({ item: commit, index });
			return commit.sha;
		});

		expect(seen[0]).toEqual({ item: items[40], index: 40 });
		expect(seen[9]).toEqual({ item: items[49], index: 49 });
	});

	it("clamps the window at the end of the list", () => {
		const items = commits(10_000);
		const controller = controllerFor(items.length);

		// Scroll past the last row.
		controller.handleScroll(ROW_HEIGHT * items.length);

		const rows = visibleRows(items, controller.startIndex, controller.endIndex, bySha);
		expect(controller.endIndex).toBe(items.length);
		expect(controller.bottomPadding).toBe(0);
		expect(rows[rows.length - 1].index).toBe(items.length - 1);
		expect(rows[rows.length - 1].item).toEqual(items[items.length - 1]);
	});

	it("clamps a window that runs past the end of the list", () => {
		const items = commits(10);

		const rows = visibleRows(items, 8, 50, bySha);

		expect(rows.map((row) => row.index)).toEqual([8, 9]);
		expect(rows.map((row) => row.item)).toEqual([items[8], items[9]]);
	});

	it("renders nothing for a window that lies entirely past the end of the list", () => {
		const items = commits(10);

		// The list can shrink under a scroll offset that was measured
		// against the longer list.
		expect(visibleRows(items, 50, 60, bySha)).toEqual([]);
	});

	it("renders nothing for an empty list", () => {
		expect(visibleRows([], 0, 0, bySha)).toEqual([]);
	});

	it("falls back to the absolute index when no key function is given", () => {
		const items = commits(100);
		const rows = visibleRows(items, 10, 20);

		expect(rows.map((row) => row.key)).toEqual(rows.map((row) => row.index));
		expect(rows[0].key).toBe(10);
	});

	it("is the function the component renders its rows with", () => {
		const source = readFileSync(resolve(__dirname, "./VirtualList.svelte"), "utf-8");

		// The component renders the rows this module produces, keyed by the
		// row key, so the windowing the tests pin is the windowing on screen.
		expect(source).toContain(
			"visibleRows(items, controller.startIndex, controller.endIndex, getKey)"
		);
		expect(source).toContain("{#each rows as row (row.key)}");
		expect(source).toContain("{@render children(row.item, row.index)}");
	});

	it("clamps the window when the list shrinks below the scroll position", () => {
		const controller = controllerFor(200);
		// Scrolled to the bottom of the long list.
		controller.handleScroll(200 * ROW_HEIGHT - VIEWPORT_HEIGHT);

		// A refresh returns far fewer items; the recorded scroll offset is
		// now beyond the last row.
		controller.updateItemCount(50);

		// The window must cover the tail of the short list, not an empty
		// range past its end.
		expect(controller.startIndex).toBeLessThan(50);
		expect(controller.endIndex).toBe(50);
		const rows = visibleRows(commits(50), controller.startIndex, controller.endIndex, bySha);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows[rows.length - 1].index).toBe(49);
	});

	it("keeps top padding within the list when the scroll offset is stale", () => {
		const controller = controllerFor(200);
		controller.handleScroll(200 * ROW_HEIGHT - VIEWPORT_HEIGHT);
		controller.updateItemCount(50);

		expect(controller.topPadding).toBeLessThanOrEqual(50 * ROW_HEIGHT);
	});
});
