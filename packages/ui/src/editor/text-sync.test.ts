import { describe, it, expect } from "bun:test";
import { EditorState, Transaction } from "@codemirror/state";
import { history, historyField } from "@codemirror/commands";
import { minimalTextChange } from "./text-sync";

function apply(prev: string, change: { from: number; to: number; insert: string }): string {
	return prev.slice(0, change.from) + change.insert + prev.slice(change.to);
}

describe("minimalTextChange (#271 independent undo)", () => {
	it("returns null for equal texts", () => {
		expect(minimalTextChange("abc", "abc")).toBeNull();
		expect(minimalTextChange("", "")).toBeNull();
	});

	it("shrinks a single keystroke to a point insertion", () => {
		expect(minimalTextChange("hello", "hellXo")).toEqual({ from: 4, to: 4, insert: "X" });
	});

	it("shrinks an append, a delete, and a middle replace", () => {
		expect(minimalTextChange("ab", "abc")).toEqual({ from: 2, to: 2, insert: "c" });
		expect(minimalTextChange("abc", "ac")).toEqual({ from: 1, to: 2, insert: "" });
		expect(minimalTextChange("axc", "ayc")).toEqual({ from: 1, to: 2, insert: "y" });
	});

	it("round-trips through apply for insertions, deletions, and rewrites", () => {
		const cases: Array<[string, string]> = [
			["", "new file content\n"],
			["old", ""],
			["line1\nline2\n", "line1 edited\nline2\n"],
			["line1\nline2\nline3\n", "line1\nline3\n"],
			["abc", "xyz"],
			["aaaa", "aa"],
			["hello world", ">>hello world!"]
		];
		for (const [prev, next] of cases) {
			const change = minimalTextChange(prev, next);
			expect(change).not.toBeNull();
			expect(apply(prev, change!)).toBe(next);
		}
	});

	it("falls back to a full replacement with no common affix", () => {
		expect(minimalTextChange("abc", "xyz")).toEqual({ from: 0, to: 3, insert: "xyz" });
	});

	it("keeps the receiving view's undo history across an external sync", () => {
		let pane = EditorState.create({ doc: "hello", extensions: [history()] });
		pane = pane.update({ changes: { from: 5, to: 5, insert: "!" } }).state;
		expect(pane.field(historyField).done.length).toBe(1);

		// Tab typed ">>" at the top; sync the minimal hunk out-of-history.
		const change = minimalTextChange(pane.doc.toString(), ">>hello!");
		expect(change).not.toBeNull();
		pane = pane
			.update({ changes: change!, annotations: Transaction.addToHistory.of(false) })
			.state;
		expect(pane.doc.toString()).toBe(">>hello!");
		expect(pane.field(historyField).done.length).toBe(1);
	});

	it("a full-document replacement would wipe history (why minimal matters)", () => {
		let pane = EditorState.create({ doc: "hello", extensions: [history()] });
		pane = pane.update({ changes: { from: 5, to: 5, insert: "!" } }).state;
		expect(pane.field(historyField).done.length).toBe(1);

		pane = pane
			.update({
				changes: { from: 0, to: pane.doc.length, insert: ">>hello!" },
				annotations: Transaction.addToHistory.of(false)
			})
			.state;
		expect(pane.doc.toString()).toBe(">>hello!");
		expect(pane.field(historyField).done.length).toBe(0);
	});

	it("two views hold independent histories over the same text", () => {
		let tab = EditorState.create({ doc: "shared", extensions: [history()] });
		let pane = EditorState.create({ doc: "shared", extensions: [history()] });

		tab = tab.update({ changes: { from: 6, to: 6, insert: " tab" } }).state;
		pane = pane.update({ changes: { from: 6, to: 6, insert: " pane" } }).state;
		expect(tab.field(historyField).done.length).toBe(1);
		expect(pane.field(historyField).done.length).toBe(1);

		// Echo tab's keystrokes into the pane without touching pane history.
		const echo = minimalTextChange(pane.doc.toString(), tab.doc.toString());
		pane = pane.update({ changes: echo!, annotations: Transaction.addToHistory.of(false) }).state;
		expect(pane.field(historyField).done.length).toBe(1);
		expect(tab.field(historyField).done.length).toBe(1);
	});
});
