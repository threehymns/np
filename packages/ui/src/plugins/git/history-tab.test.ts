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

	describe("4. HistoryTab click-to-copy & context menu contract (Ticket #347)", () => {
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
});
