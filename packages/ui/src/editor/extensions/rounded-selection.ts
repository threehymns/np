import {
	EditorView,
	layer,
	type LayerMarker,
	Direction,
} from "@codemirror/view";
import { type SelectionRange } from "@codemirror/state";

export interface SelectionRect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

type Point = { x: number; y: number };

function singleRectPath(rect: SelectionRect, r: number): string {
	const { left, top, right, bottom } = rect;
	const w = Math.max(0, right - left);
	const h = Math.max(0, bottom - top);
	if (w === 0 || h === 0) return "";
	const radius = Math.min(r, w / 2, h / 2);
	return (
		`M ${left + radius} ${top} ` +
		`H ${right - radius} ` +
		`A ${radius} ${radius} 0 0 1 ${right} ${top + radius} ` +
		`V ${bottom - radius} ` +
		`A ${radius} ${radius} 0 0 1 ${right - radius} ${bottom} ` +
		`H ${left + radius} ` +
		`A ${radius} ${radius} 0 0 1 ${left} ${bottom - radius} ` +
		`V ${top + radius} ` +
		`A ${radius} ${radius} 0 0 1 ${left + radius} ${top} Z`
	);
}

function buildGroupPath(group: SelectionRect[], r: number = 4): string {
	if (group.length === 0) return "";
	if (group.length === 1) return singleRectPath(group[0], r);

	const vertices: Point[] = [];

	// Top line: start at top-left
	vertices.push({ x: group[0].left, y: group[0].top });
	vertices.push({ x: group[0].right, y: group[0].top });

	// Down the right side
	for (let i = 0; i < group.length; i++) {
		const cur = group[i];
		const next = group[i + 1];
		if (!next) {
			vertices.push({ x: cur.right, y: cur.bottom });
		} else {
			vertices.push({ x: cur.right, y: cur.bottom });
			if (Math.abs(cur.right - next.right) > 1) {
				vertices.push({ x: next.right, y: cur.bottom });
			}
		}
	}

	// Bottom line: bottom-right to bottom-left
	const last = group[group.length - 1];
	vertices.push({ x: last.left, y: last.bottom });

	// Up the left side
	for (let i = group.length - 1; i > 0; i--) {
		const cur = group[i];
		const prev = group[i - 1];
		vertices.push({ x: cur.left, y: cur.top });
		if (Math.abs(cur.left - prev.left) > 1) {
			vertices.push({ x: prev.left, y: cur.top });
		}
	}

	// Clean collinear and duplicate points iteratively until stable
	let currentVertices = vertices;
	let changed = true;
	while (changed) {
		changed = false;
		const nextVertices: Point[] = [];
		const len = currentVertices.length;
		if (len < 3) break;

		for (let i = 0; i < len; i++) {
			const p0 = currentVertices[(i - 1 + len) % len];
			const p1 = currentVertices[i];
			const p2 = currentVertices[(i + 1) % len];

			// Duplicate
			if (Math.abs(p1.x - p0.x) < 0.5 && Math.abs(p1.y - p0.y) < 0.5) {
				changed = true;
				continue;
			}

			// Collinear horizontal
			if (Math.abs(p0.y - p1.y) < 0.5 && Math.abs(p1.y - p2.y) < 0.5) {
				changed = true;
				continue;
			}

			// Collinear vertical
			if (Math.abs(p0.x - p1.x) < 0.5 && Math.abs(p1.x - p2.x) < 0.5) {
				changed = true;
				continue;
			}

			nextVertices.push(p1);
		}
		currentVertices = nextVertices;
	}

	const n = currentVertices.length;
	if (n < 3) return "";

	let path = "";
	for (let i = 0; i < n; i++) {
		const prev = currentVertices[(i - 1 + n) % n];
		const curr = currentVertices[i];
		const next = currentVertices[(i + 1) % n];

		const d1x = curr.x - prev.x;
		const d1y = curr.y - prev.y;
		const len1 = Math.hypot(d1x, d1y);

		const d2x = next.x - curr.x;
		const d2y = next.y - curr.y;
		const len2 = Math.hypot(d2x, d2y);

		if (len1 < 0.5 || len2 < 0.5) continue;

		const radius = Math.min(r, len1 / 2, len2 / 2);

		// Corner start point (on incoming edge)
		const startX = curr.x - (d1x / len1) * radius;
		const startY = curr.y - (d1y / len1) * radius;

		// Corner end point (on outgoing edge)
		const endX = curr.x + (d2x / len2) * radius;
		const endY = curr.y + (d2y / len2) * radius;

		// Determine clockwise turn using 2D cross product: (d1x * d2y - d1y * d2x)
		// For clockwise outer perimeter:
		// positive cross-product = clockwise turn (convex outer corner) -> sweep-flag = 1
		// negative cross-product = counter-clockwise turn (concave inner step) -> sweep-flag = 0
		const cross = d1x * d2y - d1y * d2x;
		const sweepFlag = cross > 0 ? 1 : 0;

		if (path === "") {
			path += `M ${startX} ${startY} `;
		} else {
			path += `L ${startX} ${startY} `;
		}
		path += `A ${radius} ${radius} 0 0 ${sweepFlag} ${endX} ${endY} `;
	}

	if (path !== "") {
		path += "Z";
	}
	return path;
}

