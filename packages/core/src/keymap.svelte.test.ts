import "../../../tests/contract/rune-setup";
import { describe, it, expect, afterEach } from "bun:test";
import { parseKeySequence, formatShortcutLabel, keystrokesEqual, KeymapRegistry, defaultKeymap } from "./keymap.svelte";
import { CommandRegistry, registerCoreCommands } from "./commands.svelte";

/**
 * The formatter and the parser must agree about the same vocabulary.
 *
 * `formatShortcutLabel` renders `cmd+shift+p` as `⌘⇧P` on macOS. If a user then
 * hand-writes that rendered label into their keymap JSON — which ADR 0003 explicitly
 * invites ("Users must be able to override default keybindings via a JSON
 * configuration file") — `parseKeySequence` must read it back as the same binding.
 * Today it does not: it treats the whole glyph run as one literal key name.
 */

// `navigator.platform` is a readonly getter in Bun, so the only seam is a whole
// global `navigator` stub. Restore whatever was there after every test.
const g = globalThis as any;
const hadNavigator = 'navigator' in g;
const savedNavigator = hadNavigator ? g.navigator : undefined;

function withPlatform(p: string) {
	Object.defineProperty(g, 'navigator', { value: { platform: p }, configurable: true, writable: true });
}
function restoreNavigator() {
	if (hadNavigator) {
		Object.defineProperty(g, 'navigator', { value: savedNavigator, configurable: true, writable: true });
	} else {
		delete g.navigator;
	}
}

afterEach(() => {
	restoreNavigator();
});

describe("macOS shortcut labels round-trip through the parser", () => {
	it("reads back a label the formatter produced for itself", () => {
		withPlatform('MacIntel');

		const original = parseKeySequence("cmd+shift+p");
		const label = formatShortcutLabel("cmd+shift+p");
		expect(label).toBe("⌘⇧P");

		const reparsed = parseKeySequence(label);
		expect(reparsed).toHaveLength(1);
		expect(keystrokesEqual(reparsed[0]!, original[0]!)).toBe(true);
		expect(reparsed[0]!.meta).toBe(true);
		expect(reparsed[0]!.shift).toBe(true);
		expect(reparsed[0]!.key).toBe("p");
	});

	it("does not treat the ⌘ glyph as a literal key name", () => {
		withPlatform('MacIntel');

		const [k] = parseKeySequence("⌘K");
		expect(k!.meta).toBe(true);
		expect(k!.key).toBe("k");
	});

	it("does not treat the ⌃ glyph as a literal key name", () => {
		withPlatform('MacIntel');

		const [k] = parseKeySequence("⌃K");
		expect(k!.ctrl).toBe(true);
		expect(k!.key).toBe("k");
	});

	it("does not treat the ⌥ glyph as a literal key name", () => {
		withPlatform('MacIntel');

		const [k] = parseKeySequence("⌘⌥I");
		expect(k!.meta).toBe(true);
		expect(k!.alt).toBe(true);
		expect(k!.key).toBe("i");
	});

	it("does not treat the ⇧ glyph as a literal key name", () => {
		withPlatform('MacIntel');

		const [k] = parseKeySequence("⇧Z");
		expect(k!.shift).toBe(true);
		expect(k!.key).toBe("z");
	});

	it("keeps the chord separator working in glyph form", () => {
		withPlatform('MacIntel');

		const chord = parseKeySequence(formatShortcutLabel("cmd+k m"));
		expect(chord).toHaveLength(2);
		expect(chord[0]!.meta).toBe(true);
		expect(chord[0]!.key).toBe("k");
		expect(chord[1]!.key).toBe("m");
	});

	it("reads a hand-written glyph binding with punctuation", () => {
		withPlatform('MacIntel');

		const [comma] = parseKeySequence("⌘,");
		expect(comma!.meta).toBe(true);
		expect(comma!.key).toBe(",");
	});

	it("reads a hand-written glyph binding for backslash", () => {
		withPlatform('MacIntel');

		const [bslash] = parseKeySequence("⌘\\");
		expect(bslash!.meta).toBe(true);
		expect(bslash!.key).toBe("\\");
	});

	it("still parses the word forms it always accepted", () => {
		withPlatform('MacIntel');

		const [k] = parseKeySequence("cmd+shift+p");
		expect(k!.meta).toBe(true);
		expect(k!.shift).toBe(true);
		expect(k!.key).toBe("p");
	});

	it("carries all four modifiers in one glyph run", () => {
		withPlatform('MacIntel');

		const original = parseKeySequence("cmd+ctrl+alt+shift+p");
		const label = formatShortcutLabel("cmd+ctrl+alt+shift+p");
		expect(label).toBe("⌘⌃⌥⇧P");

		const [k] = parseKeySequence(label);
		expect(keystrokesEqual(k!, original[0]!)).toBe(true);
		expect([k!.meta, k!.ctrl, k!.alt, k!.shift]).toEqual([true, true, true, true]);
		expect(k!.key).toBe("p");
	});

	// A glyph that is not a modifier is a key, not a typo to be papered over with
	// `shift+`. This is the guard on the glyph table: if a glyph is ever added to the
	// set of things the parser rewrites, it must arrive with a mapping, or this fails
	// instead of silently producing a shift binding.
	it("leaves a non-modifier glyph as a literal key with no modifiers", () => {
		withPlatform('MacIntel');

		const [backspace] = parseKeySequence("⌫");
		expect(backspace!.key).toBe("⌫");
		expect([backspace!.meta, backspace!.ctrl, backspace!.alt, backspace!.shift]).toEqual([false, false, false, false]);
	});
});

