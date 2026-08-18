import { describe, it, expect } from "bun:test";
import { resolveDiscardOptions, type GitChange } from "./vcs";

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



