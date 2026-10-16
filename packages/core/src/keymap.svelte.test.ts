import "../../../tests/contract/rune-setup";
import { describe, it, expect, afterEach } from "bun:test";
import { parseKeySequence, formatShortcutLabel, keystrokesEqual, KeymapRegistry, defaultKeymap } from "./keymap.svelte";

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

describe("completion trigger and acceptance keybindings (Issue #287)", () => {
	function newCompletionRegistry(initialCommands?: Record<string, { action?: () => any; isEnabled?: () => boolean }>) {
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
		return { reg, executed, commandMap, appState };
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

	it("binds ctrl+space to edit.complete and enter to edit.acceptCompletion when vim is off", () => {
		const { reg, executed } = newCompletionRegistry();
		reg.setContext("editor", true);

		// Trigger completion via ctrl+space
		const triggerKey = keyEvent(" ", { ctrl: true });
		expect(reg.handleKeydown(triggerKey.e)).toBe(true);
		expect(executed).toEqual(["edit.complete"]);
		expect(triggerKey.prevented()).toBe(1);

		// Accept completion via Enter
		const acceptKey = keyEvent("Enter");
		expect(reg.handleKeydown(acceptKey.e)).toBe(true);
		expect(executed).toEqual(["edit.complete", "edit.acceptCompletion"]);
		expect(acceptKey.prevented()).toBe(1);
	});

	it("binds ctrl+space to edit.complete and ctrl+y to edit.acceptCompletion in vim insert mode", () => {
		const { reg, executed } = newCompletionRegistry();
		reg.setContext("editor", true);
		reg.setContext("vim_mode", "insert");

		// Trigger via ctrl+space
		const triggerKey = keyEvent(" ", { ctrl: true });
		expect(reg.handleKeydown(triggerKey.e)).toBe(true);
		expect(executed).toEqual(["edit.complete"]);

		// Enter is NOT bound to accept in vim insert mode (belongs to mode as newline)
		const enterKey = keyEvent("Enter");
		expect(reg.handleKeydown(enterKey.e)).toBe(false);
		expect(enterKey.prevented()).toBe(0);

		// Ctrl-y accepts completion in vim insert mode
		const acceptKey = keyEvent("y", { ctrl: true });
		expect(reg.handleKeydown(acceptKey.e)).toBe(true);
		expect(executed).toEqual(["edit.complete", "edit.acceptCompletion"]);
	});

	it("does not bind completion trigger or accept keys in vim normal mode", () => {
		const { reg, executed } = newCompletionRegistry();
		reg.setContext("editor", true);
		reg.setContext("vim_mode", "normal");

		const triggerKey = keyEvent(" ", { ctrl: true });
		expect(reg.handleKeydown(triggerKey.e)).toBe(false);
		expect(triggerKey.prevented()).toBe(0);

		const enterKey = keyEvent("Enter");
		expect(reg.handleKeydown(enterKey.e)).toBe(false);
		expect(enterKey.prevented()).toBe(0);

		const ctrlYKey = keyEvent("y", { ctrl: true });
		expect(reg.handleKeydown(ctrlYKey.e)).toBe(false);
		expect(ctrlYKey.prevented()).toBe(0);

		expect(executed).toEqual([]);
	});

	it("allows user keymap to rebind trigger and acceptance keys", () => {
		const { reg, executed } = newCompletionRegistry();
		reg.setContext("editor", true);

		// User overrides: rebind trigger to alt+/ and accept to tab
		reg.reloadUserKeymap(JSON.stringify([
			{
				context: "editor && !vim_mode",
				bindings: {
					"alt+/": "edit.complete",
					"tab": "edit.acceptCompletion",
					"ctrl+space": "",
					"enter": ""
				}
			}
		]));

		// Old keys no longer execute completion commands
		const oldTrigger = keyEvent(" ", { ctrl: true });
		expect(reg.handleKeydown(oldTrigger.e)).toBe(false);
		expect(oldTrigger.prevented()).toBe(0);

		const oldAccept = keyEvent("Enter");
		expect(reg.handleKeydown(oldAccept.e)).toBe(false);
		expect(oldAccept.prevented()).toBe(0);

		// Rebound keys execute completion commands
		const newTrigger = keyEvent("/", { alt: true });
		expect(reg.handleKeydown(newTrigger.e)).toBe(true);
		expect(executed).toEqual(["edit.complete"]);
		expect(newTrigger.prevented()).toBe(1);

		const newAccept = keyEvent("Tab");
		expect(reg.handleKeydown(newAccept.e)).toBe(true);
		expect(executed).toEqual(["edit.complete", "edit.acceptCompletion"]);
		expect(newAccept.prevented()).toBe(1);
	});

	it("does not swallow keystrokes for unbindings or stale disabled-plugin bindings", () => {
		const { reg } = newCompletionRegistry();
		reg.setContext("editor", true);

		// User unbinds enter and binds ctrl+e to a disabled plugin command
		reg.reloadUserKeymap(JSON.stringify([
			{
				context: "editor && !vim_mode",
				bindings: {
					"enter": "",
					"ctrl+e": "disabledPlugin.action",
					"ctrl+w": "none"
				}
			}
		]));

		// Empty unbinding does not swallow Enter
		const enterKey = keyEvent("Enter");
		expect(reg.handleKeydown(enterKey.e)).toBe(false);
		expect(enterKey.prevented()).toBe(0);

		// 'none' unbinding does not swallow Ctrl-W
		const ctrlWKey = keyEvent("w", { ctrl: true });
		expect(reg.handleKeydown(ctrlWKey.e)).toBe(false);
		expect(ctrlWKey.prevented()).toBe(0);

		// Stale command belonging to a disabled plugin does not swallow Ctrl-E
		const ctrlEKey = keyEvent("e", { ctrl: true });
		expect(reg.handleKeydown(ctrlEKey.e)).toBe(false);
		expect(ctrlEKey.prevented()).toBe(0);
	});

	it("does not swallow accept key when no completion is active (action returns false)", () => {
		const { reg, executed } = newCompletionRegistry({
			// When no completion popup is open, acceptCompletion returns false
			"edit.acceptCompletion": { action: () => false }
		});
		reg.setContext("editor", true);

		const enterKey = keyEvent("Enter");
		// Returns false and does not prevent default, so Enter creates a newline
		expect(reg.handleKeydown(enterKey.e)).toBe(false);
		expect(enterKey.prevented()).toBe(0);
		expect(executed).toEqual(["edit.acceptCompletion"]);
	});
});