describe("glyph bindings stay portable across platforms", () => {
	// A keymap file is portable text, and the word form already normalizes: `cmd` on
	// Linux/Windows is read as `ctrl` by the modifier loop. The glyph form must
	// normalize identically, or the same file behaves differently depending on how the
	// user happened to write the modifier.
	it("reads ⌘K as ctrl+k on a non-mac platform", () => {
		withPlatform('Win32');

		const [k] = parseKeySequence("⌘K");
		expect(k!.ctrl).toBe(true);
		expect(k!.meta).toBe(false);
		expect(k!.key).toBe("k");
	});

	it("agrees with the word form on a non-mac platform", () => {
		withPlatform('Win32');

		const [glyphed] = parseKeySequence("⌘⇧P");
		const [worded] = parseKeySequence("cmd+shift+p");
		expect(keystrokesEqual(glyphed!, worded!)).toBe(true);
	});
});

describe("non-mac rendering stays spelled out", () => {
	it("does not emit mac glyphs on a non-mac platform", () => {
		withPlatform('Win32');

		const label = formatShortcutLabel("cmd+shift+p");
		expect(label).not.toContain("⌘");
		expect(label).not.toContain("⇧");
		expect(label).not.toContain("⌥");
		expect(label).not.toContain("⌃");
	});
});

/**
 * Abandoning a chord must not eat the next character the user types.
 *
 * `space` opens 17 different chords in vim normal mode. If the user presses it and then
 * changes their mind, the first real keystroke is consumed by the chord logic:
 * `handleKeydown` returns true and calls `preventDefault`, so the character never reaches
 * the editor. With no buffer pending the same key returns false and types normally, which
 * is the control that makes the difference observable.
 *
 * There is also no timeout anywhere in keymap.svelte.ts, so the buffer persists until a
 * keypress clears it — which means this is a real cost, not a momentary one.
 */
