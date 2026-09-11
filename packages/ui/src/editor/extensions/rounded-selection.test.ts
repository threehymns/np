import { describe, it, expect } from "bun:test";
import { Text, EditorSelection } from "@codemirror/state";
import { Direction, type EditorView } from "@codemirror/view";
import {
	buildRoundedSelectionPath,
	RoundedSelectionMarker,
	tightRectanglesForRange,
	type SelectionRect,
} from "./rounded-selection";

describe("buildRoundedSelectionPath", () => {
	it("returns empty string for empty rects", () => {
		expect(buildRoundedSelectionPath([])).toBe("");
	});

	it("generates a rounded rect path for a single line", () => {
		const rects: SelectionRect[] = [{ left: 10, top: 20, right: 100, bottom: 40 }];
		const path = buildRoundedSelectionPath(rects, 4);
		expect(path).toContain("M 14 20");
		expect(path).toContain("H 96");
		expect(path).toContain("A 4 4 0 0 1 100 24");
		expect(path).toContain("Z");
	});

	it("generates a multi-line polygon with both convex and concave rounded corners (step-in)", () => {
		// Line 1: x 10 to 100, y 0 to 20
		// Line 2: x 10 to 60,  y 20 to 40 (shorter line below, creating a concave step at x=60, y=20)
		const rects: SelectionRect[] = [
			{ left: 10, top: 0, right: 100, bottom: 20 },
			{ left: 10, top: 20, right: 60, bottom: 40 },
		];
		const path = buildRoundedSelectionPath(rects, 4);
		expect(path).toContain("M");
		expect(path).toContain("A 4 4 0 0 1"); // convex turn
		expect(path).toContain("A 4 4 0 0 0"); // concave turn (sweep-flag = 0)
		expect(path).toContain("Z");
	});

	it("generates a multi-line polygon with concave fillet on step-out", () => {
		// Line 1: x 10 to 60,  y 0 to 20
		// Line 2: x 10 to 120, y 20 to 40 (longer line below, concave at x=60, y=20 before stepping out)
		const rects: SelectionRect[] = [
			{ left: 10, top: 0, right: 60, bottom: 20 },
			{ left: 10, top: 20, right: 120, bottom: 40 },
		];
		const path = buildRoundedSelectionPath(rects, 4);
		expect(path).toContain("A 4 4 0 0 0"); // concave fillet at step-out
		expect(path).toContain("A 4 4 0 0 1"); // convex fillet
		expect(path).toContain("Z");
	});

	it("generates smooth multi-line staircase with both right-side and left-side fillets", () => {
		const rects: SelectionRect[] = [
			{ left: 20, top: 0, right: 80, bottom: 20 },
			{ left: 10, top: 20, right: 120, bottom: 40 },
			{ left: 10, top: 40, right: 50, bottom: 60 },
		];
		const path = buildRoundedSelectionPath(rects, 4);
		const concaveMatches = path.match(/A 4 4 0 0 0/g);
		expect(concaveMatches).not.toBeNull();
		expect(concaveMatches!.length).toBeGreaterThanOrEqual(2);
		expect(path.endsWith("Z")).toBe(true);
	});

	it("bridges subpixel vertical seams between consecutive lines into a single connected polygon", () => {
		// Lines separated by slight subpixel gap (e.g. 1.5px)
		const rects: SelectionRect[] = [
			{ left: 10, top: 0, right: 100, bottom: 20 },
			{ left: 10, top: 21.5, right: 60, bottom: 40 },
		];
		const path = buildRoundedSelectionPath(rects, 4);
		const zMatches = path.match(/Z/g);
		expect(zMatches).not.toBeNull();
		expect(zMatches!.length).toBe(1);
		expect(path).toContain("A 4 4 0 0 0");
		expect(path).toContain("A 4 4 0 0 1");
	});

	it("does not bridge vertical gaps larger than seam tolerance (e.g. skipped lines)", () => {
		// Lines separated by 20px unselected line
		const rects: SelectionRect[] = [
			{ left: 10, top: 0, right: 100, bottom: 20 },
			{ left: 10, top: 40, right: 60, bottom: 60 },
		];
		const path = buildRoundedSelectionPath(rects, 4);
		const zMatches = path.match(/Z/g);
		expect(zMatches).not.toBeNull();
		expect(zMatches!.length).toBe(2);
	});

	it("connects lines with different heights (e.g. H1 heading + body text) seamlessly", () => {
		// Line 1 (H1 heading): height 48px (0 to 48)
		// Line 2 (body text): height 24px (48 to 72)
		const rects: SelectionRect[] = [
			{ left: 10, top: 0, right: 140, bottom: 48 },
			{ left: 10, top: 48, right: 80, bottom: 72 },
		];
		const path = buildRoundedSelectionPath(rects, 4);
		const zMatches = path.match(/Z/g);
		expect(zMatches).not.toBeNull();
		expect(zMatches!.length).toBe(1);
		expect(path).toContain("A 4 4 0 0 0");
		expect(path).toContain("A 4 4 0 0 1");
	});

	it("handles disconnected rect groups with multiple subpaths", () => {
		const rects: SelectionRect[] = [
			{ left: 10, top: 0, right: 50, bottom: 20 },
			{ left: 80, top: 0, right: 120, bottom: 20 },
			{ left: 10, top: 60, right: 50, bottom: 80 },
		];
		const path = buildRoundedSelectionPath(rects, 4);
		const zMatches = path.match(/Z/g);
		expect(zMatches).not.toBeNull();
		expect(zMatches!.length).toBeGreaterThanOrEqual(2);
	});
});

