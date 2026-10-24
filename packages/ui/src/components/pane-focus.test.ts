import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { focusPaneEditor, paneEditorKey } from "./pane-focus";

/**
 * The DOM focus of a pane.
 *
 * Moving the focus between panes is a command (ADR 0024), and the command
 * runs in the core, which knows nothing about the DOM. The shell knows
 * which editor belongs to which pane, so it publishes the way to focus the
 * active one. The rule lives in `pane-focus.ts` so that it can be tested
 * without a DOM, the way `editor-focus.ts` holds the rules of an editor.
 */

/** An editor view that records the focus it was given. */
function fakeView(name: string, log: string[]) {
	return { focus: () => log.push(name) };
}

describe("The DOM focus goes to the editor of the pane", () => {
	it("focuses the editor of the pane's active tab", () => {
		const log: string[] = [];
		const views = {
			[paneEditorKey("pane-1", "tab-1")]: fakeView("pane-1:tab-1", log),
			[paneEditorKey("pane-2", "tab-2")]: fakeView("pane-2:tab-2", log),
		};

		const focused = focusPaneEditor(views, { id: "pane-2", activeTabId: "tab-2" });

		expect(focused).toBe(true);
		expect(log).toEqual(["pane-2:tab-2"]);
	});

	it("leaves the focus alone when the pane has no tab", () => {
		const log: string[] = [];
		const views = { [paneEditorKey("pane-1", "tab-1")]: fakeView("pane-1:tab-1", log) };

		expect(focusPaneEditor(views, { id: "pane-1", activeTabId: "" })).toBe(false);
		expect(log).toEqual([]);
	});

	it("leaves the focus alone when the pane holds no editor", () => {
		const log: string[] = [];
		const views = { [paneEditorKey("pane-1", "tab-1")]: fakeView("pane-1:tab-1", log) };

		expect(focusPaneEditor(views, { id: "pane-2", activeTabId: "tab-2" })).toBe(false);
		expect(log).toEqual([]);
	});
});

/**
 * The rules above live in a module the shell calls. These tests hold the
 * shell to them: the unit suite has no DOM, so the wiring is read off the
 * source rather than mounted.
 */
describe("The shell publishes the way to focus the active pane's editor", () => {
	const layoutSource = readFileSync(join(import.meta.dir, "MainLayout.svelte"), "utf-8");
	const paneSource = readFileSync(join(import.meta.dir, "Pane.svelte"), "utf-8");

	it("publishes the capability the pane commands consume", () => {
		expect(layoutSource).toContain("appState.focusActivePaneEditor");
		expect(layoutSource).toContain("focusPaneEditor(");
	});

	it("files every pane's editor under the shared key", () => {
		expect(paneSource).toContain("paneEditorKey(");
		expect(layoutSource).toContain("paneEditorKey(");
	});
});
