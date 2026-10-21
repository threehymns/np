import "../../../../tests/contract/rune-setup";
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
	applyEditorWrap,
	claimEditorFocusedContext,
	claimEditorKeymapContexts,
	type FocusableView,
	type FocusContextRoot,
	type KeymapContextOwner,
	type VimModeSource,
} from "./editor-focus";

/**
 * The focus-sensitive state of an editor belongs to the editor the user is
 * typing in (ADR 0024). The unit suite has no DOM, so the editor component
 * cannot be mounted here; the rules live in `editor-focus.ts` and are
 * exercised against the real compartments, the real keymap context shape and
 * a stand-in for the vim extension's CodeMirror instance.
 */

/** The keymap registry's context store, without the rest of the registry. */
function fakeKeymaps(): KeymapContextOwner & { context: Record<string, string | boolean> } {
	const context: Record<string, string | boolean> = {};
	return {
		context,
		setContext(key: string, value: string | boolean | undefined) {
			if (value === undefined) delete context[key];
			else context[key] = value;
		},
	};
}

/** An editor view that records what it was asked to dispatch. */
function fakeView(): { view: FocusableView; dispatched: { effects?: unknown }[] } {
	const dispatched: { effects?: unknown }[] = [];
	return {
		dispatched,
		view: {
			dispatch(spec) {
				dispatched.push(spec);
			},
		},
	};
}

/** The vim extension's CodeMirror instance, reduced to what it reports. */
function fakeCm(): VimModeSource & { emit(mode: string): void } {
	const handlers: ((args: { mode: string }) => void)[] = [];
	return {
		on(_type, handler) {
			handlers.push(handler);
		},
		off(_type, handler) {
			const index = handlers.indexOf(handler);
			if (index !== -1) handlers.splice(index, 1);
		},
		emit(mode: string) {
			for (const handler of [...handlers]) handler({ mode });
		},
	};
}

/**
 * The source of every `$effect(...)` block in a Svelte file, so a test can
 * say which state an effect follows.
 */
function effectBlocks(source: string): string[] {
	const blocks: string[] = [];
	let index = source.indexOf("$effect(");
	while (index !== -1) {
		let depth = 0;
		let quote: string | null = null;
		let end = index;
		for (; end < source.length; end++) {
			const ch = source[end];
			if (quote) {
				if (ch === "\\") {
					end++;
					continue;
				}
				if (ch === quote) quote = null;
				continue;
			}
			if (ch === '"' || ch === "'" || ch === "`") {
				quote = ch;
				continue;
			}
			if (ch === "(") depth++;
			else if (ch === ")") {
				depth--;
				if (depth === 0) break;
			}
		}
		blocks.push(source.slice(index, end + 1));
		index = source.indexOf("$effect(", end + 1);
	}
	return blocks;
}

/** The one effect block that mentions the given text. */
function blockWith(blocks: string[], needle: string): string {
	const found = blocks.filter((block) => block.includes(needle));
	expect(found).toHaveLength(1);
	return found[0];
}

describe("The editor in a pane without focus keeps no focus-sensitive state", () => {
	it("does not apply the word-wrap preference", () => {
		const { view, dispatched } = fakeView();
		const compartment = new Compartment();

		applyEditorWrap(view, { focused: false, wrap: true, compartment });

		expect(dispatched).toEqual([]);
	});

	it("claims no keymap context, so the focused editor's contexts survive", () => {
		const keymaps = fakeKeymaps();
		const cm = fakeCm();

		const release = claimEditorKeymapContexts(keymaps, {
			focused: false,
			vimEnabled: true,
			cm,
		});

		expect(keymaps.context).toEqual({});
		// Releasing an editor that claimed nothing clears nothing.
		release();
		expect(keymaps.context).toEqual({});
	});
});

describe("The focused editor owns the focus-sensitive state", () => {
	it("applies the word-wrap preference", () => {
		const { view, dispatched } = fakeView();
		const compartment = new Compartment();

		applyEditorWrap(view, { focused: true, wrap: true, compartment });
		applyEditorWrap(view, { focused: true, wrap: false, compartment });

		expect(dispatched).toHaveLength(2);
		expect((dispatched[0].effects as { value: { extension: unknown } }).value.extension).toBe(
			EditorView.lineWrapping,
		);
		expect((dispatched[1].effects as { value: { extension: unknown } }).value.extension).toEqual([]);
	});

	it("claims the editor keymap context and releases it again", () => {
		const keymaps = fakeKeymaps();

		const release = claimEditorKeymapContexts(keymaps, {
			focused: true,
			vimEnabled: false,
		});

		expect(keymaps.context.editor).toBe(true);
		expect(keymaps.context.vim_mode).toBeUndefined();

		release();

		expect(keymaps.context.editor).toBeUndefined();
		expect(keymaps.context.vim_mode).toBeUndefined();
	});

	it("follows the vim mode the extension reports", () => {
		const keymaps = fakeKeymaps();
		const cm = fakeCm();

		const release = claimEditorKeymapContexts(keymaps, {
			focused: true,
			vimEnabled: true,
			cm,
		});

		expect(keymaps.context.vim_mode).toBe("normal");

		cm.emit("insert");
		expect(keymaps.context.vim_mode).toBe("insert");

		release();

		expect(keymaps.context.vim_mode).toBeUndefined();
		// The listener goes with the claim, so a mode change after the
		// editor lost focus does not write into the contexts again.
		cm.emit("normal");
		expect(keymaps.context.vim_mode).toBeUndefined();
	});
});

