import { describe, it, expect } from "bun:test";
import { Text } from "@codemirror/state";
import { countDiffStats, resolveDiscardOptions, getUnifiedHunks, type GitChange } from "./vcs";

describe("countDiffStats", () => {
	it("returns zero counts for empty input", () => {
		expect(countDiffStats("")).toEqual({ additions: 0, deletions: 0 });
	});

	it("returns zero counts for header-only diffs", () => {
		const diff = [
			"diff --git a/a.txt b/a.txt",
			"index de98044..53fd399 100644",
			"--- a/a.txt",
			"+++ b/a.txt"
		].join("\n");
		expect(countDiffStats(diff)).toEqual({ additions: 0, deletions: 0 });
	});

	it("counts added and deleted lines inside hunks", () => {
		const diff = [
			"diff --git a/f.txt b/f.txt",
			"index de98044..53fd399 100644",
			"--- a/f.txt",
			"+++ b/f.txt",
			"@@ -1,3 +1,5 @@",
			" a",
			"+b",
			"-c",
			" d"
		].join("\n");
		expect(countDiffStats(diff)).toEqual({ additions: 1, deletions: 1 });
	});

	it("counts added and deleted lines whose content begins with + or - (++x / --x)", () => {
		const diff = [
			"diff --git a/f.txt b/f.txt",
			"index de98044..53fd399 100644",
			"--- a/f.txt",
			"+++ b/f.txt",
			"@@ -1,3 +1,5 @@",
			" a",
			"+++added",
			" b",
			"+--gone",
			" c"
		].join("\n");
		expect(countDiffStats(diff)).toEqual({ additions: 2, deletions: 0 });
	});

	it("ignores the no-newline marker inside hunks", () => {
		const diff = [
			"diff --git a/f.txt b/f.txt",
			"index de98044..53fd399 100644",
			"--- a/f.txt",
			"+++ b/f.txt",
			"@@ -1 +1 @@",
			"-old",
			"\\ No newline at end of file",
			"+new",
			"\\ No newline at end of file"
		].join("\n");
		expect(countDiffStats(diff)).toEqual({ additions: 1, deletions: 1 });
	});

	it("tracks hunks independently across multiple files", () => {
		const diff = [
			"diff --git a/f.txt b/f.txt",
			"index de98044..53fd399 100644",
			"--- a/f.txt",
			"+++ b/f.txt",
			"@@ -1,3 +1,5 @@",
			" a",
			"+x",
			"diff --git a/g.txt b/g.txt",
			"index 04ec35a..72c29dd 100644",
			"--- a/g.txt",
			"+++ b/g.txt",
			"@@ -1,3 +1,3 @@",
			" x",
			"-y",
			"+y2",
			" z"
		].join("\n");
		expect(countDiffStats(diff)).toEqual({ additions: 2, deletions: 1 });
	});

	it("counts changes that follow context lines within the same hunk", () => {
		const diff = [
			"@@ -1,3 +1,3 @@",
			" a",
			"-b",
			"+B",
			" c",
			"-d",
			"+D"
		].join("\n");
		expect(countDiffStats(diff)).toEqual({ additions: 2, deletions: 2 });
	});

	it("counts changes that follow empty context lines without leading space within a hunk", () => {
		const diff = [
			"@@ -1,5 +1,5 @@",
			" context",
			"",
			"+added_line",
			"-deleted_line",
			" context"
		].join("\n");
		expect(countDiffStats(diff)).toEqual({ additions: 1, deletions: 1 });
	});
});

describe("getUnifiedHunks", () => {
	// Eight 2-char lines; line N starts at offset (N-1) * 3.
	const HEAD_LINES = ["aa", "bb", "cc", "dd", "ee", "ff", "gg", "hh"];
	const origText = Text.of(HEAD_LINES);

	function replaceLine(lines: string[], lineNumber: number, replacement: string): string[] {
		const next = [...lines];
		next[lineNumber - 1] = replacement;
		return next;
	}

	function startLines(text: Text, hunks: { fromB: number }[]): number[] {
		return hunks.map((h) => text.lineAt(h.fromB).number);
	}

	it("returns contiguous changed chunks as distinct hunks", () => {
		// Line 4 and line 6 are edited with line 5 unchanged.
		// Each contiguous edit is its own independent hunk.
		const mod = Text.of(replaceLine(replaceLine(HEAD_LINES, 4, "DD-edit"), 6, "FF-edit"));

		const hunks = getUnifiedHunks(origText, mod);

		expect(hunks).toHaveLength(2);
		expect(startLines(mod, hunks)).toEqual([4, 6]);
	});

	it("returns a single hunk for contiguous multiline edits", () => {
		// Lines 4 and 5 are edited contiguously.
		const mod = Text.of(replaceLine(replaceLine(HEAD_LINES, 4, "DD-edit"), 5, "EE-edit"));

		const hunks = getUnifiedHunks(origText, mod);

		expect(hunks).toHaveLength(1);
		expect(startLines(mod, hunks)).toEqual([4]);
	});
});

