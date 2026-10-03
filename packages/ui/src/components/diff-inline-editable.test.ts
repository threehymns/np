import { describe, it, expect } from "bun:test";
import pathlib from "node:path";
import { EditorState, Text } from "@codemirror/state";
import { unifiedMergeView, getOriginalDoc, Chunk } from "@codemirror/merge";
import { DocumentSession } from "../../../core/src/document.svelte";
import type { FileOrigin } from "../../../core/src/storage";
import { DEFAULT_DIFF_CONFIG } from "../../../core/src/project/vcs";
import { createMockStorage } from "../../../../tests/mock-storage";
import {
	originForDiffFilepath,
	findBoundDocument,
	isSplitWorkingCopyEditable,
	resolveSplitRightContent,
	ensureSplitDocument
} from "./diff-split-binding";

const SRC = pathlib.join(import.meta.dir, "DiffViewer.svelte");
const src: string = await Bun.file(SRC).text();

const root: FileOrigin = { scheme: "file", path: "/projects/np", name: "np" };

function makeDoc(content: string, filepath: string): DocumentSession {
	const storage = createMockStorage();
	return new DocumentSession(storage, content, originForDiffFilepath(root, filepath));
}

// Structural coverage for the inline unified Working-copy pane (#270): the
// logic lives inside the Svelte component, so these source invariants lock
// the wiring seams; behavior is covered below (headless unified editor) and
// by diff-split-binding.test.ts (shared helpers) plus state-diff-save.test.ts
// (mode-independent save routing).
describe("DiffViewer inline Working-copy pane binding", () => {
	it("drives the inline editor from Document content instead of the git snapshot", () => {
		expect(src).toContain("resolveSplitRightContent(inlineDoc, diff.modifiedContent)");
	});

	it("makes inline editability follow the bound Document (deleted files stay read-only)", () => {
		expect(src).toContain("isSplitWorkingCopyEditable(fileChange.status, inlineDoc)");
	});

	it("wires both panes to the shared Document change seam", () => {
		// Split b-pane and inline editor route keystrokes through the same
		// canonical keystroke path.
		const seam = src.match(/onDocChange: \(text\) => handleSplitDocChange\(fileChange\.filepath, text\)/g) ?? [];
		expect(seam.length).toBe(2);
		expect(src).toContain("appState.workspace.updateDocumentContent(doc, text)");
	});

	it("gates inline keystrokes behind a readOnly compartment, not a static flag", () => {
		expect(src).toContain(
			"readOnlyCompartment.of(EditorState.readOnly.of(!currentOptions.editable))"
		);
		expect(src).toContain("readOnlyCompartment.reconfigure(");
	});

	it("tags external Document syncs in both panes so they never echo or pollute undo", () => {
		const tagged = src.match(/currentOptions\.onDocChange\(update\.state\.doc\.toString\(\)\)/g) ?? [];
		expect(tagged.length).toBe(2);
		expect(src).toContain("tr.annotation(splitSyncAnnotation)");
		expect(src).toContain("Transaction.addToHistory.of(false)");
	});

	it("keeps the Original (a) pane read-only in split mode", () => {
		const bare = src.match(/EditorState\.readOnly\.of\(true\)/g) ?? [];
		expect(bare.length).toBe(1);
	});

	it("never routes Original-side mutations from inline mode", () => {
		// The unified editor's originalDoc field is only writable through
		// these operations; the component must not reference any of them.
		expect(src).not.toContain("originalDocChangeEffect");
		expect(src).not.toContain("updateOriginalDoc");
		expect(src).not.toContain("acceptChunk");
		expect(src).not.toContain("rejectChunk");
	});

	it("keeps the hunk widget extension and dirty indicator working in inline mode", () => {
		// Hunk controls mount in both the inline editor and the split b-pane,
		// each with a creation site and an update-time reconfigure site.
		const hunk = src.match(
			/createHunkWidgetExtension\(currentOptions\.fileChange, appState, currentOptions\.hunks, currentOptions\.unstagedChunks\)/g
		) ?? [];
		expect(hunk.length).toBe(4);
		expect(src).toContain("isDiffHeaderDirty(headerDoc)");
	});
});