describe("abandoning a chord does not swallow the next keystroke", () => {
	function newRegistry() {
		const executed: string[] = [];
		const appState: any = {
			commands: {
				get: (id: string) => ({ id, action: () => executed.push(id) }),
				execute: (id: string) => {
					executed.push(id);
					return true;
				},
			},
			workspace: {},
		};
		const reg = new KeymapRegistry(appState);
		reg.loadBindings(defaultKeymap as any);
		reg.setContext("editor", "true");
		reg.setContext("vim_mode", "normal");
		return { reg, executed };
	}

	function keyEvent(key: string, mods: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) {
		let prevented = 0;
		const e = {
			key,
			metaKey: mods.meta ?? false,
			ctrlKey: mods.ctrl ?? false,
			altKey: mods.alt ?? false,
			shiftKey: mods.shift ?? false,
			preventDefault: () => {
				prevented++;
			},
			stopPropagation: () => {},
		} as unknown as KeyboardEvent;
		return { e, prevented: () => prevented };
	}

	it("passes an unrelated key through when no chord is pending", () => {
		withPlatform('MacIntel');
		const { reg } = newRegistry();

		// 'q' starts no binding, so with an empty buffer it must reach the editor.
		const k = keyEvent("q");
		expect(reg.handleKeydown(k.e)).toBe(false);
		expect(k.prevented()).toBe(0);
	});

	it("does not consume the next key when a chord is abandoned", () => {
		withPlatform('MacIntel');
		const { reg } = newRegistry();

		reg.handleKeydown(keyEvent(" ").e); // open the chord
		expect(reg.keyBuffer).toHaveLength(1);

		const k = keyEvent("q");
		// The buffer is discarded, but 'q' must still be the user's 'q'.
		reg.handleKeydown(k.e);

		expect(reg.keyBuffer).toHaveLength(0);
		expect(k.prevented()).toBe(0);
	});

	it("still completes a real chord after the change", () => {
		withPlatform('MacIntel');
		const { reg, executed } = newRegistry();

		reg.handleKeydown(keyEvent(" ").e);
		reg.handleKeydown(keyEvent("f").e);
		reg.handleKeydown(keyEvent("n").e);

		expect(executed).toEqual(["file.new"]);
		expect(reg.keyBuffer).toHaveLength(0);
	});

	it("still lets a non-matching key cancel a pending chord", () => {
		withPlatform('MacIntel');
		const { reg, executed } = newRegistry();

		reg.handleKeydown(keyEvent(" ").e);
		reg.handleKeydown(keyEvent("`").e);

		expect(reg.keyBuffer).toHaveLength(0);
		expect(executed).toEqual([]);
	});

	// The key that abandons a chord is the user's key, not the chord's. It must be
	// re-evaluated as the first keystroke of a *new* binding, otherwise the only
	// capture listener in the app (`AppShell.svelte`) has already been told
	// "not mine" and the binding silently never fires.
	it("re-evaluates the abandoning key as the first key of a new binding", () => {
		withPlatform('MacIntel');
		const { reg, executed } = newRegistry();

		reg.handleKeydown(keyEvent(" ").e); // open a chord
		expect(reg.keyBuffer).toHaveLength(1);

		// cmd+f is a single-key global binding, so it can never be a continuation
		// of the pending `space` chord — it is purely a fresh binding.
		reg.handleKeydown(keyEvent("f", { meta: true }).e);

		expect(executed).toEqual(["edit.find"]);
		expect(reg.keyBuffer).toHaveLength(0);
	});

	it("opens a new chord when the abandoning key starts one", () => {
		withPlatform('MacIntel');
		const { reg, executed } = newRegistry();

		reg.handleKeydown(keyEvent(" ").e); // open a chord
		// `cmd+k m` is a chord; `cmd+k` cannot follow the pending `space`.
		reg.handleKeydown(keyEvent("k", { meta: true }).e);

		expect(executed).toEqual([]);
		expect(reg.keyBuffer).toHaveLength(1);
		expect(reg.keyBuffer[0]!.key).toBe("k");
	});
});

/**
 * Clipboard bindings are focus-scoped, not merely tab-scoped.
 *
 * The `editor` context stays true for the whole active tab, including while
 * the user mouse-selects text in a hover tooltip — which never takes focus,
 * so the editor's own selection is typically collapsed there. Firing
 * `edit.copy` into that state kills the native copy (preventDefault) and
 * then copies nothing (empty editor selection): the keystroke is swallowed.
 * Scoping cut/copy/paste to `editor && editorFocused` lets a tooltip
 * selection fall through to the browser instead.
 */
