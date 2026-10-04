import { describe, it, expect } from "bun:test";
import pathlib from "node:path";

const SRC = pathlib.join(import.meta.dir, "DiffViewer.svelte");
const src: string = await Bun.file(SRC).text();

const EDITOR_SRC = pathlib.join(import.meta.dir, "Editor.svelte");
const editorSrc: string = await Bun.file(EDITOR_SRC).text();

// Structural coverage for Working-copy pane parity and view independence
// (#271): the logic lives inside Svelte components, so these source
// invariants lock the wiring seams. Behavior of the sync shape itself
// (minimal hunks preserving undo) is covered by text-sync.test.ts; the
// shared-Document rules by diff-split-binding.test.ts; save routing by
// state-diff-save.test.ts.
describe("DiffViewer Working-copy pane parity (#271)", () => {
	function mergeViewBlocks() {
		const setupIdx = src.indexOf("function setupMergeView(");
		expect(setupIdx).toBeGreaterThan(-1);
		const afterSetup = src.slice(setupIdx);
		const aIdx = afterSetup.indexOf("a: {");
		const bIdx = afterSetup.indexOf("b: {", aIdx);
		expect(aIdx).toBeGreaterThan(-1);
		expect(bIdx).toBeGreaterThan(aIdx);
		const diffConfigIdx = afterSetup.indexOf("diffConfig: DEFAULT_DIFF_CONFIG", bIdx);
		expect(diffConfigIdx).toBeGreaterThan(bIdx);
		return {
			aBlock: afterSetup.slice(aIdx, bIdx),
			bBlock: afterSetup.slice(bIdx, diffConfigIdx)
		};
	}

	it("gives the b-pane an independent undo history like a tab", () => {
		const { aBlock, bBlock } = mergeViewBlocks();
		expect(bBlock).toContain("history(),");
		expect(aBlock).not.toContain("history()");
	});

	it("wires vim bindings in the b-pane through a reconfigurable compartment", () => {
		const { aBlock, bBlock } = mergeViewBlocks();
		expect(bBlock).toContain("vimCompartmentB.of(currentOptions.vimEnabled ? vim() : [])");
		// Reconfiguration lives in the action's update() below the creation
		// block; assert file-wide and keep the a-pane negative on its block.
		expect(src).toContain("vimCompartmentB.reconfigure(bVimEnabled ? vim() : [])");
		// The mode bridge re-attaches after the reconfigure dispatch (getCM
		// reads post-dispatch state), and focus syncs mode plus registers.
		expect(src).toContain("if (vimToggled) syncPaneVimModeListener();");
		expect(src).toContain("vim_mode', readPaneVimMode(view!.b)");
		expect(aBlock).not.toContain("vim(");
		expect(aBlock).not.toContain("vimCompartment");
	});

	it("wires completions with workspace context in the b-pane only", () => {
		const { aBlock, bBlock } = mergeViewBlocks();
		expect(bBlock).toContain("autocompletion(),");
		expect(bBlock).toContain("workspaceFacet.of(appState.workspace)");
		expect(bBlock).toContain("currentDocFacet.of(");
		expect(aBlock).not.toContain("autocompletion(");
		expect(aBlock).not.toContain("workspaceFacet");
		expect(aBlock).not.toContain("currentDocFacet");
	});

	it("drives the b-pane language from the bound Document with registry refresh", () => {
		const { aBlock, bBlock } = mergeViewBlocks();
		expect(bBlock).toContain("languageCompartmentB.of(langExtensions)");
		expect(src).toContain("languageCompartmentB.reconfigure(langExtensions)");
		expect(src).toContain("docLanguage: splitDoc?.language");
		expect(src).toContain("languageRevision: appState.plugins?.languageRevision");
		expect(aBlock).not.toContain("languageCompartment");
	});

	it("matches tab editing keybindings and behaviors in the b-pane", () => {
		const { aBlock, bBlock } = mergeViewBlocks();
		for (const token of [
			"...closeBracketsKeymap",
			"...defaultKeymap",
			"...searchKeymap",
			"...historyKeymap",
			'smartIndent("more")',
			"indentOnInput(),",
			"bracketMatching(),",
			"closeBrackets(),"
		]) {
			expect(bBlock).toContain(token);
			expect(aBlock).not.toContain(token);
		}
	});

	it("keeps word-wrap preference wiring on both split panes", () => {
		expect(src).toContain("wrapCompartmentB.of(currentOptions.wrap ? EditorView.lineWrapping : [])");
		expect(src).toContain("wrap: appState.prefs.wordWrap,");
	});

	it("syncs Document -> pane as a minimal hunk out of undo history", () => {
		expect(src).toContain("minimalTextChange(rightDoc, insert)");
		expect(src).toContain("Transaction.addToHistory.of(false)");
		expect(src).toContain("tr.annotation(splitSyncAnnotation)");
	});

	it("preserves pane cursor and scroll across external syncs", () => {
		expect(src).toContain("Math.min(r.anchor, insert.length)");
		expect(src).toContain("view.b.scrollDOM.scrollTop = prevTop;");
		expect(src).toContain("view.b.scrollDOM.scrollLeft = prevLeft;");
	});

	it("publishes the focused b-pane as the active editor with identity-checked cleanup", () => {
		expect(src).toContain("appState.activeEditorView = view!.b;");
		expect(src).toContain("if (appState.activeEditorView === view?.b)");
		// The read-only Original pane never publishes itself.
		const { aBlock } = mergeViewBlocks();
		expect(aBlock).not.toContain("activeEditorView");
	});

	it("keeps hunk navigation skipping collapsed files while dirty", () => {
		expect(src).toContain("if (isFileCollapsed(change.filepath)) return; // Skip collapsed files from hunk navigation");
	});

	it("keeps cursor/panel sync silent so edits never expand files or steal scroll", () => {
		expect(src).toContain("syncActiveFileSilent(fileChange.filepath)");
		expect(src).toContain("if (silentSyncFor === targetFile)");
		// Editing paths never write collapse state: only the header toggle,
		// collapse-all button, and explicit reveals assign collapsedFiles.
		const collapseWrites = src.match(/collapsedFiles\[[^\]]+\]\s*=/g) ?? [];
		expect(collapseWrites.length).toBeGreaterThan(0);
		for (const match of collapseWrites) {
			expect(match).toContain("collapsedFiles[");
		}
		expect(src).not.toContain("collapsedFiles[fileChange.filepath] = false;");
	});
});