// Headless behavior of the inline unified editor (#270): a real EditorState
// with unifiedMergeView, asserting external behavior (editable doc content
// vs. untouched original content) rather than widget internals.
describe("inline unified editor behavior", () => {
	const ORIGINAL = "keep1\nREMOVE ME\nkeep2\n";
	const WORKING = "keep1\nkeep2\n";

	function inlineState(doc: string = WORKING) {
		return EditorState.create({
			doc,
			extensions: [
				EditorState.readOnly.of(false),
				unifiedMergeView({ original: ORIGINAL, mergeControls: false })
			]
		});
	}

	it("holds working-copy text only: removed lines have no editable position", () => {
		const state = inlineState();
		expect(state.doc.toString()).toBe(WORKING);
		expect(state.doc.toString()).not.toContain("REMOVE ME");
	});

	it("fixtures a removed-only hunk (deletion on the Original side, empty on the working-copy side)", () => {
		const origText = Text.of(ORIGINAL.split(/\r?\n/));
		const modText = Text.of(WORKING.split(/\r?\n/));
		const chunks = Chunk.build(origText, modText, DEFAULT_DIFF_CONFIG);
		const removedOnly = chunks.filter((c) => c.fromB === c.toB && c.fromA < c.toA);
		expect(removedOnly.length).toBeGreaterThan(0);
		const removedText = origText.sliceString(removedOnly[0].fromA, removedOnly[0].toA);
		expect(removedText).toContain("REMOVE ME");
	});

	it("routes keystrokes at the deletion point into working-copy text, leaving the Original side intact", () => {
		let state = inlineState();
		const origText = Text.of(ORIGINAL.split(/\r?\n/));
		const chunks = Chunk.build(origText, state.doc, DEFAULT_DIFF_CONFIG);
		const deletion = chunks.find((c) => c.fromB === c.toB && c.fromA < c.toA);
		expect(deletion).toBeDefined();

		// Keystroke exactly where the removed-line widget renders.
		const tr = state.update({
			changes: { from: deletion!.fromB, to: deletion!.fromB, insert: "INSERTED\n" }
		});
		state = tr.state;

		expect(state.doc.toString()).toBe("keep1\nINSERTED\nkeep2\n");
		expect(state.doc.toString()).not.toContain("REMOVE ME");
		expect(getOriginalDoc(state).toString()).toBe(ORIGINAL);
	});

	it("keeps Original-side content unmodifiable through ordinary typing", () => {
		let state = inlineState();
		const tr = state.update({
			changes: { from: 0, to: "keep1".length, insert: "keep1 edited" }
		});
		state = tr.state;

		expect(state.doc.toString()).toBe("keep1 edited\nkeep2\n");
		expect(getOriginalDoc(state).toString()).toBe(ORIGINAL);
	});

	it("deleting working-copy text never touches removed-line content", () => {
		let state = inlineState();
		const line2 = state.doc.line(2);
		const tr = state.update({ changes: { from: line2.from, to: line2.to, insert: "" } });
		state = tr.state;

		expect(state.doc.toString()).toBe("keep1\n\n");
		expect(getOriginalDoc(state).toString()).toBe(ORIGINAL);
	});
});

// The inline pane reuses the shared working-copy binding (#269 helpers):
// same Document, same editability rule, same dirty semantics.
describe("inline Working-copy binding reuse", () => {
	it("is editable for working-copy statuses with a bound Document", () => {
		for (const status of ["M", "A", "U"] as const) {
			expect(isSplitWorkingCopyEditable(status, makeDoc("x", "f.ts"))).toBe(true);
		}
	});

	it("stays read-only for deleted files and when unbound", () => {
		expect(isSplitWorkingCopyEditable("D", makeDoc("x", "f.ts"))).toBe(false);
		expect(isSplitWorkingCopyEditable("M", undefined)).toBe(false);
	});

	it("binds new (untracked) files to an editable Document", () => {
		const storage = createMockStorage();
		const scope = { documents: [] as DocumentSession[], storage, rootOrigin: root, coversOrigin: () => true };
		const doc = ensureSplitDocument(
			scope,
			new Map(),
			{ filepath: "src/new.ts", status: "A", additions: 1, deletions: 0, diff: "", staged: false },
			"draft\n"
		);
		expect(doc).toBeDefined();
		expect(isSplitWorkingCopyEditable("A", doc)).toBe(true);
	});

	it("reflects live tab edits in the inline content source", () => {
		const doc = makeDoc("snapshot", "src/a.ts");
		doc.content = "tab keystrokes";
		expect(resolveSplitRightContent(doc, "snapshot")).toBe("tab keystrokes");
		expect(findBoundDocument([doc], new Map(), root, "src/a.ts")).toBe(doc);
	});
});
