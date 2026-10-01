import "../../../../tests/contract/rune-setup";
import { describe, it, expect } from "bun:test";
import { EditorState, Compartment, StateField, StateEffect } from "@codemirror/state";
import { EditorView, Decoration, type DecorationSet } from "@codemirror/view";
import {
	createEditorExtensions,
} from "../editor/index";
import {
	PluginHost,
	reconfigureEditorContributions,
	type EditorContributionEntry,
} from "@np/core";

const addDecoEffect = StateEffect.define<{ from: number; to: number; className: string }>();
const testDecoField = StateField.define<DecorationSet>({
	create() {
		return Decoration.none;
	},
	update(decos, tr) {
		decos = decos.map(tr.changes);
		for (const effect of tr.effects) {
			if (effect.is(addDecoEffect)) {
				decos = decos.update({
					add: [
						Decoration.mark({ class: effect.value.className }).range(
							effect.value.from,
							effect.value.to,
						),
					],
				});
			}
		}
		return decos;
	},
	provide: (f) => EditorView.decorations.from(f),
});

describe("Editor plugin contribution composition and reconfiguration", () => {
	it("wires plugin contributions into createEditorExtensions via composeEditorContributions", () => {
		const host = new PluginHost({ platform: "desktop" });
		const wrapCompartment = new Compartment();
		const languageCompartment = new Compartment();
		const vimCompartment = new Compartment();

		const entries: EditorContributionEntry[] = [
			{
				pluginId: "test-plugin",
				contribution: {
					id: "test-deco",
					type: "decoration",
					extension: testDecoField,
				},
			},
		];

		const extensions = createEditorExtensions({
			wrapCompartment,
			languageCompartment,
			vimCompartment,
			editorCompartments: host.editorCompartments,
			pluginContributions: entries,
			language: "markdown",
			gutterCompartment: host.editorCompartments.gutterCompartment,
			decorationsCompartment: host.editorCompartments.decorationsCompartment,
			keybindingsCompartment: host.editorCompartments.keybindingsCompartment,
			wrap: true,
			vimEnabled: false,
			initialLanguageExtensions: [],
		});

		let state = EditorState.create({
			doc: "Hello World",
			extensions,
		});

		// Verify the extension from plugin contributions is active
		expect(state.field(testDecoField, false)).toBeDefined();

		// Add decoration via effect
		const tr = state.update({
			effects: addDecoEffect.of({ from: 0, to: 5, className: "test-class" }),
		});
		state = tr.state;
		expect(state.field(testDecoField).size).toBe(1);

		// Reconfigure with empty contributions
		const reconfigEffects = reconfigureEditorContributions(
			[],
			host.editorCompartments,
			"markdown",
		);
		const reconfigTr = state.update({ effects: reconfigEffects });
		state = reconfigTr.state;

		// Reconfigured compartment no longer provides testDecoField
		expect(state.field(testDecoField, false)).toBeUndefined();
	});

	it("wires plugin contributions into createEditorExtensions via editorCompartments and pluginContributions options", () => {
		const host = new PluginHost({ platform: "desktop" });
		const wrapCompartment = new Compartment();
		const languageCompartment = new Compartment();
		const vimCompartment = new Compartment();

		const entries: EditorContributionEntry[] = [
			{
				pluginId: "test-plugin",
				contribution: {
					id: "test-deco",
					type: "decoration",
					extension: testDecoField,
				},
			},
		];

		const extensions = createEditorExtensions({
			wrapCompartment,
			languageCompartment,
			vimCompartment,
			editorCompartments: host.editorCompartments,
			pluginContributions: entries,
			language: "markdown",
			wrap: true,
			vimEnabled: false,
			initialLanguageExtensions: [],
		});

		const state = EditorState.create({
			doc: "Hello World",
			extensions,
		});

		expect(state.field(testDecoField, false)).toBeDefined();
	});

	it("increments host.editorRevision when contributions are registered or removed", () => {
		const host = new PluginHost({ platform: "desktop" });
		expect(host.editorRevision).toBe(0);

		host.registerEditorContribution("test-plugin", {
			id: "test-contrib",
			type: "decoration",
			extension: testDecoField,
		});
		expect(host.editorRevision).toBe(1);

		host.removePluginEditorContributions("test-plugin");
		expect(host.editorRevision).toBe(2);
	});
});