describe("clipboard bindings respect editor focus", () => {
	function newClipboardRegistry(focused: boolean) {
		const executed: string[] = [];
		const appState: any = {
			commands: {
				get: (id: string) => ({ id, action: () => executed.push(id) }),
				execute: (id: string) => {
					executed.push(id);
					return true;
				},
			},
			workspace: {},
		};
		const reg = new KeymapRegistry(appState);
		reg.loadBindings(defaultKeymap as any);
		reg.setContext("editor", true);
		if (focused) reg.setContext("editorFocused", true);
		return { reg, executed };
	}

	function clipboardKeyEvent(key: string, mods: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) {
		let prevented = 0;
		const e = {
			key,
			metaKey: mods.meta ?? false,
			ctrlKey: mods.ctrl ?? false,
			altKey: mods.alt ?? false,
			shiftKey: mods.shift ?? false,
			target: { tagName: "DIV" },
			preventDefault: () => {
				prevented++;
			},
			stopPropagation: () => {},
		} as unknown as KeyboardEvent;
		return { e, prevented: () => prevented };
	}

	for (const [key, command] of [
		["c", "edit.copy"],
		["x", "edit.cut"],
		["v", "edit.paste"],
	] as const) {
		it(`ctrl+${key} fires ${command} when the editor is focused`, () => {
			withPlatform("Win32");
			const { reg, executed } = newClipboardRegistry(true);

			const k = clipboardKeyEvent(key, { ctrl: true });
			expect(reg.handleKeydown(k.e)).toBe(true);
			expect(k.prevented()).toBe(1);
			expect(executed).toEqual([command]);
		});

		it(`ctrl+${key} passes through when the tab is active but unfocused`, () => {
			withPlatform("Win32");
			const { reg, executed } = newClipboardRegistry(false);

			// Tab-active, focus elsewhere (e.g. a tooltip selection): the
			// browser's native clipboard handling must survive untouched.
			const k = clipboardKeyEvent(key, { ctrl: true });
			expect(reg.handleKeydown(k.e)).toBe(false);
			expect(k.prevented()).toBe(0);
			expect(executed).toEqual([]);
		});
	}
});

