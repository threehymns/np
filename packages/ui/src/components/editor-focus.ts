import { EditorView } from "@codemirror/view";
import { vim } from "@replit/codemirror-vim";
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
 * Apply the vim-mode preference to an editor.
 *
 * Only the focused editor runs vim mode. The vim extension keeps its own
 * state (the mode, the registers), so it is installed and removed as the
 * focus moves rather than left running in a pane the user is not typing in.
 */
export function applyEditorVim(
	view: FocusableView | null | undefined,
	options: { focused: boolean; vimEnabled: boolean; compartment: Compartment },
): void {
	if (!view || !options.focused) return;

	view.dispatch({
		effects: options.compartment.reconfigure(options.vimEnabled ? vim() : []),
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
