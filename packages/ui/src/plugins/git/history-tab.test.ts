import "../../../../../tests/contract/rune-setup";
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatRelativeTime } from "@np/core/utils";
import type { GitHistoryCommit } from "@np/core";

describe("HistoryTab Component & GitPanel Peer Tab (Ticket #345)", () => {
	const historyTabSource = () => {
		const filePath = resolve(__dirname, "./HistoryTab.svelte");
		return readFileSync(filePath, "utf-8");
	};

	const gitPanelSource = () => {
		const filePath = resolve(__dirname, "./GitPanel.svelte");
		return readFileSync(filePath, "utf-8");
	};

	describe("1. HistoryTab.svelte template & contract audit", () => {
		it("exists and defines props for commits and loading state", () => {
			const source = historyTabSource();
			expect(source).toContain("commits");
			expect(source).toContain("GitHistoryCommit");
		});

		it("displays a clear empty state when there are no commits", () => {
			const source = historyTabSource();
			expect(source).toContain("commits.length === 0");
			// Empty state must indicate no commits clearly
			expect(source.toLowerCase()).toContain("no commit");
		});

		it("renders commit rows showing subject, author, relative timestamp, and short SHA", () => {
			const source = historyTabSource();
			expect(source).toContain("commit.subject");
			expect(source).toContain("commit.author");
			expect(source).toContain("commit.shortSha");
			expect(source).toContain("formatRelativeTime");
		});
	});

	describe("2. GitPanel.svelte peer tab integration", () => {
		it("contains peer tabs for Changes and History", () => {
			const source = gitPanelSource();
			expect(source).toContain("Changes");
			expect(source).toContain("History");
			expect(source).toContain("activeTab");
		});

		it("swaps the panel body when activeTab changes while preserving DOM state", () => {
			const source = gitPanelSource();
			// Both bodies must exist and conditionally hide/show to preserve DOM and scroll state
			expect(source).toContain("HistoryTab");
			expect(source).toMatch(/activeTab\s*===?\s*['"]changes['"]/);
			expect(source).toMatch(/activeTab\s*===?\s*['"]history['"]/);
		});

		it("prefetches history when repository is refreshed on mount", () => {
			const source = gitPanelSource();
			expect(source).toContain("repo.refresh()");
		});
	});

	describe("3. Relative timestamp formatting", () => {
		it("formats timestamps relative to now", () => {
			const now = 1700000000;
			expect(formatRelativeTime(now - 10, now * 1000)).toBe("just now");
			expect(formatRelativeTime(now - 120, now * 1000)).toBe("2 minutes ago");
			expect(formatRelativeTime(now - 7200, now * 1000)).toBe("2 hours ago");
			expect(formatRelativeTime(now - 86400 * 3, now * 1000)).toBe("3 days ago");
		});
	});

	describe("4. Ticket #346: Tag chips and unpushed indicator contract", () => {
		it("uses parseRefTags to parse tags from refDecoration without showing branch names", () => {
			const source = historyTabSource();
			expect(source).toContain("parseRefTags");
			expect(source).toContain("refDecoration");
		});

		it("renders up to 3 tag chips and an overflow chip when > 3 tags exist", () => {
			const source = historyTabSource();
			expect(source).toContain("slice(0, 3)");
			expect(source).toMatch(/\+\s*\{\s*tags\.length\s*-\s*3\s*\}/);
			expect(source).toContain("data-slot=\"history-tag-chip\"");
			expect(source).toContain("data-slot=\"history-tag-overflow\"");
		});

		it("renders unpushed arrow icon only when commit is ahead of upstream", () => {
			const source = historyTabSource();
			expect(source).toContain("ArrowUp");
			expect(source).toContain("isAhead");
			expect(source).toContain("data-slot=\"history-unpushed-indicator\"");
		});

		it("maintains strictly newest-first commit ordering without grouping unpushed commits", () => {
			const source = historyTabSource();
			// Ordering comes from the commits array as passed to the virtual list (#348);
			// the list must not partition or regroup unpushed commits.
			expect(source).toContain("items={commits}");
			expect(source).not.toContain("unpushedCommits");
			expect(source).not.toContain("groupBy");
		});
	});

	describe("5. HistoryTab click-to-copy & context menu contract (Ticket #347)", () => {
		it("wires row click to copy short SHA to clipboard", () => {
			const source = historyTabSource();
			expect(source).toContain("onclick=");
			expect(source).toMatch(/copyShortSha|handleRowClick/);
		});

		it("wraps commit rows in ContextMenu with Copy SHA and Copy subject items", () => {
			const source = historyTabSource();
			expect(source).toContain("ContextMenu.Root");
			expect(source).toContain("ContextMenu.Trigger");
			expect(source).toContain("ContextMenu.Content");
			expect(source).toContain("ContextMenu.Item");
			expect(source).toContain("Copy SHA");
			expect(source).toContain("Copy subject");
			expect(source).toMatch(/copySha/);
			expect(source).toMatch(/copySubject/);
		});

		it("reserves double-click and Enter as no-ops for v2 detail view", () => {
			const source = historyTabSource();
			expect(source).toContain("ondblclick=");
			expect(source).toContain("onkeydown=");
			expect(source).toMatch(/handleHistoryKeyDown|handleKeyDown/);
		});

		it("provides visual confirmation or title feedback upon copying", () => {
			const source = historyTabSource();
			expect(source).toMatch(/copied|Copied/);
		});
	});

	describe("5. Virtualized list & windowing behavior (Ticket #348)", () => {
		const virtualListSource = () => {
			const filePath = resolve(__dirname, "./VirtualList.svelte");
			return readFileSync(filePath, "utf-8");
		};

		it("HistoryTab.svelte delegates rendering to VirtualList rather than an unbounded each", () => {
			const source = historyTabSource();
			expect(source).toContain("VirtualList");
			expect(source).not.toContain("{#each commits as commit (commit.sha)}");
			expect(source).toContain('data-slot="history-list"');
			expect(source).toContain('role="button"');
		});

		it("VirtualList renders only visible rows plus overscan for 10k items", async () => {
			const { VirtualListController } = await import("./virtual-list.svelte");
			const controller = new VirtualListController({
				itemCount: 10000,
				rowHeight: 48,
				viewportHeight: 600,
				overscan: 5
			});

			expect(controller.totalHeight).toBe(480000);
			// At scrollTop = 0: 0 to ceil(600/48) = 13 + 5 overscan = 18 items
			expect(controller.startIndex).toBe(0);
			expect(controller.endIndex).toBe(18);
			expect(controller.visibleCount).toBe(18);
			expect(controller.topPadding).toBe(0);
			expect(controller.bottomPadding).toBe((10000 - 18) * 48);
			expect(controller.topPadding + controller.visibleCount * 48 + controller.bottomPadding).toBe(480000);
		});

		it("slides visible window and updates spacers when scrolled", async () => {
			const { VirtualListController } = await import("./virtual-list.svelte");
			const controller = new VirtualListController({
				itemCount: 10000,
				rowHeight: 48,
				viewportHeight: 600,
				overscan: 5
			});

			// Scroll down to 2400px (item index 50)
			controller.handleScroll(2400);

			expect(controller.scrollTop).toBe(2400);
			expect(controller.startIndex).toBe(45); // 50 - 5 overscan
			expect(controller.endIndex).toBe(68); // ceil((2400+600)/48) + 5 = 63 + 5
			expect(controller.visibleCount).toBe(23);
			expect(controller.topPadding).toBe(45 * 48);
			expect(controller.bottomPadding).toBe((10000 - 68) * 48);
			expect(controller.topPadding + controller.visibleCount * 48 + controller.bottomPadding).toBe(480000);
		});

		it("adjusts visible range dynamically upon container resize", async () => {
			const { VirtualListController } = await import("./virtual-list.svelte");
			const controller = new VirtualListController({
				itemCount: 10000,
				rowHeight: 48,
				viewportHeight: 600,
				overscan: 5
			});

			controller.handleScroll(2400);
			expect(controller.endIndex).toBe(68);

			// Viewport grows from 600px to 1000px
			controller.handleResize(1000);
			expect(controller.viewportHeight).toBe(1000);
			// ceil((2400 + 1000) / 48) + 5 = ceil(70.83) + 5 = 71 + 5 = 76
			expect(controller.endIndex).toBe(76);
			expect(controller.visibleCount).toBe(31);
		});

		it("preserves scroll position across re-renders and item count changes", async () => {
			const { VirtualListController } = await import("./virtual-list.svelte");
			const controller = new VirtualListController({
				itemCount: 10000,
				rowHeight: 48,
				viewportHeight: 600,
				overscan: 5
			});

			controller.handleScroll(2400);
			expect(controller.lastScrollTop).toBe(2400);

			// New commits arrive, updating item count
			controller.updateItemCount(10005);
			expect(controller.lastScrollTop).toBe(2400);
			expect(controller.scrollTop).toBe(2400);
			expect(controller.totalHeight).toBe(10005 * 48);
		});

		it("handles zero items without errors or negative heights", async () => {
			const { VirtualListController } = await import("./virtual-list.svelte");
			const controller = new VirtualListController({
				itemCount: 0,
				rowHeight: 48,
				viewportHeight: 600,
				overscan: 5
			});

			expect(controller.totalHeight).toBe(0);
			expect(controller.startIndex).toBe(0);
			expect(controller.endIndex).toBe(0);
			expect(controller.visibleCount).toBe(0);
			expect(controller.topPadding).toBe(0);
			expect(controller.bottomPadding).toBe(0);
		});
	});
});


