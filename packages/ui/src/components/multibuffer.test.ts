import { describe, it, expect } from "bun:test";
import { EditorState } from "@codemirror/state";
import { unifiedMergeView } from "@codemirror/merge";
import { keymap, type EditorView } from "@codemirror/view";
import {
	createViewRegistry,
	getBufferBoundaries,
	isAtBufferBoundary,
	createFileNavKeymap,
	MULTIBUFFER_COLLAPSE_CONFIG,
} from "./multibuffer.js";

// Minimal stand-in: the registry only stores and returns views, never
// touches their internals, so stubs pin the contract without DOM.
function stubView(id: string): EditorView {
	return { __stub: id } as unknown as EditorView;
}

function stateWithDiff(doc: string, original: string): EditorState {
	return EditorState.create({ doc, extensions: [unifiedMergeView({ original })] });
}

describe("multibuffer view registry", () => {
	it("returns an already-registered view immediately", async () => {
		const registry = createViewRegistry();
		const view = stubView("inline");
		registry.register("a.txt", { inline: view });
		expect(await registry.getOrWait("a.txt", "inline")).toBe(view);
	});

	it("resolves a queued waiter when its mode registers (issue #81)", async () => {
		const registry = createViewRegistry();
		const inlineView = stubView("inline");
		const pending = registry.getOrWait("a.txt", "inline");
		let settled: EditorView | undefined | "pending" = "pending";
		void pending.then((v) => (settled = v));
		await Bun.sleep(0);
		expect(settled).toBe("pending");
		registry.register("a.txt", { inline: inlineView });
		expect(await pending).toBe(inlineView);
	});

	it("never resolves an inline waiter from a split registration during mode switches", async () => {
		const registry = createViewRegistry();
		const split = { a: stubView("a"), b: stubView("b") };
		const pending = registry.getOrWait("a.txt", "inline");
		let settled: EditorView | undefined | "pending" = "pending";
		void pending.then((v) => (settled = v));
		registry.register("a.txt", { split: split as never });
		await Bun.sleep(20);
		expect(settled).toBe("pending");
		// And the split waiter for the same file resolves from that registration.
		expect(await registry.getOrWait("a.txt", "split", "b")).toBe(split.b);
		// Cleanup: abort the orphaned inline waiter so the test ends settled.
		registry.abort("a.txt", "inline");
		expect(await pending).toBeUndefined();
	});

	it("prefers side b for split mode by default, side a on request", async () => {
		const registry = createViewRegistry();
		const a = stubView("a");
		const b = stubView("b");
		registry.register("a.txt", { split: { a, b } as never });
		expect(await registry.getOrWait("a.txt", "split")).toBe(b);
		expect(await registry.getOrWait("a.txt", "split", "a")).toBe(a);
	});

	it("settles teardown waiters with undefined instead of hanging", async () => {
		const registry = createViewRegistry();
		const pending = registry.getOrWait("gone.txt", "split");
		registry.unregisterSplit("gone.txt");
		expect(await pending).toBeUndefined();
	});

	it("unregisterInline drops only the inline view, keeping split", async () => {
		const registry = createViewRegistry();
		const inline = stubView("inline");
		const b = stubView("b");
		registry.register("a.txt", { inline });
		registry.register("a.txt", { split: { b } as never });
		registry.unregisterInline("a.txt");
		expect(await registry.getOrWait("a.txt", "split", "b")).toBe(b);
		expect(registry.get("a.txt")?.inline).toBeUndefined();
	});
});

describe("multibuffer buffer boundaries", () => {
	it("exposes the Zed-parity collapse margins", () => {
		expect(MULTIBUFFER_COLLAPSE_CONFIG).toEqual({ margin: 3, minSize: 4 });
	});

	it("covers the whole document when there are no chunks", () => {
		const doc = "l1\nl2\nl3";
		const state = stateWithDiff(doc, doc);
		expect(getBufferBoundaries(state)).toEqual({ firstLine: 1, lastLine: 3 });
	});

	it("covers the whole short document when collapsed fringes are below minSize", () => {
		const doc = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10";
		const orig = "l1\nl2\nl3\nCHANGED\nl6\nl7\nl8\nl9\nl10";
		const state = stateWithDiff(doc, orig);
		expect(getBufferBoundaries(state)).toEqual({ firstLine: 1, lastLine: 10 });
	});

	it("clips collapsed fringes beyond the margin on a tall document", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
		const doc = lines.join("\n");
		const changed = [...lines];
		changed[9] = "CHANGED";
		const state = stateWithDiff(doc, changed.join("\n"));
		// Changed line is 10: top fringe collapses lines 1..6 (to = 10-1-3),
		// so the buffer starts at 7; the chunk ends at line 11, bottom
		// collapses from 14, so the buffer ends at 13.
		expect(getBufferBoundaries(state)).toEqual({ firstLine: 7, lastLine: 13 });
	});

	it("detects cursor at buffer edges for cross-file navigation", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
		const doc = lines.join("\n");
		const changed = [...lines];
		changed[9] = "CHANGED";
		const state = stateWithDiff(doc, changed.join("\n"));
		const viewAt = (line: number) => {
			const pos = state.doc.line(line).from;
			const at = state.update({ selection: { anchor: pos } }).state;
			return { state: at } as unknown as EditorView;
		};
		expect(isAtBufferBoundary(viewAt(7), "up")).toBe(true);
		expect(isAtBufferBoundary(viewAt(8), "up")).toBe(false);
		expect(isAtBufferBoundary(viewAt(13), "down")).toBe(true);
		expect(isAtBufferBoundary(viewAt(12), "down")).toBe(false);
	});
});

describe("multibuffer file-nav keymap", () => {
	function runsFor(ext: unknown): Map<string, (v: EditorView) => boolean> {
		const state = EditorState.create({ doc: "x", extensions: [ext as never] });
		const groups = state.facet(keymap) as unknown as Array<Array<{ key?: string; run: (v: EditorView) => boolean }>>;
		return new Map(groups.flat().map((s) => [s.key!, s.run]));
	}

	it("delegates boundary arrows to the cross-file handler", () => {
		const calls: Array<{ direction: "down" | "up" }> = [];
		const byKey = runsFor(
			createFileNavKeymap({
				isAtBoundary: () => true,
				onBoundary: (_view, direction) => calls.push({ direction }),
			})
		);
		const view = stubView("v");
		expect(byKey.get("ArrowDown")!(view)).toBe(true);
		expect(byKey.get("ArrowUp")!(view)).toBe(true);
		expect(calls).toEqual([{ direction: "down" }, { direction: "up" }]);
	});

	it("falls through when the cursor is mid-buffer", () => {
		const byKey = runsFor(
			createFileNavKeymap({
				isAtBoundary: () => false,
				onBoundary: () => {},
			})
		);
		expect(byKey.get("ArrowDown")!(stubView("v"))).toBe(false);
	});
});