/**
 * Generates an SVG path data string for a set of vertically stacked line rectangles,
 * rounding both convex (exterior) and concave (interior step) corners with radius `r`.
 */
export function buildRoundedSelectionPath(rects: SelectionRect[], r: number = 4): string {
	if (rects.length === 0) return "";

	// Merge horizontally overlapping or touching rects on the same vertical band
	const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left);
	const merged: SelectionRect[] = [];

	for (const cur of sorted) {
		const prev = merged[merged.length - 1];
		if (
			prev &&
			Math.abs(prev.top - cur.top) < 1.5 &&
			Math.abs(prev.bottom - cur.bottom) < 1.5
		) {
			if (cur.left <= prev.right + 2) {
				prev.right = Math.max(prev.right, cur.right);
				prev.left = Math.min(prev.left, cur.left);
				continue;
			}
		}
		merged.push({ ...cur });
	}

	if (merged.length === 0) return "";

	// Snap adjacent vertical seams so top and bottom edges meet seamlessly
	for (let i = 0; i < merged.length - 1; i++) {
		const cur = merged[i];
		const next = merged[i + 1];
		const gap = next.top - cur.bottom;
		if (Math.abs(gap) <= 2.5) {
			const midY = (cur.bottom + next.top) / 2;
			cur.bottom = midY;
			next.top = midY;
		}
	}

	// Group connected rects: rects that vertically touch and horizontally overlap
	const groups: SelectionRect[][] = [];
	let currentGroup: SelectionRect[] = [];
	for (let i = 0; i < merged.length; i++) {
		const cur = merged[i];
		const prev = currentGroup[currentGroup.length - 1];
		if (
			prev &&
			Math.abs(cur.top - prev.bottom) < 2 &&
			Math.max(cur.left, prev.left) < Math.min(cur.right, prev.right)
		) {
			currentGroup.push(cur);
		} else {
			if (currentGroup.length > 0) groups.push(currentGroup);
			currentGroup = [cur];
		}
	}
	if (currentGroup.length > 0) groups.push(currentGroup);

	return groups
		.map((g) => buildGroupPath(g, r))
		.filter(Boolean)
		.join(" ");
}

export interface MarkerBounds {
	left: number;
	top: number;
	width: number;
	height: number;
}

export class RoundedSelectionMarker implements LayerMarker {
	constructor(
		readonly bounds: MarkerBounds,
		readonly pathData: string,
		readonly className: string
	) {}

	eq(other: LayerMarker): boolean {
		return (
			other instanceof RoundedSelectionMarker &&
			other.pathData === this.pathData &&
			other.className === this.className &&
			other.bounds.left === this.bounds.left &&
			other.bounds.top === this.bounds.top &&
			other.bounds.width === this.bounds.width &&
			other.bounds.height === this.bounds.height
		);
	}

	draw(): HTMLElement {
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("class", this.className);
		svg.style.position = "absolute";
		svg.style.left = `${this.bounds.left}px`;
		svg.style.top = `${this.bounds.top}px`;
		svg.style.width = `${this.bounds.width}px`;
		svg.style.height = `${this.bounds.height}px`;
		svg.style.overflow = "visible";
		svg.style.pointerEvents = "none";

		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute("d", this.pathData);
		path.setAttribute("class", "cm-selectionBackground");
		svg.appendChild(path);

		return svg as unknown as HTMLElement;
	}