/**
 * The rules above live in a module the editor component calls. These tests
 * hold the component to them: the unit suite has no DOM, so the wiring is
 * read off the source rather than mounted.
 */
describe("The editor component follows the focused prop", () => {
	const editorSource = readFileSync(join(import.meta.dir, "Editor.svelte"), "utf-8");
	const paneSource = readFileSync(join(import.meta.dir, "Pane.svelte"), "utf-8");

	it("gives the editor a focused prop", () => {
		expect(editorSource).toMatch(/focused\?: boolean;/);
	});

	it("takes word wrap, vim mode and the keymap contexts from the focused prop", () => {
		const blocks = effectBlocks(editorSource);

		for (const call of ["applyEditorWrap(", "vimCompartment.reconfigure", "claimEditorKeymapContexts(", "claimEditorFocusedContext("]) {
			const block = blockWith(blocks, call);
			expect(block).toContain("focused");
			// The `active` prop is the one that says the editor is live. The
			// focus-sensitive blocks must not read it. `activeElement` is a
			// different word and does not match.
			expect(block).not.toMatch(/\bactive\b/);
		}
	});

	it("keeps the language of an unfocused editor in sync with its document", () => {
		const block = blockWith(effectBlocks(editorSource), "languageCompartment.reconfigure");
		expect(block).toContain("active");
		expect(block).not.toContain("focused");
	});

	it("gives the editor the real focus state", () => {
		expect(paneSource).toContain("focused={isActive}");
		expect(paneSource).toContain("active={true}");
	});
});

/**
 * An editor DOM root, reduced to what the focus context needs: whether the
 * document's active element is inside it, and whether focus moved in or out.
 */
function fakeRoot(): FocusContextRoot & {
	emit(type: string, event?: { relatedTarget?: unknown }): void;
	inside: Set<unknown>;
} {
	const listeners: Record<string, ((event: any) => void)[]> = {};
	const inside = new Set<unknown>();
	return {
		inside,
		contains(node: unknown) {
			return inside.has(node);
		},
		addEventListener(type: string, handler: (event: any) => void) {
			(listeners[type] ??= []).push(handler);
		},
		removeEventListener(type: string, handler: (event: any) => void) {
			const list = listeners[type];
			if (!list) return;
			const index = list.indexOf(handler);
			if (index !== -1) list.splice(index, 1);
		},
		emit(type: string, event: { relatedTarget?: unknown } = {}) {
			for (const handler of [...(listeners[type] ?? [])]) handler(event);
		},
	};
}

