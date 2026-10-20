import { describe, it, expect } from "bun:test";
import { Text, EditorSelection, EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { Table, GFM } from "@lezer/markdown";
import { Direction, type EditorView } from "@codemirror/view";
import {
	buildRoundedSelectionPath,
	RoundedSelectionMarker,
	coverLineBox,
	tightRectanglesForRange,
	isPosInTable,
	tooltipSelectionState,
	type SelectionRect,
	type TooltipSelection,
	type TooltipSelectionContainer,
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

describe("tightRectanglesForRange markdown table suppression", () => {
	const tableDoc =
		"| Left aligned | Center |\n| :--- | :---: |\n| apples | bananas |\n| cats | dogs |\n";

	function makeTableView(options: { cellEditor?: boolean } = {}) {
		const state = EditorState.create({
			doc: tableDoc,
			extensions: [markdown({ extensions: [Table, GFM] as any })],
		});
		const doc = state.doc;
		const charWidth = 8;
		const lineHeight = 30;
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
		const dom: any = {
			getBoundingClientRect: () => ({
				left: 0,
				top: 0,
				right: 800,
				bottom: 600,
				width: 800,
				height: 600,
			}),
			closest: options.cellEditor
				? (sel: string) => (sel === ".tbl-cell-editor" ? {} : null)
				: () => null,
		};
		return {
			state,
			viewport: { from: 0, to: doc.length },
			scrollDOM,
			dom,
			textDirection: Direction.LTR,
			scaleX: 1,
			scaleY: 1,
			defaultCharacterWidth: charWidth,
			defaultLineHeight: 24,
			documentTop: 0,
			lineBlockAt(pos: number) {
				const line = doc.lineAt(pos);
				const top = (line.number - 1) * lineHeight;
				return {
					from: line.from,
					to: line.to,
					top,
					bottom: top + lineHeight,
					height: lineHeight,
				};
			},
			// Simulate codemirror-markdown-tables block-widget coordsAt, which
			// returns the full cell rect instead of tight text bounds.
			coordsAtPos(pos: number, _side: number = 1) {
				const line = doc.lineAt(pos);
				const top = (line.number - 1) * lineHeight;
				if (options.cellEditor) {
					const col = pos - line.from;
					const x = col * charWidth;
					return { left: x, right: x, top, bottom: top + lineHeight };
				}
				return {
					left: 0,
					right: 200,
					top,
					bottom: top + lineHeight,
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

	it("detects positions inside markdown tables", () => {
		const view = makeTableView();
		// Inside "apples" cell
		expect(isPosInTable(view.state, 45)).toBe(true);
		expect(isPosInTable(view.state, 47)).toBe(true);
		const plain = EditorState.create({
			doc: "hello",
			extensions: [markdown({ extensions: [Table, GFM] as any })],
		});
		expect(isPosInTable(plain, 2)).toBe(false);
	});

	it("suppresses outer rounded selection for small intra-cell selections", () => {
		const view = makeTableView();
		const line3 = view.state.doc.line(3);
		// "appl" inside "apples" — small text, but widget coords are cell-wide.
		const range = EditorSelection.range(line3.from + 2, line3.from + 6);
		expect(tightRectanglesForRange(view, range)).toEqual([]);
	});

	it("keeps inner cell-editor selection tight", () => {
		const view = makeTableView({ cellEditor: true });
		const line3 = view.state.doc.line(3);
		const range = EditorSelection.range(line3.from + 2, line3.from + 6);
		const rects = tightRectanglesForRange(view, range);
		expect(rects.length).toBe(1);
	});

	it("keeps non-table lines of a crossing selection", () => {
		const state = EditorState.create({
			doc: `hello\n${tableDoc}`,
			extensions: [markdown({ extensions: [Table, GFM] as any })],
		});
		const outer = makeTableView();
		// Reuse table-view geometry but swap in the crossing doc state.
		(outer as any).state = state;
		(outer as any).viewport = { from: 0, to: state.doc.length };
		const range = EditorSelection.range(0, 2);
		const rects = tightRectanglesForRange(outer, range);
		expect(rects.length).toBe(1);
	});
});

/**
 * Tooltip text selections draw the same rounded path as editor selections.
 *
 * The overlay state is pure in its inputs (a Selection-like and a container)
 * so it is asserted with fakes: no layout engine is needed to prove the
 * show/hide rules and the rect clipping, which are the whole of this seam.
 * Rects are viewport-space client rects, matching the fixed overlay.
 */
describe("tooltipSelectionState", () => {
	const box = { left: 10, top: 20, right: 210, bottom: 60 };

	function container(inside: unknown): TooltipSelectionContainer {
		return {
			contains: (node: unknown) => node === inside,
			getBoundingClientRect: () => ({ ...box }),
		} as unknown as TooltipSelectionContainer;
	}

	function selection(opts: {
		collapsed?: boolean;
		anchor?: unknown;
		rects?: Array<{ left: number; top: number; right: number; bottom: number }>;
		noRanges?: boolean;
	}): TooltipSelection {
		return {
			isCollapsed: opts.collapsed ?? false,
			anchorNode: (opts.anchor ?? null) as unknown as Node,
			getRangeAt: () => {
				if (opts.noRanges) throw new Error("no ranges");
				return {
					getClientRects: () => opts.rects ?? [],
				};
			},
		} as unknown as TooltipSelection;
	}

	it("hides without a selection or with a collapsed one", () => {
		const inside = {};
		expect(tooltipSelectionState(null, container(inside))).toBeNull();
		expect(
			tooltipSelectionState(selection({ collapsed: true, anchor: inside }), container(inside))
		).toBeNull();
	});

	it("hides when the drag started outside the tooltip", () => {
		const inside = {};
		const outside = {};
		const sel = selection({
			anchor: outside,
			rects: [{ left: 20, top: 25, right: 100, bottom: 45 }],
		});
		expect(tooltipSelectionState(sel, container(inside))).toBeNull();
	});

	it("hides when the range holds no rects", () => {
		const inside = {};
		expect(
			tooltipSelectionState(selection({ anchor: inside, noRanges: true }), container(inside))
		).toBeNull();
		expect(
			tooltipSelectionState(selection({ anchor: inside, rects: [] }), container(inside))
		).toBeNull();
	});

	it("draws the rounded path over fully-inside rects", () => {
		const inside = {};
		const state = tooltipSelectionState(
			selection({
				anchor: inside,
				rects: [{ left: 20, top: 25, right: 100, bottom: 45 }],
			}),
			container(inside)
		);
		expect(state).not.toBeNull();
		expect(state!.bounds).toEqual({ left: 20, top: 25, width: 80, height: 20 });
		expect(state!.pathData).toContain("M");
		expect(state!.pathData.endsWith("Z")).toBe(true);
	});

	it("clips rects sticking out of the tooltip box", () => {
		const inside = {};
		const state = tooltipSelectionState(
			selection({
				anchor: inside,
				rects: [{ left: 150, top: 25, right: 300, bottom: 45 }],
			}),
			container(inside)
		);
		expect(state).not.toBeNull();
		expect(state!.bounds).toEqual({ left: 150, top: 25, width: 60, height: 20 });
	});

	it("hides when every rect falls outside the box", () => {
		const inside = {};
		const state = tooltipSelectionState(
			selection({
				anchor: inside,
				rects: [{ left: 300, top: 25, right: 400, bottom: 45 }],
			}),
			container(inside)
		);
		expect(state).toBeNull();
	});

	it("drops zero-area rects", () => {
		const inside = {};
		const state = tooltipSelectionState(
			selection({
				anchor: inside,
				rects: [
					{ left: 50, top: 25, right: 50, bottom: 45 },
					{ left: 20, top: 25, right: 100, bottom: 45 },
				],
			}),
			container(inside)
		);
		expect(state).not.toBeNull();
		expect(state!.bounds).toEqual({ left: 20, top: 25, width: 80, height: 20 });
	});
});

/**
 * Fragment rects expand to the measured line height, like the editor layer
 * fills the rendered line block: raw client rects hug the glyph ink and
 * would otherwise paint a thin band per line instead of the full line box.
 */
describe("tooltipSelectionState line coverage", () => {
	const box = { left: 10, top: 20, right: 210, bottom: 100 };

	function container(inside: unknown) {
		return {
			contains: (node: unknown) => node === inside,
			getBoundingClientRect: () => ({ ...box }),
		};
	}

	function selection(anchor: unknown, rects: Array<{ left: number; top: number; right: number; bottom: number }>) {
		return {
			isCollapsed: false,
			anchorNode: anchor,
			getRangeAt: () => ({ getClientRects: () => rects }),
		};
	}

	it("merges same-line fragments into one rect without a measurer", () => {
		const inside = {};
		// Text, pill, text slivers of one visual line: stroking each
		// separately notches the path at every inline boundary.
		const state = tooltipSelectionState(
			selection(inside, [
				{ left: 20, top: 26, right: 60, bottom: 38 },
				{ left: 60, top: 24, right: 110, bottom: 40 },
				{ left: 110, top: 26, right: 150, bottom: 38 },
			]),
			container(inside)
		);
		expect(state).not.toBeNull();
		expect(state!.bounds).toEqual({ left: 20, top: 24, width: 130, height: 16 });
		expect(state!.pathData.match(/Z/g)).toHaveLength(1);
	});

	it("keeps adjacent lines separate for the seam snap", () => {
		const inside = {};
		const state = tooltipSelectionState(
			selection(inside, [
				{ left: 20, top: 22, right: 100, bottom: 38 },
				{ left: 20, top: 42, right: 80, bottom: 58 },
			]),
			container(inside)
		);
		expect(state).not.toBeNull();
		// 4px gap: two polygons, joined visually by the seam snap.
		expect(state!.pathData.match(/Z/g)).toHaveLength(2);
	});

	it("covers each line with the measured span", () => {
		const inside = {};
		const state = tooltipSelectionState(
			selection(inside, [{ left: 20, top: 26, right: 100, bottom: 38 }]),
			container(inside),
			{ coverLine: () => ({ top: 22, bottom: 42 }) }
		);
		expect(state).not.toBeNull();
		expect(state!.bounds).toEqual({ left: 20, top: 22, width: 80, height: 20 });
	});

	it("keeps the tight line rect when measurement is unavailable", () => {
		const inside = {};
		const rect = { left: 20, top: 26, right: 100, bottom: 38 };
		expect(
			tooltipSelectionState(selection(inside, [rect]), container(inside), {
				coverLine: () => null,
			})!.bounds
		).toEqual({ left: 20, top: 26, width: 80, height: 12 });
		expect(
			tooltipSelectionState(selection(inside, [rect]), container(inside))!.bounds
		).toEqual({ left: 20, top: 26, width: 80, height: 12 });
	});

	it("covers pill overhang reported by the measurer", () => {
		const inside = {};
		// Glyph band 26..38 with a padded pill painting 22..42: the cover
		// carries the overhang so the pill stays inside the highlight.
		const state = tooltipSelectionState(
			selection(inside, [{ left: 20, top: 26, right: 100, bottom: 38 }]),
			container(inside),
			{ coverLine: () => ({ top: 22, bottom: 42 }) }
		);
		expect(state).not.toBeNull();
		expect(state!.bounds).toEqual({ left: 20, top: 22, width: 80, height: 20 });
	});

	it("clamps coverage to the tooltip box", () => {
		const inside = {};
		const state = tooltipSelectionState(
			selection(inside, [{ left: 20, top: 21, right: 100, bottom: 35 }]),
			container(inside),
			{ coverLine: () => ({ top: 5, bottom: 200 }) }
		);
		expect(state).not.toBeNull();
		expect(state!.bounds).toEqual({ left: 20, top: 20, width: 80, height: 80 });
	});
});

/**
 * Multi-line inline ancestors must not leak into a line's cover: a fenced
 * block's `code` wrapper is `display: inline` yet spans every line, and
 * unioning it fills the whole section for a one-line selection. Only
 * single-line inlines (code pills) join the line-height fill.
 */
describe("coverLineBox", () => {
	const fragment = { left: 20, top: 26, right: 100, bottom: 38 };

	it("fills to the line height with no inline boxes", () => {
		// Height 12 with line height 20: 4px of leading each side.
		expect(coverLineBox(fragment, 20, [])).toEqual({ top: 22, bottom: 42 });
	});

	it("unions single-line pill boxes that paint outside the line box", () => {
		const cover = coverLineBox(fragment, 20, [{ left: 60, top: 24, right: 110, bottom: 44 }]);
		expect(cover).toEqual({ top: 22, bottom: 44 });
	});

	it("excludes a multi-line wrapper box", () => {
		// The fenced block's code wrapper around one selected line: covering
		// it would fill the whole section.
		const cover = coverLineBox(fragment, 20, [
			{ left: 60, top: 24, right: 110, bottom: 40 },
			{ left: 20, top: 20, right: 150, bottom: 120 },
		]);
		expect(cover).toEqual({ top: 22, bottom: 42 });
	});

	it("keeps the fragment when there is nothing to cover with", () => {
		expect(coverLineBox(fragment, 0, [])).toEqual({ top: 26, bottom: 38 });
	});
});