	update(dom: HTMLElement, oldMarker: LayerMarker): boolean {
		if (
			!(oldMarker instanceof RoundedSelectionMarker) ||
			oldMarker.className !== this.className
		) {
			return false;
		}
		if (
			this.bounds.left !== oldMarker.bounds.left ||
			this.bounds.top !== oldMarker.bounds.top ||
			this.bounds.width !== oldMarker.bounds.width ||
			this.bounds.height !== oldMarker.bounds.height
		) {
			dom.style.left = `${this.bounds.left}px`;
			dom.style.top = `${this.bounds.top}px`;
			dom.style.width = `${this.bounds.width}px`;
			dom.style.height = `${this.bounds.height}px`;
		}
		const path = dom.querySelector("path");
		if (path) {
			path.setAttribute("d", this.pathData);
			return true;
		}
		return false;
	}
}

function getBase(view: EditorView) {
	const rect = view.scrollDOM.getBoundingClientRect();
	const left =
		view.textDirection === Direction.LTR
			? rect.left
			: rect.right - view.scrollDOM.clientWidth * view.scaleX;
	return {
		left: left - view.scrollDOM.scrollLeft * view.scaleX,
		top: rect.top - view.scrollDOM.scrollTop * view.scaleY,
	};
}

function getLineHeight(view: EditorView, pos: number): number {
	try {
		const dom = view.domAtPos(pos);
		let lineElt =
			dom.node.nodeType === 1
				? (dom.node as HTMLElement)
				: dom.node.parentElement;
		lineElt = lineElt?.closest?.(".cm-line") ?? null;
		if (lineElt && typeof window !== "undefined" && window.getComputedStyle) {
			const lh = parseFloat(window.getComputedStyle(lineElt).lineHeight);
			if (!isNaN(lh) && lh > 0) return lh;
		}
	} catch {
		// Fallback if DOM is not ready or in headless test environments
	}
	return view.defaultLineHeight || 24;
}

/**
 * Measures tight selection rectangles for a given selection range,
 * extending trailing newlines by only ~0.75 character width instead of the full buffer width.
 * Uses lineBlockAt to ensure selections accurately reflect rendered line heights (including
 * custom line-heights, headings, widgets, and block decorations) without vertical gaps.
 */