describe("resolveDiscardOptions", () => {
	it("returns fallback staged state when changes list is empty or undefined", () => {
		expect(resolveDiscardOptions("foo.ts", false, undefined)).toEqual({ staged: false });
		expect(resolveDiscardOptions("foo.ts", true, undefined)).toEqual({ staged: true });
		expect(resolveDiscardOptions("foo.ts", false, [])).toEqual({ staged: false });
		expect(resolveDiscardOptions("foo.ts", true, [])).toEqual({ staged: true });
	});

	it("returns staged: true for target with only staged changes regardless of context", () => {
		const changes: GitChange[] = [
			{ filepath: "staged-only.ts", status: "M", additions: 1, deletions: 0, diff: "", staged: true }
		];
		expect(resolveDiscardOptions("staged-only.ts", false, changes)).toEqual({ staged: true });
		expect(resolveDiscardOptions("staged-only.ts", true, changes)).toEqual({ staged: true });
	});

	it("returns staged: false for target with only unstaged changes regardless of context", () => {
		const changes: GitChange[] = [
			{ filepath: "unstaged-only.ts", status: "M", additions: 1, deletions: 0, diff: "", staged: false }
		];
		expect(resolveDiscardOptions("unstaged-only.ts", true, changes)).toEqual({ staged: false });
		expect(resolveDiscardOptions("unstaged-only.ts", false, changes)).toEqual({ staged: false });
	});

	it("returns context staging state when target has both staged and unstaged changes", () => {
		const changes: GitChange[] = [
			{ filepath: "both.ts", status: "M", additions: 1, deletions: 0, diff: "", staged: true },
			{ filepath: "both.ts", status: "M", additions: 2, deletions: 1, diff: "", staged: false }
		];
		expect(resolveDiscardOptions("both.ts", true, changes)).toEqual({ staged: true });
		expect(resolveDiscardOptions("both.ts", false, changes)).toEqual({ staged: false });
	});

	it("returns context staging state when target is not present in changes list", () => {
		const changes: GitChange[] = [
			{ filepath: "other.ts", status: "M", additions: 1, deletions: 0, diff: "", staged: true }
		];
		expect(resolveDiscardOptions("missing.ts", true, changes)).toEqual({ staged: true });
		expect(resolveDiscardOptions("missing.ts", false, changes)).toEqual({ staged: false });
	});

	it("resolves multi-file selections with mixed staging states correctly in staged context", () => {
		const changes: GitChange[] = [
			{ filepath: "staged-only.ts", status: "M", additions: 1, deletions: 0, diff: "", staged: true },
			{ filepath: "unstaged-only.ts", status: "M", additions: 1, deletions: 0, diff: "", staged: false },
			{ filepath: "both.ts", status: "M", additions: 1, deletions: 0, diff: "", staged: true },
			{ filepath: "both.ts", status: "M", additions: 2, deletions: 1, diff: "", staged: false }
		];
		const targets = ["staged-only.ts", "unstaged-only.ts", "both.ts"];
		const resolved = targets.map(t => ({
			path: t,
			options: resolveDiscardOptions(t, true, changes)
		}));

		expect(resolved).toEqual([
			{ path: "staged-only.ts", options: { staged: true } },
			{ path: "unstaged-only.ts", options: { staged: false } },
			{ path: "both.ts", options: { staged: true } }
		]);
	});

	it("resolves multi-file selections with mixed staging states correctly in unstaged context", () => {
		const changes: GitChange[] = [
			{ filepath: "staged-only.ts", status: "M", additions: 1, deletions: 0, diff: "", staged: true },
			{ filepath: "unstaged-only.ts", status: "M", additions: 1, deletions: 0, diff: "", staged: false },
			{ filepath: "both.ts", status: "M", additions: 1, deletions: 0, diff: "", staged: true },
			{ filepath: "both.ts", status: "M", additions: 2, deletions: 1, diff: "", staged: false }
		];
		const targets = ["staged-only.ts", "unstaged-only.ts", "both.ts"];
		const resolved = targets.map(t => ({
			path: t,
			options: resolveDiscardOptions(t, false, changes)
		}));

		expect(resolved).toEqual([
			{ path: "staged-only.ts", options: { staged: true } },
			{ path: "unstaged-only.ts", options: { staged: false } },
			{ path: "both.ts", options: { staged: false } }
		]);
	});
});



