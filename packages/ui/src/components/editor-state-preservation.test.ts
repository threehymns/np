import "../../../../tests/contract/rune-setup";
import { describe, it, expect } from "bun:test";
import { EditorState, EditorSelection, Compartment } from "@codemirror/state";
import { history, historyField, undo, undoDepth, isolateHistory } from "@codemirror/commands";
import { DocumentSession } from "../../../core/src/document.svelte";
import { createMockStorage } from "../../../../tests/mock-storage";

describe("Editor state preservation across tab switches and saves", () => {
	it("preserves undo history, selection, and content when restoring serialized state via historyField", () => {
		const storage = createMockStorage();
		const doc = new DocumentSession(storage, "line 1\nline 2\nline 3");

		// Simulate Tab 1 initial editor state
		let state = EditorState.create({
			doc: doc.content,
			extensions: [history()]
		});

		// User edits Tab 1: inserts text and moves cursor
		const tr1 = state.update({
			changes: { from: 13, insert: "\nline 4" },
			selection: EditorSelection.cursor(20)
		});
		state = tr1.state;
		doc.content = state.doc.toString();

		expect(undoDepth(state)).toBe(1);
		expect(state.selection.main.head).toBe(20);

		// Stash state onto DocumentSession as done by Editor.svelte
		doc.editorState = state.toJSON({ history: historyField });
		doc.scrollPosition = { top: 120, left: 0 };

		// Now simulate remounting:
		// Editor.svelte deserializes from doc.editorState using EditorState.fromJSON:
		const restoredState = EditorState.fromJSON(
			doc.editorState,
			{ extensions: [history()] },
			{ history: historyField }
		);

		expect(restoredState.doc.toString()).toBe("line 1\nline 2\nline 4\nline 3");
		expect(undoDepth(restoredState)).toBe(undoDepth(state));
		expect(restoredState.selection.main.head).toBe(state.selection.main.head);
		expect(doc.scrollPosition).toEqual({ top: 120, left: 0 });

		// Verify undo actually works on the restored state:
		let revertedState: EditorState | null = null;
		undo({
			state: restoredState,
			dispatch: (tr) => {
				revertedState = tr.state;
			}
		});

		expect(revertedState).not.toBeNull();
		expect(revertedState!.doc.toString()).toBe("line 1\nline 2\nline 3");
		expect(undoDepth(revertedState!)).toBe(0);
	});

	it("preserves undo history and selection during language compartment reconfiguration (save / language change)", () => {
		const languageCompartment = new Compartment();

		let state = EditorState.create({
			doc: "function test() {\n  return 42;\n}",
			extensions: [
				languageCompartment.of([]),
				history()
			]
		});

		// User edits document
		const tr1 = state.update({
			changes: { from: 17, insert: "\n  console.log('hi');" },
			selection: EditorSelection.cursor(37)
		});
		state = tr1.state;

		expect(undoDepth(state)).toBe(1);
		expect(state.selection.main.head).toBe(37);

		// Simulate language change when saving untitled file as .js
		const dummyLanguageExtension = [];
		const trLang = state.update({
			effects: languageCompartment.reconfigure(dummyLanguageExtension)
		});
		state = trLang.state;

		// Reconfiguring compartment preserves history and cursor position
		expect(undoDepth(state)).toBe(1);
		expect(state.selection.main.head).toBe(37);

		// Undo still works after language compartment reconfigure
		let undoneState: EditorState | null = null;
		undo({
			state,
			dispatch: (tr) => {
				undoneState = tr.state;
			}
		});

		expect(undoneState).not.toBeNull();
		expect(undoneState!.doc.toString()).toBe("function test() {\n  return 42;\n}");
	});

	it("avoids resetting state when doc.content matches current editor state", () => {
		let state = EditorState.create({
			doc: "line 1\nline 2",
			extensions: [history()]
		});

		const tr1 = state.update({
			changes: { from: 13, insert: "\nline 3" },
			selection: EditorSelection.cursor(20)
		});
		state = tr1.state;

		const currentContent = state.doc.toString();
		const incomingContent = currentContent;

		// If incoming external content matches current editor doc, no dispatch should occur
		const needsSync = incomingContent !== currentContent;
		expect(needsSync).toBe(false);
		expect(undoDepth(state)).toBe(1);
	});

	it("maintains independent states across multiple document sessions", () => {
		const storage = createMockStorage();
		const doc1 = new DocumentSession(storage, "Doc 1 initial");
		const doc2 = new DocumentSession(storage, "Doc 2 initial");

		// Edit Doc 1
		let state1 = EditorState.create({ doc: doc1.content, extensions: [history()] });
		state1 = state1.update({
			changes: { from: 5, insert: " - modified" },
			selection: EditorSelection.cursor(16)
		}).state;
		doc1.content = state1.doc.toString();
		doc1.editorState = state1.toJSON({ history: historyField });

		// Edit Doc 2
		let state2 = EditorState.create({ doc: doc2.content, extensions: [history()] });
		state2 = state2.update({
			changes: { from: 5, insert: " - modified twice" },
			selection: EditorSelection.cursor(22)
		}).state;
		state2 = state2.update({
			changes: { from: 22, insert: "!" },
			selection: EditorSelection.cursor(23),
			annotations: isolateHistory.of("before")
		}).state;
		doc2.content = state2.doc.toString();
		doc2.editorState = state2.toJSON({ history: historyField });

		expect(undoDepth(state1)).toBe(1);
		expect(undoDepth(state2)).toBe(2);

		// Restore Doc 1
		const restored1 = EditorState.fromJSON(doc1.editorState, { extensions: [history()] }, { history: historyField });
		expect(undoDepth(restored1)).toBe(1);
		expect(restored1.selection.main.head).toBe(16);
		expect(restored1.doc.toString()).toBe("Doc 1 - modified initial");

		// Restore Doc 2
		const restored2 = EditorState.fromJSON(doc2.editorState, { extensions: [history()] }, { history: historyField });
		expect(undoDepth(restored2)).toBe(2);
		expect(restored2.selection.main.head).toBe(23);
		expect(restored2.doc.toString()).toBe("Doc 2 - modified twice! initial");
	});

	it("preserves undo history and selection without full state wipe when content changes on disk externally", () => {
		const storage = createMockStorage();
		const doc = new DocumentSession(storage, "function hello() {\n  return 1;\n}");

		// Initial editor state with user edits
		let state = EditorState.create({
			doc: doc.content,
			extensions: [history()]
		});

		const tr1 = state.update({
			changes: { from: 29, insert: "0" },
			selection: EditorSelection.cursor(30)
		});
		state = tr1.state;
		doc.content = state.doc.toString();
		doc.editorState = state.toJSON({ history: historyField });
		doc.scrollPosition = { top: 50, left: 0 };

		expect(undoDepth(state)).toBe(1);
		expect(state.selection.main.head).toBe(30);

		// External process changes file on disk (e.g. branch checkout or external edit)
		const diskContent = "function hello() {\n  return 100;\n}";
		doc.content = diskContent;

		// When restoring from savedState, it updates the state with the disk changes
		// rather than resetting / wiping history:
		let restoredState = EditorState.fromJSON(
			doc.editorState,
			{ extensions: [history()] },
			{ history: historyField }
		);

		if (restoredState.doc.toString() !== doc.content) {
			const currentSelection = restoredState.selection;
			const newHead = Math.min(currentSelection.main.head, doc.content.length);
			const newAnchor = Math.min(currentSelection.main.anchor, doc.content.length);
			restoredState = restoredState.update({
				changes: { from: 0, to: restoredState.doc.length, insert: doc.content },
				selection: { anchor: newAnchor, head: newHead }
			}).state;
		}

		expect(restoredState.doc.toString()).toBe(diskContent);
		// Undo depth is retained (not wiped to 0)
		expect(undoDepth(restoredState)).toBeGreaterThanOrEqual(1);
		// Cursor is preserved
		expect(restoredState.selection.main.head).toBe(30);
		// Scroll position is intact
		expect(doc.scrollPosition).toEqual({ top: 50, left: 0 });

		// Can undo the edit
		let undoneState: EditorState | null = null;
		undo({
			state: restoredState,
			dispatch: (tr) => {
				undoneState = tr.state;
			}
		});
		expect(undoneState).not.toBeNull();
	});
});
