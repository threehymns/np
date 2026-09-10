import { describe, it, expect } from "bun:test";
import { EditorState } from "@codemirror/state";
import {
	getLineSelectionRange,
	computeGutterDragSelection,
} from "./line-numbers";

describe("line-numbers gutter drag selection", () => {
	const docText = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5";

	it("computes correct line selection range downwards", () => {
		const state = EditorState.create({ doc: docText });
		const line1 = state.doc.line(1);
		const line2 = state.doc.line(2);

		const range = getLineSelectionRange(state.doc, line1, line2);
		expect(range.from).toBe(0); // Line 1 start
		expect(range.to).toBe(14); // Line 2 end + newline (Line 3 start)
		expect(range.anchor).toBe(0);
		expect(range.head).toBe(14);
	});

	it("computes correct line selection range up to EOF", () => {
		const state = EditorState.create({ doc: docText });
		const line4 = state.doc.line(4);
		const line5 = state.doc.line(5);

		const range = getLineSelectionRange(state.doc, line4, line5);
		expect(range.from).toBe(21); // Line 4 start
		expect(range.to).toBe(state.doc.length); // Line 5 end (EOF)
		expect(range.anchor).toBe(21);
		expect(range.head).toBe(state.doc.length);
	});

	it("computes correct line selection range upwards", () => {
		const state = EditorState.create({ doc: docText });
		const line3 = state.doc.line(3);
		const line1 = state.doc.line(1);

		const range = getLineSelectionRange(state.doc, line3, line1);
		expect(range.from).toBe(0); // Line 1 start
		expect(range.to).toBe(21); // Line 3 end + newline (Line 4 start)
		expect(range.anchor).toBe(21);
		expect(range.head).toBe(0);
	});

	it("selects a single whole line with trailing newline", () => {
		const state = EditorState.create({ doc: docText });
		const line2 = state.doc.line(2);

		const sel = computeGutterDragSelection(state.doc, line2, line2);
		expect(sel.ranges.length).toBe(1);
		expect(sel.main.from).toBe(line2.from);
		expect(sel.main.to).toBe(line2.to + 1);
		expect(sel.main.anchor).toBe(line2.from);
		expect(sel.main.head).toBe(line2.to + 1);
	});

	it("supports Ctrl/Cmd+drag multi-line selections across non-contiguous lines", () => {
		const state = EditorState.create({ doc: docText });
		const line1 = state.doc.line(1);
		const line4 = state.doc.line(4);
		const line5 = state.doc.line(5);

		// First selection: Line 1
		const sel1 = computeGutterDragSelection(state.doc, line1, line1);
		expect(sel1.ranges.length).toBe(1);

		// Second selection with isMulti: Lines 4 to 5
		const sel2 = computeGutterDragSelection(state.doc, line4, line5, {
			isMulti: true,
			initialRanges: sel1.ranges,
		});

		expect(sel2.ranges.length).toBe(2);
		expect(sel2.ranges[0].from).toBe(line1.from);
		expect(sel2.ranges[0].to).toBe(line1.to + 1);
		expect(sel2.ranges[1].from).toBe(line4.from);
		expect(sel2.ranges[1].to).toBe(line5.to); // EOF
		// The active dragged range (second one) should be the main selection
		expect(sel2.main.from).toBe(line4.from);
		expect(sel2.main.to).toBe(line5.to);
	});

	it("sets the main selection to the currently dragged range even if earlier in document", () => {
		const state = EditorState.create({ doc: docText });
		const line1 = state.doc.line(1);
		const line5 = state.doc.line(5);

		// First selection: Line 5
		const sel1 = computeGutterDragSelection(state.doc, line5, line5);

		// Second selection: Line 1 (earlier in document than Line 5)
		const sel2 = computeGutterDragSelection(state.doc, line1, line1, {
			isMulti: true,
			initialRanges: sel1.ranges,
		});

		expect(sel2.ranges.length).toBe(2);
		// Line 1 is the actively dragged selection, so it should be the main selection
		expect(sel2.main.from).toBe(line1.from);
		expect(sel2.main.to).toBe(line1.to + 1);
	});

	it("supports Shift+click range expansion from existing anchor", () => {
		const state = EditorState.create({ doc: docText });
		const line1 = state.doc.line(1);
		const line3 = state.doc.line(3);

		// Initial cursor in Line 1
		const shiftAnchor = line1.from;

		// Shift+click Line 3
		const sel = computeGutterDragSelection(state.doc, line3, line3, {
			isShift: true,
			shiftAnchor,
		});

		expect(sel.ranges.length).toBe(1);
		expect(sel.main.from).toBe(0);
		expect(sel.main.to).toBe(line3.to + 1);
		expect(sel.main.anchor).toBe(0);
		expect(sel.main.head).toBe(line3.to + 1);
	});

	it("supports Shift+click upwards range expansion", () => {
		const state = EditorState.create({ doc: docText });
		const line1 = state.doc.line(1);
		const line4 = state.doc.line(4);

		// Initial cursor in Line 4
		const shiftAnchor = line4.to;

		// Shift+click Line 1
		const sel = computeGutterDragSelection(state.doc, line1, line1, {
			isShift: true,
			shiftAnchor,
		});

		expect(sel.ranges.length).toBe(1);
		expect(sel.main.from).toBe(line1.from);
		expect(sel.main.to).toBe(line4.to);
		expect(sel.main.anchor).toBe(line4.to);
		expect(sel.main.head).toBe(line1.from);
	});
});