describe("completion trigger and acceptance keybindings (Issue #287)", () => {
	/**
	 * A registry with the completion commands registered.
	 *
	 * `focused` mirrors the `editorFocused` context the editor sets: the
	 * `editor` context alone is tab-scoped, so it stays true while the user
	 * is interacting with something that never takes focus, such as a hover
	 * tooltip. The completion bindings are focus-scoped, so the default here
	 * is a focused editor and the focus test asks for an unfocused one.
	 */
	function newCompletionRegistry(
		initialCommands?: Record<string, { action?: () => any; isEnabled?: () => boolean }>,
		focused = true,
	) {
		const executed: string[] = [];
		const defaultCommands: Record<string, any> = {
			"edit.complete": { action: () => true },
			"edit.acceptCompletion": { action: () => true },
			"edit.find": { action: () => true },
			...initialCommands,
		};
		const commandMap = new Map<string, any>(Object.entries(defaultCommands));
		const appState: any = {
			commands: {
				get: (id: string) => commandMap.get(id),
				execute: (id: string) => {
					executed.push(id);
					const cmd = commandMap.get(id);
					if (cmd && typeof cmd.action === 'function') {
						return cmd.action();
					}
					return true;
				},
			},
			workspace: {},
		};
		const reg = new KeymapRegistry(appState);
		reg.loadBindings(defaultKeymap as any);
		reg.setContext("editor", true);
		if (focused) reg.setContext("editorFocused", true);
		return { reg, executed, commandMap, appState };
	}

	function completionKeyEvent(key: string, mods: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) {
		let prevented = 0;
		let stopped = 0;
		const e = {
			key,
			metaKey: mods.meta ?? false,
			ctrlKey: mods.ctrl ?? false,
			altKey: mods.alt ?? false,
			shiftKey: mods.shift ?? false,
			preventDefault: () => {
				prevented++;
			},
			stopPropagation: () => {
				stopped++;
			},
		} as unknown as KeyboardEvent;
		return { e, prevented: () => prevented, stopped: () => stopped };
	}

	it("binds ctrl+space to edit.complete and enter to edit.acceptCompletion when vim is off", () => {
		const { reg, executed } = newCompletionRegistry();

		// Trigger completion via ctrl+space
		const triggerKey = completionKeyEvent(" ", { ctrl: true });
		expect(reg.handleKeydown(triggerKey.e)).toBe(true);
		expect(executed).toEqual(["edit.complete"]);
		expect(triggerKey.prevented()).toBe(1);

		// Accept completion via Enter
		const acceptKey = completionKeyEvent("Enter");
		expect(reg.handleKeydown(acceptKey.e)).toBe(true);
		expect(executed).toEqual(["edit.complete", "edit.acceptCompletion"]);
		expect(acceptKey.prevented()).toBe(1);
	});

	it("binds ctrl+space to edit.complete and ctrl+y to edit.acceptCompletion in vim insert mode", () => {
		const { reg, executed } = newCompletionRegistry();
		reg.setContext("vim_mode", "insert");

		// Trigger via ctrl+space
		const triggerKey = completionKeyEvent(" ", { ctrl: true });
		expect(reg.handleKeydown(triggerKey.e)).toBe(true);
		expect(executed).toEqual(["edit.complete"]);

		// Enter is NOT bound to accept in vim insert mode (belongs to mode as newline)
		const enterKey = completionKeyEvent("Enter");
		expect(reg.handleKeydown(enterKey.e)).toBe(false);
		expect(enterKey.prevented()).toBe(0);

		// Ctrl-y accepts completion in vim insert mode
		const acceptKey = completionKeyEvent("y", { ctrl: true });
		expect(reg.handleKeydown(acceptKey.e)).toBe(true);
		expect(executed).toEqual(["edit.complete", "edit.acceptCompletion"]);
	});

	it("does not bind completion trigger or accept keys in vim normal mode", () => {
		const { reg, executed } = newCompletionRegistry();
		reg.setContext("vim_mode", "normal");

		const triggerKey = completionKeyEvent(" ", { ctrl: true });
		expect(reg.handleKeydown(triggerKey.e)).toBe(false);
		expect(triggerKey.prevented()).toBe(0);

		const enterKey = completionKeyEvent("Enter");
		expect(reg.handleKeydown(enterKey.e)).toBe(false);
		expect(enterKey.prevented()).toBe(0);

		const ctrlYKey = completionKeyEvent("y", { ctrl: true });
		expect(reg.handleKeydown(ctrlYKey.e)).toBe(false);
		expect(ctrlYKey.prevented()).toBe(0);

		expect(executed).toEqual([]);
	});

	it("allows user keymap to rebind trigger and acceptance keys", () => {
		const { reg, executed } = newCompletionRegistry();

		// User overrides: rebind trigger to alt+/ and accept to tab
		reg.reloadUserKeymap(JSON.stringify([
			{
				context: "editor && editorFocused && !vim_mode",
				bindings: {
					"alt+/": "edit.complete",
					"tab": "edit.acceptCompletion",
					"ctrl+space": "",
					"enter": ""
				}
			}
		]));

		// Old keys no longer execute completion commands
		const oldTrigger = completionKeyEvent(" ", { ctrl: true });
		expect(reg.handleKeydown(oldTrigger.e)).toBe(false);
		expect(oldTrigger.prevented()).toBe(0);

		const oldAccept = completionKeyEvent("Enter");
		expect(reg.handleKeydown(oldAccept.e)).toBe(false);
		expect(oldAccept.prevented()).toBe(0);

		// Rebound keys execute completion commands
		const newTrigger = completionKeyEvent("/", { alt: true });
		expect(reg.handleKeydown(newTrigger.e)).toBe(true);
		expect(executed).toEqual(["edit.complete"]);
		expect(newTrigger.prevented()).toBe(1);

		const newAccept = completionKeyEvent("Tab");
		expect(reg.handleKeydown(newAccept.e)).toBe(true);
		expect(executed).toEqual(["edit.complete", "edit.acceptCompletion"]);
		expect(newAccept.prevented()).toBe(1);
	});

	it("does not swallow keystrokes for unbindings or stale disabled-plugin bindings", () => {
		const { reg } = newCompletionRegistry();

		// User unbinds enter and binds ctrl+e to a disabled plugin command
		reg.reloadUserKeymap(JSON.stringify([
			{
				context: "editor && editorFocused && !vim_mode",
				bindings: {
					"enter": "",
					"ctrl+e": "disabledPlugin.action",
					"ctrl+w": "none"
				}
			}
		]));

		// Empty unbinding does not swallow Enter
		const enterKey = completionKeyEvent("Enter");
		expect(reg.handleKeydown(enterKey.e)).toBe(false);
		expect(enterKey.prevented()).toBe(0);

		// 'none' unbinding does not swallow Ctrl-W
		const ctrlWKey = completionKeyEvent("w", { ctrl: true });
		expect(reg.handleKeydown(ctrlWKey.e)).toBe(false);
		expect(ctrlWKey.prevented()).toBe(0);

		// Stale command belonging to a disabled plugin does not swallow Ctrl-E
		const ctrlEKey = completionKeyEvent("e", { ctrl: true });
		expect(reg.handleKeydown(ctrlEKey.e)).toBe(false);
		expect(ctrlEKey.prevented()).toBe(0);
	});

	it("does not swallow accept key when no completion is active (action returns false)", () => {
		const { reg, executed } = newCompletionRegistry({
			// When no completion popup is open, acceptCompletion returns false
			"edit.acceptCompletion": { action: () => false }
		});

		const enterKey = completionKeyEvent("Enter");
		// Returns false and does not prevent default, so Enter creates a newline
		expect(reg.handleKeydown(enterKey.e)).toBe(false);
		expect(enterKey.prevented()).toBe(0);
		expect(executed).toEqual(["edit.acceptCompletion"]);
	});

	it("does not intercept IME composition keystrokes (isComposing / keyCode 229)", () => {
		const { reg, executed } = newCompletionRegistry();

		// macOS Chromium/WebKit report the Enter that confirms an IME
		// composition as key "Enter" with isComposing true. The keymap must
		// not steal it for edit.acceptCompletion and drop the candidate.
		const composing = completionKeyEvent("Enter");
		(composing.e as any).isComposing = true;
		expect(reg.handleKeydown(composing.e)).toBe(false);
		expect(composing.prevented()).toBe(0);
		expect(executed).toEqual([]);

		// Other platforms fire composition keydowns with keyCode 229.
		const legacy = completionKeyEvent("Enter");
		(legacy.e as any).keyCode = 229;
		expect(reg.handleKeydown(legacy.e)).toBe(false);
		expect(legacy.prevented()).toBe(0);
		expect(executed).toEqual([]);
	});

	/**
	 * The trigger and the acceptance key are focus-scoped, and the reason is
	 * the shape of the two overlays: the completion popup is an overlay exactly
	 * like the hover tooltip, and the `editor` context stays true for the
	 * whole active tab, including while the user selects text in a tooltip
	 * (which never takes focus). An overlay must not open another overlay on
	 * top of itself, so the trigger waits for real focus.
	 */
	it("does not trigger or accept a completion while the editor is not focused", () => {
		const { reg, executed } = newCompletionRegistry(undefined, false);

		const triggerKey = completionKeyEvent(" ", { ctrl: true });
		expect(reg.handleKeydown(triggerKey.e)).toBe(false);
		expect(triggerKey.prevented()).toBe(0);

		const acceptKey = completionKeyEvent("Enter");
		expect(reg.handleKeydown(acceptKey.e)).toBe(false);
		expect(acceptKey.prevented()).toBe(0);

		expect(executed).toEqual([]);
	});

	it("does not trigger or accept a completion while the editor is not focused in vim insert mode", () => {
		const { reg, executed } = newCompletionRegistry(undefined, false);
		reg.setContext("vim_mode", "insert");

		const triggerKey = completionKeyEvent(" ", { ctrl: true });
		expect(reg.handleKeydown(triggerKey.e)).toBe(false);
		expect(triggerKey.prevented()).toBe(0);

		const acceptKey = completionKeyEvent("y", { ctrl: true });
		expect(reg.handleKeydown(acceptKey.e)).toBe(false);
		expect(acceptKey.prevented()).toBe(0);

		expect(executed).toEqual([]);
	});
});