describe("RoundedSelectionMarker", () => {
	it("initializes and compares correctly with eq()", () => {
		const m1 = new RoundedSelectionMarker(
			{ left: 10, top: 20, width: 100, height: 40 },
			"M 0 0 Z",
			"cm-rounded-selection"
		);
		const m2 = new RoundedSelectionMarker(
			{ left: 10, top: 20, width: 100, height: 40 },
			"M 0 0 Z",
			"cm-rounded-selection"
		);
		const m3 = new RoundedSelectionMarker(
			{ left: 15, top: 20, width: 100, height: 40 },
			"M 0 0 Z",
			"cm-rounded-selection"
		);

		expect(m1.eq(m2)).toBe(true);
		expect(m1.eq(m3)).toBe(false);
	});
});

describe("tightRectanglesForRange line-height independence", () => {
	function makeMockView(options: {
		docText: string;
		lineHeights: number[];
		documentTop?: number;
		charWidth?: number;
	}) {
		const lines = options.docText.split("\n");
		const doc = Text.of(lines);
		const lineBlocks: {
			from: number;
			to: number;
			top: number;
			bottom: number;
			height: number;
		}[] = [];
		let curTop = 0;
		for (let i = 1; i <= doc.lines; i++) {
			const line = doc.line(i);
			const height = options.lineHeights[i - 1] ?? 24;
			lineBlocks.push({
				from: line.from,
				to: line.to,
				top: curTop,
				bottom: curTop + height,
				height,
			});
			curTop += height;
		}

		const scrollDOM = {
			getBoundingClientRect: () => ({
				left: 0,
				top: 0,
				right: 800,
				bottom: 600,
				width: 800,
				height: 600,
			}),
			scrollLeft: 0,
			scrollTop: 0,
			clientWidth: 800,
		};

		const dom = {
			getBoundingClientRect: () => ({
				left: 0,
				top: 0,
				right: 800,
				bottom: 600,
				width: 800,
				height: 600,
			}),
		};

		const charWidth = options.charWidth ?? 8;

		return {
			state: { doc, selection: { ranges: [] } },
			viewport: { from: 0, to: doc.length },
			scrollDOM,
			dom,
			textDirection: Direction.LTR,
			scaleX: 1,
			scaleY: 1,
			defaultCharacterWidth: charWidth,
			defaultLineHeight: 24,
			documentTop: options.documentTop ?? 0,
			lineBlockAt(pos: number) {
				const block = lineBlocks.find((b) => pos >= b.from && pos <= b.to);
				return block || lineBlocks[0];
			},
			coordsAtPos(pos: number, side: number = 1) {
				const line = doc.lineAt(pos);
				const block = lineBlocks[line.number - 1];
				const col = pos - line.from;
				const x = col * charWidth;
				return {
					left: x,
					right: x,
					top: block.top,
					bottom: block.bottom,
				};
			},
			domAtPos() {
				return { node: { nodeType: 1, closest: () => null } };
			},
			posAtCoords() {
				return null;
			},
		} as unknown as EditorView;
	}

	it("measures single line selection with exact lineBlockAt height", () => {
		// Test with custom line height = 36px
		const view = makeMockView({
			docText: "Hello world",
			lineHeights: [36],
		});
		const range = EditorSelection.range(0, 5); // "Hello"
		const rects = tightRectanglesForRange(view, range);

		expect(rects.length).toBe(1);
		expect(rects[0].top).toBe(0);
		expect(rects[0].bottom).toBe(36);
		expect(rects[0].right - rects[0].left).toBe(5 * 8); // 5 chars * 8px
	});

	it("measures multi-line selection across different line heights (heading + body) contiguously", () => {
		// Line 1: H1 heading (height 52px)
		// Line 2: Body text (height 26px)
		const view = makeMockView({
			docText: "# Big Title\nSome body text here",
			lineHeights: [52, 26],
		});
		// Select from "Title" (pos 2) through "body" (pos 16)
		const range = EditorSelection.range(2, 16);
		const rects = tightRectanglesForRange(view, range);

		expect(rects.length).toBe(2);
		// Heading rect spans exactly 0 to 52
		expect(rects[0].top).toBe(0);
		expect(rects[0].bottom).toBe(52);
		// Body rect spans exactly 52 to 78
		expect(rects[1].top).toBe(52);
		expect(rects[1].bottom).toBe(78);
		// They are strictly contiguous
		expect(rects[0].bottom).toBe(rects[1].top);
	});

	it("handles empty line in multi-line selection using full line block height", () => {
		// Line 1: text (height 30px)
		// Line 2: empty (height 30px)
		// Line 3: text (height 30px)
		const view = makeMockView({
			docText: "First\n\nThird",
			lineHeights: [30, 30, 30],
		});
		// Select from "First" to "Third"
		const range = EditorSelection.range(0, 11);
		const rects = tightRectanglesForRange(view, range);

		expect(rects.length).toBe(3);
		expect(rects[0].top).toBe(0);
		expect(rects[0].bottom).toBe(30);
		expect(rects[1].top).toBe(30);
		expect(rects[1].bottom).toBe(60);
		expect(rects[2].top).toBe(60);
		expect(rects[2].bottom).toBe(90);
	});

	it("handles newline-only selection on a line using full line block height", () => {
		const view = makeMockView({
			docText: "Line 1\nLine 2",
			lineHeights: [40, 40],
		});
		// Selection starts at the newline of Line 1 (pos 6) and continues into Line 2 (pos 8)
		const range = EditorSelection.range(6, 8);
		const rects = tightRectanglesForRange(view, range);

		expect(rects.length).toBe(2);
		expect(rects[0].top).toBe(0);
		expect(rects[0].bottom).toBe(40);
		expect(rects[1].top).toBe(40);
		expect(rects[1].bottom).toBe(80);
		expect(rects[0].bottom).toBe(rects[1].top);
	});

	it("adapts correctly when documentTop is offset due to scrolling", () => {
		const view = makeMockView({
			docText: "Scrolled line",
			lineHeights: [32],
			documentTop: -64,
		});
		const range = EditorSelection.range(0, 8);
		const rects = tightRectanglesForRange(view, range);

		expect(rects.length).toBe(1);
		expect(rects[0].top).toBe(-64);
		expect(rects[0].bottom).toBe(-32);
	});
});
