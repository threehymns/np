import { describe, it, expect } from "bun:test";
import { EditorState, Compartment, StateField } from "@codemirror/state";
import { unifiedMergeView, getOriginalDoc } from "@codemirror/merge";
import type { GitChange } from "@np/core";

describe("DiffViewer extension compartments", () => {
	it("allows reconfiguring unifiedMergeView within a diff Compartment", () => {
		const diffCompartment = new Compartment();
		const wrapCompartment = new Compartment();

		let state = EditorState.create({
			doc: "modified content 1",
			extensions: [
				diffCompartment.of(
					unifiedMergeView({
						original: "original content 1"
					})
				),
				wrapCompartment.of([])
			]
		});

		expect(state.doc.toString()).toBe("modified content 1");
		expect(getOriginalDoc(state).toString()).toBe("original content 1");

		// Reconfigure with updated original content
		const tr = state.update({
			effects: diffCompartment.reconfigure(
				unifiedMergeView({
					original: "original content 2"
				})
			)
		});
		state = tr.state;

		// The reconfigured extension is derived from the new original content,
		// not just present in the state.
		expect(getOriginalDoc(state).toString()).toBe("original content 2");
	});

	it("allows reconfiguring hunk extensions within a hunk Compartment", () => {
		const hunkCompartment = new Compartment();

		const change1: GitChange = {
			filepath: "test.txt",
			status: "M",
			additions: 1,
			deletions: 0,
			diff: "",
			staged: false,
			originalContent: "a",
			modifiedContent: "b"
		};

		const change2: GitChange = {
			...change1,
			staged: true,
			stagedContent: "b"
		};

		const stagedField = StateField.define<boolean>({
			create: () => false,
			update: (value) => value
		});

		const createPlugin = (c: GitChange) => stagedField.init(() => c.staged);

		let state = EditorState.create({
			doc: "b",
			extensions: [
				hunkCompartment.of(createPlugin(change1))
			]
		});

		// The plugin is derived from change1 (unstaged).
		expect(state.field(stagedField)).toBe(false);

		const tr = state.update({
			effects: hunkCompartment.reconfigure(createPlugin(change2))
		});
		state = tr.state;

		// Reconfiguring with change2 (staged) yields a distinct observable value.
		expect(state.field(stagedField)).toBe(true);
	});
});