describe("completion commands require editor focus even for context-less bindings", () => {
	/**
	 * A registry with the REAL completion commands registered.
	 *
	 * The default bindings already carry `editorFocused` in their context,
	 * so they cannot show the gap: a context-less user binding (exactly
	 * what setCustomKeybinding stores) has no context filter, and the
	 * command's own isEnabled guard is the only thing standing between
	 * a modal button's Enter and an unfocused editor's completion.
	 */
	function newRealCompletionRegistry(focused: boolean, acceptResult: boolean = true) {
		const commands = new CommandRegistry();
		const appState: any = {
			commands,
			activeEditorView: {},
			workspace: {},
		};
		registerCoreCommands(appState);
		const reg = new KeymapRegistry(appState);
		// The real AppState always wires its keymaps registry; the guard
		// for the completion commands reads focus from it.
		appState.keymaps = reg;
		reg.setContext("editor", true);
		if (focused) reg.setContext("editorFocused", true);
		// Context-less user binding, as setCustomKeybinding stores it.
		reg.loadBindings([{ bindings: { enter: "edit.acceptCompletion" } } as any]);
		// Stub the action: the gate under test is isEnabled, not CodeMirror.
		const cmd: any = commands.get("edit.acceptCompletion");
		let actionRan = false;
		cmd.action = () => { actionRan = true; return acceptResult; };
		return { reg, commands, actionRan: () => actionRan };
	}

	function modalButtonEnterKey() {
		let prevented = 0;
		const e = {
			key: "Enter",
			// A modal button, not an input: the standard-input early return
			// must not be what lets this Enter through.
			target: { tagName: "BUTTON" },
			ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
			isComposing: false, keyCode: 13,
			preventDefault: () => { prevented++; },
			stopPropagation: () => {},
		} as unknown as KeyboardEvent;
		return { e, prevented: () => prevented };
	}

	const COMPLETION_COMMANDS = ["edit.complete", "edit.startCompletion", "edit.acceptCompletion"];

	it("reports all three completion commands disabled while the editor is not focused", () => {
		const { commands } = newRealCompletionRegistry(false);
		for (const id of COMPLETION_COMMANDS) {
			expect(commands.get(id)?.isEnabled?.()).toBe(false);
		}
	});

	it("reports all three completion commands enabled while the editor is focused", () => {
		const { commands } = newRealCompletionRegistry(true);
		for (const id of COMPLETION_COMMANDS) {
			expect(commands.get(id)?.isEnabled?.()).toBe(true);
		}
	});

	it("does not consume a modal button's Enter through a context-less binding while unfocused", () => {
		const { reg, actionRan } = newRealCompletionRegistry(false);
		const key = modalButtonEnterKey();
		expect(reg.handleKeydown(key.e)).toBe(false);
		expect(key.prevented()).toBe(0);
		expect(actionRan()).toBe(false);
	});

	it("executes a context-less binding while the editor is focused", () => {
		const { reg, actionRan } = newRealCompletionRegistry(true);
		const key = modalButtonEnterKey();
		expect(reg.handleKeydown(key.e)).toBe(true);
		expect(key.prevented()).toBe(1);
		expect(actionRan()).toBe(true);
	});

	it("lets Enter fall through when acceptance declines while focused", () => {
		const { reg, actionRan } = newRealCompletionRegistry(true, false);
		const key = modalButtonEnterKey();
		expect(reg.handleKeydown(key.e)).toBe(false);
		expect(key.prevented()).toBe(0);
		expect(actionRan()).toBe(true);
	});
});