export function tightRectanglesForRange(
	view: EditorView,
	range: SelectionRange
): SelectionRect[] {
	if (range.to <= view.viewport.from || range.from >= view.viewport.to) {
		return [];
	}

	const from = Math.max(range.from, view.viewport.from);
	const to = Math.min(range.to, view.viewport.to);
	const base = getBase(view);
	const charWidth = view.defaultCharacterWidth || 8;
	const docTop = typeof view.documentTop === "number" ? view.documentTop : 0;
	const rects: SelectionRect[] = [];

	const doc = view.state.doc;
	const startLine = doc.lineAt(from);
	const endLine = doc.lineAt(to);

	for (let l = startLine.number; l <= endLine.number; l++) {
		const line = doc.line(l);
		const lineFrom = Math.max(from, line.from);
		const lineTo = Math.min(to, line.to);
		const includesNewline = to > line.to;

		if (lineFrom >= lineTo && !includesNewline) {
			continue;
		}

		const block = view.lineBlockAt(line.from);
		const blockTop = docTop + block.top - base.top;
		const blockBottom = docTop + block.bottom - base.top;

		if (line.length === 0) {
			// Empty line: sample line coordinates
			const coords = view.coordsAtPos(line.from);
			if (coords) {
				const left = coords.left;
				const right = coords.left + (includesNewline ? charWidth * 0.75 : 0);
				if (right > left && blockBottom > blockTop) {
					rects.push({
						left: left - base.left,
						top: blockTop,
						right: right - base.left,
						bottom: blockBottom,
					});
				}
			}
			continue;
		}

		if (lineFrom === lineTo) {
			// Selection only touches the newline of this line
			const coords = view.coordsAtPos(lineTo, -1);
			if (coords) {
				const lineStartCoords = view.coordsAtPos(line.from, 1);
				const isWrapped =
					lineStartCoords &&
					Math.abs(lineStartCoords.top - coords.top) >= 3;
				const top = isWrapped
					? blockBottom - getLineHeight(view, line.from)
					: blockTop;
				const left = coords.left;
				const right = coords.left + (includesNewline ? charWidth * 0.75 : 0);
				if (right > left && blockBottom > top) {
					rects.push({
						left: left - base.left,
						top,
						right: right - base.left,
						bottom: blockBottom,
					});
				}
			}
			continue;
		}

		// Substring selection on this line
		const startCoords = view.coordsAtPos(lineFrom, 1);
		const endCoords = view.coordsAtPos(lineTo, -1);

		if (!startCoords || !endCoords) {
			continue;
		}

		const lineStartCoords = view.coordsAtPos(line.from, 1);
		const lineEndCoords = view.coordsAtPos(line.to, -1);
		const isWrapped =
			lineStartCoords &&
			lineEndCoords &&
			Math.abs(lineStartCoords.top - lineEndCoords.top) >= 3;

		if (!isWrapped) {
			// Single visual line: spans full rendered line block height
			let left = Math.min(startCoords.left, endCoords.left);
			let right = Math.max(startCoords.right, endCoords.right);

			if (includesNewline) {
				right += charWidth * 0.75;
			}

			if (right > left && blockBottom > blockTop) {
				rects.push({
					left: left - base.left,
					top: blockTop,
					right: right - base.left,
					bottom: blockBottom,
				});
			}
		} else {
			// Wrapped line: slice by visual lines
			const lh = getLineHeight(view, line.from);
			const editorRect = view.dom.getBoundingClientRect();
			let cur = lineFrom;
			const lineSlices: SelectionRect[] = [];

			while (cur <= lineTo) {
				const c = view.coordsAtPos(cur, cur === line.to ? -1 : 1);
				if (!c) break;
				const y = (c.top + c.bottom) / 2;
				const leftPos = view.posAtCoords({ x: editorRect.left + 1, y });
				const rightPos = view.posAtCoords({ x: editorRect.right - 1, y });
				const lineStart = leftPos ?? cur;
				const lineEnd = rightPos ?? lineTo;
				const vFrom = Math.max(lineFrom, Math.min(lineStart, lineEnd));
				const vTo = Math.min(lineTo, Math.max(lineStart, lineEnd));

				const sc = view.coordsAtPos(vFrom, 1);
				const ec = view.coordsAtPos(vTo, -1);
				if (sc && ec) {
					const midY = (sc.top + sc.bottom + ec.top + ec.bottom) / 4;
					let top = midY - base.top - lh / 2;
					let bottom = midY - base.top + lh / 2;

					if (vFrom === line.from) {
						top = blockTop;
					}
					if (vTo === line.to) {
						bottom = blockBottom;
					}

					let left = Math.min(sc.left, ec.left);
					let right = Math.max(sc.right, ec.right);
					if (vTo === line.to && includesNewline) {
						right += charWidth * 0.75;
					}
					if (right > left && bottom > top) {
						lineSlices.push({
							left: left - base.left,
							top,
							right: right - base.left,
							bottom,
						});
					}
				}
				if (vTo >= lineTo || vTo >= line.to) break;
				cur = Math.max(cur + 1, vTo + 1);
			}

			// Snap adjacent visual slices within the wrapped line
			for (let i = 0; i < lineSlices.length - 1; i++) {
				const seam = (lineSlices[i].bottom + lineSlices[i + 1].top) / 2;
				lineSlices[i].bottom = seam;
				lineSlices[i + 1].top = seam;
			}

			rects.push(...lineSlices);
		}
	}

	return rects;
}

export const roundedSelectionLayer = layer({
	above: false,
	markers(view: EditorView) {
		const markers: LayerMarker[] = [];
		const { ranges } = view.state.selection;

		for (const r of ranges) {
			if (r.empty) continue;
			const rects = tightRectanglesForRange(view, r);
			if (rects.length === 0) continue;

			let minLeft = Infinity;
			let minTop = Infinity;
			let maxRight = -Infinity;
			let maxBottom = -Infinity;

			for (const rect of rects) {
				minLeft = Math.min(minLeft, rect.left);
				minTop = Math.min(minTop, rect.top);
				maxRight = Math.max(maxRight, rect.right);
				maxBottom = Math.max(maxBottom, rect.bottom);
			}

			if (minLeft >= maxRight || minTop >= maxBottom) continue;

			const width = maxRight - minLeft;
			const height = maxBottom - minTop;

			// Shift rects so path coordinates are relative to marker's (minLeft, minTop)
			const localRects = rects.map((rect) => ({
				left: rect.left - minLeft,
				top: rect.top - minTop,
				right: rect.right - minLeft,
				bottom: rect.bottom - minTop,
			}));

			const pathData = buildRoundedSelectionPath(localRects, 4);
			if (pathData) {
				markers.push(
					new RoundedSelectionMarker(
						{ left: minLeft, top: minTop, width, height },
						pathData,
						"cm-rounded-selection"
					)
				);
			}
		}

		return markers;
	},
	update(update) {
		return (
			update.docChanged ||
			update.selectionSet ||
			update.viewportChanged ||
			update.geometryChanged
		);
	},
	class: "cm-rounded-selectionLayer",
});