describe("DiffViewer inline Working-copy pane parity (#271 review)", () => {
	function setupEditorBody() {
		const setupIdx = src.indexOf("function setupEditor(");
		expect(setupIdx).toBeGreaterThan(-1);
		const afterSetup = src.slice(setupIdx);
		// Cut before setupMergeView so assertions only see the inline action.
		const endIdx = afterSetup.indexOf("function setupMergeView(");
		expect(endIdx).toBeGreaterThan(0);
		return afterSetup.slice(0, endIdx);
	}

	it("gives the inline pane an independent undo history like the b-pane", () => {
		expect(setupEditorBody()).toContain("history(),");
	});

	it("wires vim bindings in the inline pane through a reconfigurable compartment", () => {
		const body = setupEditorBody();
		expect(body).toContain("vimCompartment.of(currentOptions.vimEnabled ? vim() : [])");
		expect(body).toContain("vimCompartment.reconfigure(inlineVimEnabled ? vim() : [])");
		expect(body).toContain("if (inlineVimToggled) syncInlineVimModeListener();");
		expect(body).toContain("vim_mode', readInlineVimMode(view!)");
	});

	it("wires completions with workspace context in the inline pane", () => {
		const body = setupEditorBody();
		expect(body).toContain("autocompletion(),");
		expect(body).toContain("workspaceFacet.of(appState.workspace)");
		expect(body).toContain("currentDocFacet.of(");
	});

	it("drives the inline pane language from the bound Document with registry refresh", () => {
		const body = setupEditorBody();
		expect(body).toContain("languageCompartment.of(langExtensions)");
		expect(body).toContain("languageCompartment.reconfigure(langExtensions)");
		// Call-site wiring (template, outside the action body).
		expect(src).toContain("docLanguage: inlineDoc?.language");
		expect(src).toContain("languageRevision: appState.plugins?.languageRevision");
	});

	it("matches tab editing keybindings and behaviors in the inline pane", () => {
		const body = setupEditorBody();
		for (const token of [
			"...closeBracketsKeymap",
			"...defaultKeymap",
			"...searchKeymap",
			"...historyKeymap",
			'smartIndent("more")',
			"indentOnInput(),",
			"bracketMatching(),",
			"closeBrackets(),"
		]) {
			expect(body).toContain(token);
		}
	});

	it("syncs Document -> inline pane as a minimal hunk out of undo history", () => {
		expect(setupEditorBody()).toContain("minimalTextChange(currentDoc, insert)");
	});

	it("publishes the focused inline pane as the active editor with identity-checked cleanup", () => {
		const body = setupEditorBody();
		expect(body).toContain("appState.activeEditorView = view;");
		expect(body).toContain("if (appState.activeEditorView === view)");
	});

	it("keeps the bare deleted-file Original pane out of the edit-target slot", () => {
		const body = setupEditorBody();
		// Exactly one publish site (the inline Working-copy pane); the bare
		// branch only tears down.
		expect(body.match(/appState\.activeEditorView = view;/g)?.length).toBe(1);
	});
});

describe("Original pane non-focusable for editing (#268)", () => {
	it("marks both Original surfaces non-editable while the Working-copy panes stay editable", () => {
		// One in the split a-pane, one in the bare deleted-file branch of
		// setupEditor. Neither Working-copy pane (split b, inline) sets it.
		expect(src.match(/EditorView\.editable\.of\(false\)/g)?.length).toBe(2);
	});

	it("keeps hunk navigation targeting the Working-copy pane with panel highlight following scroll", () => {
		expect(src).toContain("const editor = await getOrWaitEditor(targetHunk.filepath, viewMode);");
		expect(src).toContain("syncActiveFileSilent(fileChange.filepath)");
		expect(src).toContain("onfocusin={() => syncActiveFileSilent(fileChange.filepath)}");
	});
});

describe("tab editor undo independence (#271)", () => {
	it("syncs external content as a minimal hunk out of undo history", () => {
		expect(editorSrc).toContain("minimalTextChange(currentDoc, c)");
		expect(editorSrc).toContain("Transaction.addToHistory.of(false)");
	});

	it("catches restored history up with a minimal hunk", () => {
		expect(editorSrc).toContain("minimalTextChange(restored.doc.toString(), currentContent)");
	});
});
