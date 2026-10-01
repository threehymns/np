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
