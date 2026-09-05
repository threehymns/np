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

async function makeState(doc: string): Promise<EditorState> {
	const desc = languages.find((l) => l.name === "Markdown")!;
	const exts = await getLanguageExtensions(desc);
	const support = exts.filter((e) => e instanceof LanguageSupport);
	return EditorState.create({ doc, extensions: support });
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
});