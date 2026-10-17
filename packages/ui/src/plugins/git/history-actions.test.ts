import "../../../../../tests/contract/rune-setup";
import { describe, it, expect, mock } from "bun:test";
import type { GitHistoryCommit } from "@np/core";
import type { ClipboardService } from "@np/core/state.svelte";
import { runHistoryAction, handleHistoryKeyDown } from "./history-actions";

describe("History Actions (Ticket #347)", () => {
	const sampleCommit: GitHistoryCommit = {
		sha: "0123456789abcdef0123456789abcdef01234567",
		shortSha: "0123456",
		subject: "feat: initial commit",
		author: "Alice <alice@example.com>",
		timestamp: 1700000000
	};

	describe("Slice 1: Row click copies short SHA to clipboard", () => {
		it("writes short SHA to clipboardService when copyShortSha action is run", async () => {
			const writeText = mock(async (_text: string) => {});
			const clipboard: ClipboardService = { writeText };

			const result = await runHistoryAction("copyShortSha", sampleCommit, clipboard);

			expect(result).toBe(true);
			expect(writeText).toHaveBeenCalledTimes(1);
			expect(writeText).toHaveBeenCalledWith("0123456");
		});

		it("returns false and does not call clipboard when shortSha is missing", async () => {
			const writeText = mock(async (_text: string) => {});
			const clipboard: ClipboardService = { writeText };
			const commitWithoutShortSha = { ...sampleCommit, shortSha: "" };

			const result = await runHistoryAction("copyShortSha", commitWithoutShortSha, clipboard);

			expect(result).toBe(false);
			expect(writeText).not.toHaveBeenCalled();
		});

		it("returns false without throwing when clipboard writeText rejects", async () => {
			const writeText = mock(async (_text: string) => {
				throw new Error("Clipboard permission denied");
			});
			const clipboard: ClipboardService = { writeText };

			const result = await runHistoryAction("copyShortSha", sampleCommit, clipboard);

			expect(result).toBe(false);
			expect(writeText).toHaveBeenCalledTimes(1);
		});
	});

	describe("Slice 2: Context menu Copy SHA copies full hash", () => {
		it("writes full 40-char SHA to clipboardService when copySha action is run", async () => {
			const writeText = mock(async (_text: string) => {});
			const clipboard: ClipboardService = { writeText };

			const result = await runHistoryAction("copySha", sampleCommit, clipboard);

			expect(result).toBe(true);
			expect(writeText).toHaveBeenCalledTimes(1);
			expect(writeText).toHaveBeenCalledWith("0123456789abcdef0123456789abcdef01234567");
		});

		it("returns false and does not call clipboard when sha is missing", async () => {
			const writeText = mock(async (_text: string) => {});
			const clipboard: ClipboardService = { writeText };
			const commitWithoutSha = { ...sampleCommit, sha: "" };

			const result = await runHistoryAction("copySha", commitWithoutSha, clipboard);

			expect(result).toBe(false);
			expect(writeText).not.toHaveBeenCalled();
		});
	});

	describe("Slice 3: Context menu Copy subject copies commit subject", () => {
		it("writes subject to clipboardService when copySubject action is run", async () => {
			const writeText = mock(async (_text: string) => {});
			const clipboard: ClipboardService = { writeText };

			const result = await runHistoryAction("copySubject", sampleCommit, clipboard);

			expect(result).toBe(true);
			expect(writeText).toHaveBeenCalledTimes(1);
			expect(writeText).toHaveBeenCalledWith("feat: initial commit");
		});

		it("writes empty string to clipboard when commit subject is empty", async () => {
			const writeText = mock(async (_text: string) => {});
			const clipboard: ClipboardService = { writeText };
			const commitWithEmptySubject = { ...sampleCommit, subject: "" };

			const result = await runHistoryAction("copySubject", commitWithEmptySubject, clipboard);

			expect(result).toBe(true);
			expect(writeText).toHaveBeenCalledTimes(1);
			expect(writeText).toHaveBeenCalledWith("");
		});
	});

	describe("Slice 4: Double-click / Enter are reserved no-ops", () => {
		it("intercepts Enter key and prevents default without triggering any action", () => {
			const preventDefault = mock(() => {});
			const stopPropagation = mock(() => {});
			const enterEvent = {
				key: "Enter",
				preventDefault,
				stopPropagation
			} as unknown as KeyboardEvent;

			const handled = handleHistoryKeyDown(enterEvent);

			expect(handled).toBe(true);
			expect(preventDefault).toHaveBeenCalledTimes(1);
		});

		it("ignores non-Enter keys and leaves them unprevented", () => {
			const preventDefault = mock(() => {});
			const spaceEvent = {
				key: " ",
				preventDefault
			} as unknown as KeyboardEvent;

			const handled = handleHistoryKeyDown(spaceEvent);

			expect(handled).toBe(false);
			expect(preventDefault).not.toHaveBeenCalled();
		});
	});
});