describe("Project search keybinding and remapping (Issue #337)", () => {
	function newRegistry() {
		const executed: string[] = [];
		const appState: any = {
			commands: {
				get: (id: string) => ({ id, action: () => executed.push(id) }),
				execute: (id: string) => {
					executed.push(id);
					return true;
				},
			},
			workspace: {},
		};
		const reg = new KeymapRegistry(appState);
		reg.loadBindings(defaultKeymap as any);
		return { reg, executed };
	}

	function searchKeyEvent(key: string, mods: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) {
		let prevented = 0;
		const e = {
			key,
			metaKey: mods.meta ?? false,
			ctrlKey: mods.ctrl ?? false,
			altKey: mods.alt ?? false,
			shiftKey: mods.shift ?? false,
			preventDefault: () => {
				prevented++;
			},
			stopPropagation: () => {},
		} as unknown as KeyboardEvent;
		return { e, prevented: () => prevented };
	}

	it("Cmd+Shift+F triggers edit.findInFiles on macOS", () => {
		withPlatform('MacIntel');
		const { reg, executed } = newRegistry();
		reg.setContext("editor", "true");

		const k = searchKeyEvent("f", { meta: true, shift: true });
		expect(reg.handleKeydown(k.e)).toBe(true);
		expect(executed).toEqual(["edit.findInFiles"]);
		expect(k.prevented()).toBe(1);
	});

	it("Ctrl+Shift+F triggers edit.findInFiles on Linux/Windows", () => {
		withPlatform('Linux x86_64');
		const { reg, executed } = newRegistry();
		reg.setContext("editor", "true");

		const k = searchKeyEvent("f", { ctrl: true, shift: true });
		expect(reg.handleKeydown(k.e)).toBe(true);
		expect(executed).toEqual(["edit.findInFiles"]);
		expect(k.prevented()).toBe(1);
	});

	it("Cmd/Ctrl+Shift+F triggers edit.findInFiles globally outside editor", () => {
		withPlatform('MacIntel');
		const { reg, executed } = newRegistry();

		const k = searchKeyEvent("f", { meta: true, shift: true });
		expect(reg.handleKeydown(k.e)).toBe(true);
		expect(executed).toEqual(["edit.findInFiles"]);
	});

	it("edit.findInFiles is remappable through the existing keymap registry", () => {
		withPlatform('MacIntel');
		const { reg, executed } = newRegistry();

		// Remap edit.findInFiles to ctrl+alt+s via user keymap
		reg.reloadUserKeymap(
			JSON.stringify([
				{
					bindings: {
						"ctrl+alt+s": "edit.findInFiles"
					}
				}
			])
		);

		// New binding triggers command
		const k = searchKeyEvent("s", { ctrl: true, alt: true });
		expect(reg.handleKeydown(k.e)).toBe(true);
		expect(executed).toEqual(["edit.findInFiles"]);

		// Shortcut lookup reflects remapped keybinding
		expect(reg.getShortcutForCommand("edit.findInFiles")).toBe("⌃⌥S");
	});
});