describe("The editorFocused context belongs to the focused editor", () => {
	it("claims nothing when the editor is not focused", () => {
		const keymaps = fakeKeymaps();
		const root = fakeRoot();

		const release = claimEditorFocusedContext(keymaps, {
			focused: false,
			root,
			activeElement: () => "child",
		});

		expect(keymaps.context.editorFocused).toBeUndefined();
		expect(root.inside.has("child")).toBe(false);
		release();
	});

	it("claims nothing when there is no editor to claim it for", () => {
		const keymaps = fakeKeymaps();

		claimEditorFocusedContext(keymaps, {
			focused: true,
			root: null,
			activeElement: () => null,
		});

		expect(keymaps.context.editorFocused).toBeUndefined();
	});

	it("is set while the document's active element is inside the editor", () => {
		const keymaps = fakeKeymaps();
		const root = fakeRoot();
		const child = {};
		root.inside.add(child);

		claimEditorFocusedContext(keymaps, {
			focused: true,
			root,
			activeElement: () => child,
		});

		expect(keymaps.context.editorFocused).toBe(true);
	});

	it("is clear when the active element is outside the editor", () => {
		const keymaps = fakeKeymaps();
		const root = fakeRoot();

		claimEditorFocusedContext(keymaps, {
			focused: true,
			root,
			activeElement: () => ({}),
		});

		expect(keymaps.context.editorFocused).toBeUndefined();
	});

	it("follows focus moving into the editor", () => {
		const keymaps = fakeKeymaps();
		const root = fakeRoot();

		claimEditorFocusedContext(keymaps, {
			focused: true,
			root,
			activeElement: () => null,
		});
		expect(keymaps.context.editorFocused).toBeUndefined();

		root.emit("focusin");
		expect(keymaps.context.editorFocused).toBe(true);
	});

	it("follows focus leaving the editor", () => {
		const keymaps = fakeKeymaps();
		const root = fakeRoot();

		claimEditorFocusedContext(keymaps, {
			focused: true,
			root,
			activeElement: () => null,
		});
		root.emit("focusin");
		expect(keymaps.context.editorFocused).toBe(true);

		root.emit("focusout", { relatedTarget: {} });
		expect(keymaps.context.editorFocused).toBeUndefined();
	});

	it("keeps the context when focus moves inside the editor", () => {
		const keymaps = fakeKeymaps();
		const root = fakeRoot();
		const panel = {};
		root.inside.add(panel);

		claimEditorFocusedContext(keymaps, {
			focused: true,
			root,
			activeElement: () => null,
		});
		root.emit("focusin");

		// Movement into the search panel, which lives in the editor root, is
		// not movement out of the editor.
		root.emit("focusout", { relatedTarget: panel });
		expect(keymaps.context.editorFocused).toBe(true);
	});

	it("releases the context when the editor lets go", () => {
		const keymaps = fakeKeymaps();
		const root = fakeRoot();

		const release = claimEditorFocusedContext(keymaps, {
			focused: true,
			root,
			activeElement: () => null,
		});
		root.emit("focusin");
		expect(keymaps.context.editorFocused).toBe(true);

		release();
		expect(keymaps.context.editorFocused).toBeUndefined();

		// The listener goes with the claim, so a focus event after the
		// editor let go does not write into the contexts again.
		root.emit("focusin");
		expect(keymaps.context.editorFocused).toBeUndefined();
	});
});

/**
 * When focus moves between panes, Svelte runs the gaining pane's effect
 * before the losing pane's cleanup. The losing pane's release is then stale:
 * it must not clear the contexts the gaining pane just claimed, and its
 * leftover listeners must not write into them either.
 */
describe("A stale claim never touches a newer editor's contexts", () => {
	it("keeps the keymap contexts when an older editor lets go after a newer one claimed", () => {
		const keymaps = fakeKeymaps();

		const releaseA = claimEditorKeymapContexts(keymaps, {
			focused: true,
			vimEnabled: false,
		});
		const releaseB = claimEditorKeymapContexts(keymaps, {
			focused: true,
			vimEnabled: false,
		});

		releaseA();
		expect(keymaps.context.editor).toBe(true);

		releaseB();
		expect(keymaps.context.editor).toBeUndefined();
	});

	it("keeps the vim mode when an older editor lets go after a newer one claimed", () => {
		const keymaps = fakeKeymaps();
		const cmA = fakeCm();
		const cmB = fakeCm();

		const releaseA = claimEditorKeymapContexts(keymaps, {
			focused: true,
			vimEnabled: true,
			cm: cmA,
		});
		const releaseB = claimEditorKeymapContexts(keymaps, {
			focused: true,
			vimEnabled: true,
			cm: cmB,
		});

		// A's listener is still attached but its claim is stale: a mode
		// change on the old editor must not write into the contexts.
		cmA.emit("insert");
		expect(keymaps.context.vim_mode).toBe("normal");

		releaseA();
		expect(keymaps.context.vim_mode).toBe("normal");

		cmB.emit("insert");
		expect(keymaps.context.vim_mode).toBe("insert");

		releaseB();
		expect(keymaps.context.vim_mode).toBeUndefined();
	});

	it("keeps editorFocused when an older editor lets go after a newer one claimed", () => {
		const keymaps = fakeKeymaps();
		const rootA = fakeRoot();
		const rootB = fakeRoot();

		const releaseA = claimEditorFocusedContext(keymaps, {
			focused: true,
			root: rootA,
			activeElement: () => null,
		});
		const releaseB = claimEditorFocusedContext(keymaps, {
			focused: true,
			root: rootB,
			activeElement: () => null,
		});

		rootB.emit("focusin");
		expect(keymaps.context.editorFocused).toBe(true);

		// A's listeners are still attached but its claim is stale: a focus
		// event on the old root must not clear the newer editor's context.
		rootA.emit("focusout", { relatedTarget: {} });
		expect(keymaps.context.editorFocused).toBe(true);

		releaseA();
		expect(keymaps.context.editorFocused).toBe(true);

		releaseB();
		expect(keymaps.context.editorFocused).toBeUndefined();
	});
});
