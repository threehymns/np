import { EditorView } from "@codemirror/view";
import type { Compartment } from "@codemirror/state";

/**
 * The focus-sensitive state of an editor lives here, so that the rule "only
 * the editor the user is typing in owns it" is stated once.
 *
 * An editor in a pane that does not have focus is still a live view of its
 * document: it keeps its content, its language and its completions in sync,
 * because a pane the user cannot see the point of would be a frozen copy.
 * What such an editor does not own is the focus-sensitive state: word wrap,
 * vim mode and the global keymap contexts. Those belong to the focused editor
 * alone. Word wrap and vim mode are per editor, but the keymap contexts are
 * global, so a second editor that claimed them would take the focused
 * editor's keybindings with it when it let go.
 */

/** The part of an editor view the focus state drives: a dispatch. */
export interface FocusableView {
	dispatch(spec: { effects?: unknown }): void;
}

/** The part of the keymap registry an editor needs to claim its contexts. */
export interface KeymapContextOwner {
	setContext(key: string, value: string | boolean | undefined): void;
}

/**
 * The part of an editor view's DOM root the focus context needs: it has to
 * know whether the document's active element is inside it, and it has to hear
 * about focus moving in and out.
 */
export interface FocusContextRoot {
	contains(node: unknown): boolean;
	addEventListener(type: string, handler: (event: any) => void): void;
	removeEventListener(type: string, handler: (event: any) => void): void;
}

/**
 * The part of the vim extension's CodeMirror instance that reports the mode
 * the user is in.
 */
export interface VimModeSource {
	on(type: string, handler: (args: { mode: string }) => void): void;
	off(type: string, handler: (args: { mode: string }) => void): void;
}

/**
 * Apply the word-wrap preference to an editor.
 *
 * Only the focused editor follows the preference. An editor in another pane
 * of a split keeps the wrapping it had, and takes the current preference when
 * it is focused.
 */
export function applyEditorWrap(
	view: FocusableView | null | undefined,
	options: { focused: boolean; wrap: boolean; compartment: Compartment },
): void {
	if (!view || !options.focused) return;

	view.dispatch({
		effects: options.compartment.reconfigure(
			options.wrap ? EditorView.lineWrapping : [],
		),
	});
}

/**
 * Claim the "editor" and "vim_mode" keymap contexts for the focused editor.
 *
 * The keymap registry holds one set of contexts for the whole application, so
 * exactly one editor may own them. The editor in the focused pane owns them.
 * An editor in another pane of a split claims nothing, because a second owner
 * would clear the contexts when it let go and take the focused editor's
 * keybindings down with it.
 *
 * The returned function releases the contexts. It is safe to call when
 * nothing was claimed.
 */
export function claimEditorKeymapContexts(
	keymaps: KeymapContextOwner,
	options: {
		focused: boolean;
		vimEnabled: boolean;
		cm?: VimModeSource | null;
	},
): () => void {
	if (!options.focused) {
		return () => {};
	}

	keymaps.setContext("editor", true);

	const cm = options.vimEnabled ? (options.cm ?? null) : null;
	const onModeChange = (args: { mode: string }) => {
		keymaps.setContext("vim_mode", args.mode);
	};

	if (options.vimEnabled) {
		keymaps.setContext("vim_mode", "normal");
		if (cm) cm.on("vim-mode-change", onModeChange);
	} else {
		keymaps.setContext("vim_mode", undefined);
	}

	return () => {
		if (cm) cm.off("vim-mode-change", onModeChange);
		keymaps.setContext("editor", undefined);
		keymaps.setContext("vim_mode", undefined);
	};
}

/**
 * Claim the "editorFocused" context for the focused editor.
 *
 * The context says the editor really holds the focus. A hover tooltip never
 * takes focus, so a selection inside a tooltip reads here as "unfocused" and
 * falls through to native copy instead of being hijacked into the editor's
 * copy command. Movement within the editor, such as into the search panel
 * that lives in the editor root, keeps the context: only leaving the root
 * clears it.
 *
 * Only the focused editor owns this context, the same way it owns the
 * "editor" and "vim_mode" contexts. In a split, every pane renders a live
 * editor, and a second owner would clear the focused editor's context the
 * moment it let go.
 *
 * The returned function releases the context. It is safe to call when nothing
 * was claimed.
 */
export function claimEditorFocusedContext(
	keymaps: KeymapContextOwner,
	options: {
		focused: boolean;
		root: FocusContextRoot | null | undefined;
		/** The document's active element, or null when there is none. */
		activeElement: () => unknown;
	},
): () => void {
	if (!options.focused || !options.root) {
		return () => {};
	}

	const root = options.root;
	const syncFocus = () => {
		const active = options.activeElement();
		if (active && root.contains(active)) {
			keymaps.setContext("editorFocused", true);
		} else {
			keymaps.setContext("editorFocused", undefined);
		}
	};
	const onFocusIn = () => {
		keymaps.setContext("editorFocused", true);
	};
	const onFocusOut = (event: { relatedTarget?: unknown }) => {
		const next = event.relatedTarget;
		if (next && root.contains(next)) return;
		keymaps.setContext("editorFocused", undefined);
	};

	syncFocus();
	root.addEventListener("focusin", onFocusIn);
	root.addEventListener("focusout", onFocusOut);

	return () => {
		root.removeEventListener("focusin", onFocusIn);
		root.removeEventListener("focusout", onFocusOut);
		keymaps.setContext("editorFocused", undefined);
	};
}
