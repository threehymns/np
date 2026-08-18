(globalThis as any).$state = <T>(v: T) => v;

import { describe, it, expect, mock } from "bun:test";
import { registerCoreCommands, CommandRegistry } from "./commands.svelte";

function createMockAppState(clipboardService?: {
	writeText?: (text: string) => Promise<void>;
	readText?: () => Promise<string>;
}) {
	const commands = new CommandRegistry();
	const appState = {
		commands,
		clipboardService,
		activeEditorView: undefined as any
	};
	registerCoreCommands(appState as any);
	return appState;
}

function createMockEditorView(initialDoc: string, from: number, to: number) {
	let doc = initialDoc;
	let currentSelection = { from, to };
	const dispatched: any[] = [];
	const createState = () => ({
		get selection() {
			return { main: currentSelection };
		},
		get doc() {
			return {
				sliceString: (start: number, end: number) => doc.slice(start, end)
			};
		}
	});
	let state = createState();
	const view = {
		get state() {
			return state;
		},
		focus: mock(() => {}),
		dispatch: mock((tr: any) => {
			dispatched.push(tr);
			if (tr.changes) {
				const { from: cFrom, to: cTo, insert } = tr.changes;
				doc = doc.slice(0, cFrom) + insert + doc.slice(cTo);
			}
			if (tr.selection) {
				currentSelection = { from: tr.selection.anchor, to: tr.selection.anchor };
			}
			state = createState();
		})
	};
	return {
		view,
		dispatched,
		getDoc: () => doc,
		setDoc: (nextDoc: string) => {
			doc = nextDoc;
			state = createState();
		}
	};
}

describe("Cut command ('edit.cut')", () => {
	it("dispatches selection deletion after clipboard write succeeds", async () => {
		let writtenText = "";
		const clipboardService = {
			writeText: mock(async (text: string) => {
				writtenText = text;
			})
		};
		const appState = createMockAppState(clipboardService);
		const { view, dispatched, getDoc } = createMockEditorView("Hello World", 0, 5);
		appState.activeEditorView = view;

		const cutCmd = appState.commands.get("edit.cut");
		expect(cutCmd).toBeDefined();

		await cutCmd!.action();

		expect(clipboardService.writeText).toHaveBeenCalledTimes(1);
		expect(writtenText).toBe("Hello");
		expect(view.dispatch).toHaveBeenCalledTimes(1);
		expect(dispatched[0]).toEqual({
			changes: { from: 0, to: 5, insert: "" },
			selection: { anchor: 0 }
		});
		expect(getDoc()).toBe(" World");
	});

	it("does not dispatch deletion when clipboardService is unavailable", async () => {
		const appState = createMockAppState(undefined);
		const { view, dispatched, getDoc } = createMockEditorView("Hello World", 0, 5);
		appState.activeEditorView = view;

		const cutCmd = appState.commands.get("edit.cut");
		expect(cutCmd).toBeDefined();

		await cutCmd!.action();

		expect(view.dispatch).not.toHaveBeenCalled();
		expect(dispatched).toHaveLength(0);
		expect(getDoc()).toBe("Hello World");
	});

	it("does not dispatch deletion when clipboardService.writeText is missing", async () => {
		const clipboardService = {};
		const appState = createMockAppState(clipboardService);
		const { view, dispatched, getDoc } = createMockEditorView("Hello World", 0, 5);
		appState.activeEditorView = view;

		const cutCmd = appState.commands.get("edit.cut");
		expect(cutCmd).toBeDefined();

		await cutCmd!.action();

		expect(view.dispatch).not.toHaveBeenCalled();
		expect(dispatched).toHaveLength(0);
		expect(getDoc()).toBe("Hello World");
	});

	it("does not dispatch deletion when clipboardService.writeText rejects", async () => {
		const clipboardService = {
			writeText: mock(async () => {
				throw new Error("Permission denied");
			})
		};
		const appState = createMockAppState(clipboardService);
		const { view, dispatched, getDoc } = createMockEditorView("Hello World", 0, 5);
		appState.activeEditorView = view;

		const cutCmd = appState.commands.get("edit.cut");
		expect(cutCmd).toBeDefined();

		await cutCmd!.action();

		expect(clipboardService.writeText).toHaveBeenCalledTimes(1);
		expect(view.dispatch).not.toHaveBeenCalled();
		expect(dispatched).toHaveLength(0);
		expect(getDoc()).toBe("Hello World");
	});

	it("does not delete changed editor content when clipboard write is pending", async () => {
		let resolveWrite!: () => void;
		const clipboardService = {
			writeText: mock(() => new Promise<void>(resolve => {
				resolveWrite = resolve;
			}))
		};
		const appState = createMockAppState(clipboardService);
		const { view, dispatched, getDoc, setDoc } = createMockEditorView("Hello World", 0, 5);
		appState.activeEditorView = view;

		const cutCmd = appState.commands.get("edit.cut");
		expect(cutCmd).toBeDefined();

		const cutPromise = cutCmd!.action();
		setDoc("Changed World");
		resolveWrite();
		await cutPromise;

		expect(view.dispatch).not.toHaveBeenCalled();
		expect(dispatched).toHaveLength(0);
		expect(getDoc()).toBe("Changed World");
	});

	it("does not write to clipboard or dispatch deletion when selection is empty", async () => {
		const clipboardService = {
			writeText: mock(async () => {})
		};
		const appState = createMockAppState(clipboardService);
		const { view, dispatched } = createMockEditorView("Hello World", 3, 3);
		appState.activeEditorView = view;

		const cutCmd = appState.commands.get("edit.cut");
		expect(cutCmd).toBeDefined();

		await cutCmd!.action();

		expect(clipboardService.writeText).not.toHaveBeenCalled();
		expect(view.dispatch).not.toHaveBeenCalled();
		expect(dispatched).toHaveLength(0);
	});
});
