import "../../../tests/contract/rune-setup";
import { describe, it, expect, mock } from "bun:test";
import { registerCoreCommands, CommandRegistry } from "./commands.svelte";
import { defaultKeymap, parseKeySequence } from "./keymap.svelte";

function createMockAppState() {
	const commands = new CommandRegistry();
	const appState = {
		commands,
		activeDiffNavigator: undefined as
			| { nextHunk(): void; prevHunk(): void }
			| undefined
	};
	registerCoreCommands(appState as any);
	return appState;
}

describe("Hunk navigation commands ('git.nextHunk' / 'git.prevHunk')", () => {
	it("registers both commands under Source Control", () => {
		const appState = createMockAppState();
		const next = appState.commands.get("git.nextHunk");
		const prev = appState.commands.get("git.prevHunk");
		expect(next).toBeDefined();
		expect(prev).toBeDefined();
		expect(next!.category).toBe("Source Control");
		expect(prev!.category).toBe("Source Control");
	});

	it("is disabled without a mounted diff navigator and executes nothing", () => {
		const appState = createMockAppState();
		const next = appState.commands.get("git.nextHunk")!;
		const prev = appState.commands.get("git.prevHunk")!;
		expect(next.isEnabled!()).toBe(false);
		expect(prev.isEnabled!()).toBe(false);
		expect(appState.commands.execute("git.nextHunk")).toBeUndefined();
		expect(appState.commands.execute("git.prevHunk")).toBeUndefined();
	});

	it("dispatches to the mounted navigator, mirroring the header buttons", () => {
		const appState = createMockAppState();
		const nextHunk = mock(() => {});
		const prevHunk = mock(() => {});
		appState.activeDiffNavigator = { nextHunk, prevHunk };

		expect(appState.commands.get("git.nextHunk")!.isEnabled!()).toBe(true);
		appState.commands.execute("git.nextHunk");
		appState.commands.execute("git.prevHunk");
		expect(nextHunk).toHaveBeenCalledTimes(1);
		expect(prevHunk).toHaveBeenCalledTimes(1);
	});
});

describe("Hunk navigation default keybindings", () => {
	it("binds Zed-style ]c / [c in vim normal mode", () => {
		const vimBlock = defaultKeymap.find((b) => b.context === "editor && vim_mode == normal");
		expect(vimBlock).toBeDefined();
		expect(vimBlock!.bindings["] c"]).toBe("git.nextHunk");
		expect(vimBlock!.bindings["[ c"]).toBe("git.prevHunk");
	});

	it("parses ]c / [c into two plain keystrokes", () => {
		expect(parseKeySequence("] c").map((k) => k.key)).toEqual(["]", "c"]);
		expect(parseKeySequence("[ c").map((k) => k.key)).toEqual(["[", "c"]);
		expect(parseKeySequence("] c").some((k) => k.ctrl || k.meta || k.alt)).toBe(false);
	});

	it("binds Zed-style cmd+f8 / cmd+shift+f8 in standard editor and global keymaps", () => {
		const editorBlock = defaultKeymap.find((b) => b.context === "editor");
		expect(editorBlock).toBeDefined();
		expect(editorBlock!.bindings["cmd+f8"]).toBe("git.nextHunk");
		expect(editorBlock!.bindings["cmd+shift+f8"]).toBe("git.prevHunk");

		const globalBlock = defaultKeymap.find((b) => !b.context);
		expect(globalBlock).toBeDefined();
		expect(globalBlock!.bindings["cmd+f8"]).toBe("git.nextHunk");
		expect(globalBlock!.bindings["cmd+shift+f8"]).toBe("git.prevHunk");
	});

	it("parses cmd+f8 and cmd+shift+f8 with correct modifiers", () => {
		const next = parseKeySequence("cmd+f8");
		expect(next).toHaveLength(1);
		expect(next[0].key).toBe("f8");
		expect(next[0].ctrl || next[0].meta).toBe(true);
		expect(next[0].shift).toBe(false);

		const prev = parseKeySequence("cmd+shift+f8");
		expect(prev).toHaveLength(1);
		expect(prev[0].key).toBe("f8");
		expect(prev[0].ctrl || prev[0].meta).toBe(true);
		expect(prev[0].shift).toBe(true);
	});
});
