import "../../../tests/contract/rune-setup";
import { describe, it, expect, afterEach } from "bun:test";
import { parseKeySequence, formatShortcutLabel, keystrokesEqual } from "./keymap.svelte";

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
