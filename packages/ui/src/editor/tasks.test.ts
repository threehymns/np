import "../../../../tests/contract/rune-setup";
import { describe, it, expect, beforeAll, mock } from "bun:test";
import { EditorState } from "@codemirror/state";
import { syntaxTree, LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { ViewPlugin } from "@codemirror/view";
import { taskToggleChange, TaskCheckboxWidget } from "./extensions/tasks";

let getLanguageExtensions: any;
let taskCheckboxPlugin: ViewPlugin<any>;

beforeAll(async () => {
	mock.module("svelte/reactivity", () => ({
		SvelteMap: Map,
		SvelteSet: Set,
	}));
	const mod = await import("./index");
	getLanguageExtensions = mod.getLanguageExtensions;
	taskCheckboxPlugin = mod.taskCheckboxPlugin;
});

async function makeState(doc: string, selection?: { anchor: number; head?: number }): Promise<EditorState> {
	const desc = languages.find((l) => l.name === "Markdown")!;
	const exts = await getLanguageExtensions(desc);
	const support = exts.filter((e) => e instanceof LanguageSupport);
	return EditorState.create({ doc, selection, extensions: support });
}

function nodeTexts(state: EditorState, name: string): string[] {
	const out: string[] = [];
	syntaxTree(state).iterate({
		enter: (n: any) => {
			if (n.name === name) out.push(state.doc.sliceString(n.from, n.to));
		},
	});
	return out;
}

function widgets(plugin: ViewPlugin<any>, state: EditorState): TaskCheckboxWidget[] {
	const inst: any = plugin.create(
		{ state, hasFocus: false, visibleRanges: [{ from: 0, to: state.doc.length }] },
		undefined,
	);
	const found: TaskCheckboxWidget[] = [];
	inst.decorations.between(0, state.doc.length, (_f: number, _t: number, d: any) => {
		const w = d.spec?.widget;
		if (w instanceof TaskCheckboxWidget) found.push(w);
	});
	return found;
}

describe("#152 task checkboxes", () => {
	it("parses checked and unchecked items as Task + TaskMarker", async () => {
		const state = await makeState("- [ ] todo\n- [x] done");
		expect(nodeTexts(state, "TaskMarker")).toEqual(["[ ]", "[x]"]);
	});

	it("renders a checkbox widget per marker with mirrored checked state", async () => {
		const state = await makeState("- [ ] todo\n- [x] done\n- [X] cap");
		const ws = widgets(taskCheckboxPlugin, state);
		expect(ws.length).toBe(3);
		expect(ws.map((w) => w.checked)).toEqual([false, true, true]);
	});

	it("keeps nested and plain items distinct (no widget on plain)", async () => {
		const plain = await makeState("- plain item");
		expect(widgets(taskCheckboxPlugin, plain)).toEqual([]);

		const nested = await makeState("  - [ ] nested");
		expect(widgets(taskCheckboxPlugin, nested).length).toBe(1);
	});

	it("computes toggle replacements [ ] <-> [x]", () => {
		expect(taskToggleChange("- [ ] x", 2, 5)).toEqual({
			from: 2,
			to: 5,
			insert: "[x]",
		});
		expect(taskToggleChange("- [x] x", 2, 5)).toEqual({
			from: 2,
			to: 5,
			insert: "[ ]",
		});
		expect(taskToggleChange("- plain", 0, 4)).toBeNull();
	});

	it("hides bullet marker and shows checkbox widget when cursor is outside the syntax area", async () => {
		const state = await makeState("- [ ] todo", { anchor: 6 });
		const mockView = {
			state,
			hasFocus: true,
			visibleRanges: [{ from: 0, to: 10 }],
		};
		// TaskCheckboxWidget should be present
		const checkboxInst: any = taskCheckboxPlugin.create(mockView as any, undefined);
		let hasCheckbox = false;
		checkboxInst.decorations.between(0, 10, (_f: number, _t: number, d: any) => {
			if (d.spec?.widget instanceof TaskCheckboxWidget) hasCheckbox = true;
		});
		expect(hasCheckbox).toBe(true);

		// HideMarkersPlugin should hide the list mark and NOT add a BulletWidget
		const mod = await import("./extensions/hide-markers");
		const hideInst: any = mod.hideMarkersPlugin.create(mockView as any, undefined);
		let hasBullet = false;
		let hiddenListMark = false;
		hideInst.decorations.between(0, 10, (f: number, t: number, d: any) => {
			if (d.spec?.widget?.constructor?.name === "BulletWidget") hasBullet = true;
			if (f === 0 && d.spec?.widget === undefined && !d.spec?.class) hiddenListMark = true;
		});
		expect(hasBullet).toBe(false);
		expect(hiddenListMark).toBe(true);
	});

	it("removes checkbox and shows raw syntax when cursor is in the checkbox syntax area", async () => {
		const mod = await import("./extensions/hide-markers");
		for (const cursorPos of [0, 1, 2, 3, 4, 5]) {
			const state = await makeState("- [ ] todo", { anchor: cursorPos });
			const mockView = {
				state,
				hasFocus: true,
				visibleRanges: [{ from: 0, to: 10 }],
			};

			const checkboxInst: any = taskCheckboxPlugin.create(mockView as any, undefined);
			let hasCheckbox = false;
			checkboxInst.decorations.between(0, 10, (_f: number, _t: number, d: any) => {
				if (d.spec?.widget instanceof TaskCheckboxWidget) hasCheckbox = true;
			});
			expect(hasCheckbox).toBe(false);

			const hideInst: any = mod.hideMarkersPlugin.create(mockView as any, undefined);
			let hasBullet = false;
			let hiddenListMark = false;
			hideInst.decorations.between(0, 10, (f: number, t: number, d: any) => {
				if (d.spec?.widget?.constructor?.name === "BulletWidget") hasBullet = true;
				if (f === 0 && d.spec?.widget === undefined && !d.spec?.class) hiddenListMark = true;
			});
			expect(hasBullet).toBe(false);
			expect(hiddenListMark).toBe(false);
		}
	});

	it("handles nested task items correctly with indentation", async () => {
		const mod = await import("./extensions/hide-markers");
		// "  - [ ] nested" (indent: 0..2, dash: 2..3, space: 3..4, marker: 4..7, text: 8..14)
		// Off-syntax: cursor at pos 10
		const stateOff = await makeState("  - [ ] nested", { anchor: 10 });
		const viewOff = {
			state: stateOff,
			hasFocus: true,
			visibleRanges: [{ from: 0, to: 14 }],
		};
		const checkboxOff: any = taskCheckboxPlugin.create(viewOff as any, undefined);
		let hasCheckboxOff = false;
		checkboxOff.decorations.between(0, 14, (_f: number, _t: number, d: any) => {
			if (d.spec?.widget instanceof TaskCheckboxWidget) hasCheckboxOff = true;
		});
		expect(hasCheckboxOff).toBe(true);

		const hideOff: any = mod.hideMarkersPlugin.create(viewOff as any, undefined);
		let hiddenRange: { from: number; to: number } | null = null;
		hideOff.decorations.between(0, 14, (f: number, t: number, d: any) => {
			if (d.spec?.widget === undefined && !d.spec?.class) hiddenRange = { from: f, to: t };
		});
		expect(hiddenRange).toEqual({ from: 2, to: 4 });

		// In-syntax: cursor at pos 4 (inside `[ ]`)
		const stateIn = await makeState("  - [ ] nested", { anchor: 4 });
		const viewIn = {
			state: stateIn,
			hasFocus: true,
			visibleRanges: [{ from: 0, to: 14 }],
		};
		const checkboxIn: any = taskCheckboxPlugin.create(viewIn as any, undefined);
		let hasCheckboxIn = false;
		checkboxIn.decorations.between(0, 14, (_f: number, _t: number, d: any) => {
			if (d.spec?.widget instanceof TaskCheckboxWidget) hasCheckboxIn = true;
		});
		expect(hasCheckboxIn).toBe(false);
	});

	it("preserves normal bullet widget behavior on non-task list items", async () => {
		const mod = await import("./extensions/hide-markers");
		// Unfocused: "- plain item" should show BulletWidget
		const stateUnfocused = await makeState("- plain item");
		const viewUnfocused = {
			state: stateUnfocused,
			hasFocus: false,
			visibleRanges: [{ from: 0, to: 12 }],
		};
		const hideUnfocused: any = mod.hideMarkersPlugin.create(viewUnfocused as any, undefined);
		let hasBullet = false;
		hideUnfocused.decorations.between(0, 12, (_f: number, _t: number, d: any) => {
			if (d.spec?.widget?.constructor?.name === "BulletWidget") hasBullet = true;
		});
		expect(hasBullet).toBe(true);

		// Focused on line: "- plain item" should show raw dash (no BulletWidget)
		const stateFocused = await makeState("- plain item", { anchor: 4 });
		const viewFocused = {
			state: stateFocused,
			hasFocus: true,
			visibleRanges: [{ from: 0, to: 12 }],
		};
		const hideFocused: any = mod.hideMarkersPlugin.create(viewFocused as any, undefined);
		let hasBulletFocused = false;
		hideFocused.decorations.between(0, 12, (_f: number, _t: number, d: any) => {
			if (d.spec?.widget?.constructor?.name === "BulletWidget") hasBulletFocused = true;
		});
		expect(hasBulletFocused).toBe(false);
	});
});