describe("Stale keybinding fallthrough (Issue #225)", () => {
	function newRegistry(registeredCommands: string[] = []) {
		const executed: string[] = [];
		const appState: any = {
			commands: {
				get: (id: string) => registeredCommands.includes(id) ? { id, action: () => executed.push(id) } : undefined,
				execute: (id: string) => {
					if (registeredCommands.includes(id)) {
						executed.push(id);
						return true;
					}
					return undefined;
				},
			},
			workspace: {},
		};
		const reg = new KeymapRegistry(appState);
		reg.loadBindings([
			{
				bindings: {
					"ctrl+s": "test.save",
					// A stale longer chord sharing the same prefix: it must not
					// hold `ctrl+s` hostage while waiting for a command that
					// does not exist.
					"ctrl+s x": "test.saveAll",
					"ctrl+k s": "test.saveAll",
				},
			},
		] as any);
		return { reg, executed };
	}

	function keyEvent(key: string, mods: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) {
		let prevented = 0;
		let stopped = 0;
		const e = {
			key,
			metaKey: mods.meta ?? false,
			ctrlKey: mods.ctrl ?? false,
			altKey: mods.alt ?? false,
			shiftKey: mods.shift ?? false,
			preventDefault: () => {
				prevented++;
			},
			stopPropagation: () => {
				stopped++;
			},
		} as unknown as KeyboardEvent;
		return { e, prevented: () => prevented, stopped: () => stopped };
	}

	it("when a binding points to a command not in appState.commands, handleKeydown returns false and does not call preventDefault", () => {
		const { reg, executed } = newRegistry([]);
		const k = keyEvent("s", { ctrl: true });

		const handled = reg.handleKeydown(k.e);
		expect(handled).toBe(false);
		expect(k.prevented()).toBe(0);
		expect(executed).toEqual([]);
		expect(reg.keyBuffer).toEqual([]);
	});

	it("when a binding points to an active registered command, handleKeydown returns true, calls preventDefault, and executes the command", () => {
		const { reg, executed } = newRegistry(["test.save"]);
		const k = keyEvent("s", { ctrl: true });

		const handled = reg.handleKeydown(k.e);
		expect(handled).toBe(true);
		expect(k.prevented()).toBe(1);
		expect(executed).toEqual(["test.save"]);
		expect(reg.keyBuffer).toEqual([]);
	});

	it("does not consume a chord prefix that only a missing command could complete", () => {
		const { reg, executed } = newRegistry([]);
		// `ctrl+k s` is a stale binding: its command is not registered. Waiting
		// for the `s` would swallow the user's `ctrl+k` for a chord that can
		// never run, so the prefix must fall through immediately.
		const k1 = keyEvent("k", { ctrl: true });
		expect(reg.handleKeydown(k1.e)).toBe(false);
		expect(k1.prevented()).toBe(0);
		expect(reg.keyBuffer).toEqual([]);

		const k2 = keyEvent("s");
		expect(reg.handleKeydown(k2.e)).toBe(false);
		expect(k2.prevented()).toBe(0);
		expect(executed).toEqual([]);
		expect(reg.keyBuffer).toEqual([]);
	});
});
