import { describe, it, expect, mock } from "bun:test";
import { EditorState, Compartment } from "@codemirror/state";
import { unifiedMergeView } from "@codemirror/merge";
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

		// Reconfigure with updated original content
		const tr = state.update({
			effects: diffCompartment.reconfigure(
				unifiedMergeView({
					original: "original content 2"
				})
			)
		});
		state = tr.state;
		expect(state).toBeDefined();
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

		let currentChange = change1;
		const createPlugin = (c: GitChange) => EditorState.transactionExtender.of(() => null);

		let state = EditorState.create({
			doc: "b",
			extensions: [
				hunkCompartment.of(createPlugin(change1))
			]
		});

		const tr = state.update({
			effects: hunkCompartment.reconfigure(createPlugin(change2))
		});
		state = tr.state;
		expect(state).toBeDefined();
	});
});
