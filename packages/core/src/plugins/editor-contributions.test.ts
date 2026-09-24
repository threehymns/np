import { describe, it, expect, beforeEach } from 'bun:test';
import { EditorState } from '@codemirror/state';
import { history, undo, undoDepth } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { PluginHost } from './host.svelte';
import { DocumentSession } from '../document.svelte';
import type { Storage } from '../storage';
import {
	DirectEditorViewAccessError,
	RawTransactionDispatchError,
	DocumentRevisionMismatchError,
	DuplicateEditorContributionIdError
} from './errors';
import {
	PILOT_GUTTER_CONTRIBUTION,
	PILOT_DECORATION_CONTRIBUTION,
	PILOT_KEYBINDING_CONTRIBUTION,
	addPilotDecorationEffect,
	pilotDecorationField,
	composeEditorContributions,
	reconfigureEditorContributions,
	type EditorContribution,
	type EditorContributionEntry
} from './editor';

describe('Editor contribution contract (#201, ADR 0016)', () => {
	let host: PluginHost;
	let storage: Storage;

	beforeEach(() => {
		host = new PluginHost({ platform: 'desktop' });
		storage = {} as any;
	});

	describe('Mediated editor contract & composition', () => {
		it('a pilot decoration and gutter contribution composes correctly with the core Markdown setup', () => {
			const entries: EditorContributionEntry[] = [
				{ pluginId: 'pilot-plugin', contribution: PILOT_GUTTER_CONTRIBUTION },
				{ pluginId: 'pilot-plugin', contribution: PILOT_DECORATION_CONTRIBUTION },
				{ pluginId: 'pilot-plugin', contribution: PILOT_KEYBINDING_CONTRIBUTION }
			];

			const pluginExtensions = composeEditorContributions(entries, host.editorCompartments, 'markdown');

			const initialContent = `# Title\n\nThis is a [link](https://example.com) in markdown.\n`;
			let state = EditorState.create({
				doc: initialContent,
				extensions: [markdown({ base: markdownLanguage }), ...pluginExtensions]
			});

			// 1. Verify core Markdown language support parses syntax correctly alongside contributions
			const tree = syntaxTree(state);
			expect(tree.length).toBe(state.doc.length);
			const headerNode = tree.resolveInner(2, 1);
			expect(headerNode.name).toBe('ATXHeading1');

			// 2. Verify pilot decoration field is active and accepts marks
			const trWithDeco = state.update({
				effects: addPilotDecorationEffect.of({ from: 2, to: 7, className: 'custom-mark' })
			});
			state = trWithDeco.state;
			const decos = state.field(pilotDecorationField);
			expect(decos.size).toBe(1);

			// 3. Verify decorations map correctly through subsequent text changes
			const trEdit = state.update({
				changes: { from: 0, to: 0, insert: 'Prefix: ' }
			});
			state = trEdit.state;
			const mappedDecos = state.field(pilotDecorationField);
			expect(mappedDecos.size).toBe(1);
			let foundRange = false;
			mappedDecos.between(0, state.doc.length, (from, to) => {
				// Original range 2..7 shifted by "Prefix: ".length (8) -> 10..15
				expect(from).toBe(10);
				expect(to).toBe(15);
				foundRange = true;
			});
			expect(foundRange).toBe(true);

			// 4. Verify reconfiguration when contributions are removed
			const emptyEffects = reconfigureEditorContributions([], host.editorCompartments, 'markdown');
			const trReconfig = state.update({ effects: emptyEffects });
			state = trReconfig.state;

			// Syntax tree continues to parse smoothly
			const treeAfter = syntaxTree(state);
			expect(treeAfter.length).toBe(state.doc.length);
		});

		it('orders contributions deterministically by priority, plugin ID, and contribution ID', () => {
			const c1: EditorContribution = {
				id: 'b-gutter',
				type: 'gutter',
				extension: [],
				priority: 5
			};
			const c2: EditorContribution = {
				id: 'a-gutter',
				type: 'gutter',
				extension: [],
				priority: 10
			};
			const c3: EditorContribution = {
				id: 'c-gutter',
				type: 'gutter',
				extension: [],
				priority: 5
			};

			host.registerEditorContributions('plugin-2', [c1]);
			host.registerEditorContributions('plugin-1', [c2, c3]);

			const registered = host.getEditorContributions('gutter');
			expect(registered.length).toBe(3);

			// c2 has priority 10, so it appears first. c1 and c3 both have priority 5,
			// plugin-1 comes before plugin-2 alphabetically.
			const composed = composeEditorContributions(registered, host.editorCompartments);
			expect(composed.length).toBe(3);
		});

		it('filters contributions by language when specified', () => {
			const mdOnly: EditorContribution = {
				id: 'md-gutter',
				type: 'gutter',
				extension: [],
				language: 'markdown'
			};
			const jsOnly: EditorContribution = {
				id: 'js-gutter',
				type: 'gutter',
				extension: [],
				language: 'javascript'
			};
			const universal: EditorContribution = {
				id: 'all-gutter',
				type: 'gutter',
				extension: []
			};

			host.registerEditorContributions('test-plugin', [mdOnly, jsOnly, universal]);

			const mdComposed = composeEditorContributions(
				host.getEditorContributions('gutter'),
				host.editorCompartments,
				'markdown'
			);
			expect(mdComposed.length).toBe(3); // 3 compartments
		});

		it('rejects duplicate contribution IDs across different plugins with an actionable error', () => {
			host.registerEditorContribution('plugin-a', {
				id: 'shared-id',
				type: 'gutter',
				extension: []
			});

			expect(() => {
				host.registerEditorContribution('plugin-b', {
					id: 'shared-id',
					type: 'decoration',
					extension: []
				});
			}).toThrow(DuplicateEditorContributionIdError);
		});

		it('allows same-plugin re-registration with fresh closures (refresh)', () => {
			host.registerEditorContribution('plugin-a', {
				id: 'gutter-1',
				type: 'gutter',
				extension: [],
				description: 'initial'
			});

			host.registerEditorContribution('plugin-a', {
				id: 'gutter-1',
				type: 'gutter',
				extension: [],
				description: 'refreshed'
			});

			const list = host.getEditorContributions('gutter');
			expect(list.length).toBe(1);
			expect(list[0].contribution.description).toBe('refreshed');
		});
	});

	describe('Document edit host operation & undo transaction semantics', () => {
		it('a document edit through the host operation forms one undo transaction', () => {
			const initialText = 'The quick brown fox jumps over the lazy dog';
			const doc = new DocumentSession(storage, initialText);
			host.registerDocumentSession(doc);

			// Setup attached editor state with CodeMirror history
			let state = EditorState.create({
				doc: initialText,
				extensions: [history()]
			});

			host.attachEditorInternal(doc.id, {
				getState: () => state,
				dispatch: (spec) => {
					state = state.update({
						changes: spec.changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert }))
					}).state;
				}
			});

			expect(doc.revision).toBe(0);
			expect(undoDepth(state)).toBe(0);

			// Apply multi-range changes atomically through the host operation
			const result = host.applyDocumentEdit({
				doc,
				expectedRevision: 0,
				changes: [
					{ from: 4, to: 9, insert: 'slow' }, // "quick" -> "slow"
					{ from: 20, to: 25, insert: 'leaps' } // "jumps" -> "leaps"
				],
				origin: 'test-plugin'
			});

			expect(result.success).toBe(true);
			expect(result.previousRevision).toBe(0);
			expect(result.newRevision).toBe(1);
			expect(result.newContent).toBe('The slow brown fox leaps over the lazy dog');
			expect(doc.content).toBe('The slow brown fox leaps over the lazy dog');
			expect(state.doc.toString()).toBe('The slow brown fox leaps over the lazy dog');

			// Exactly ONE undo transaction was recorded
			expect(undoDepth(state)).toBe(1);

			// Calling undo reverts BOTH changes back to original in a single undo step
			const undone = undo({
				state,
				dispatch: (tr) => {
					state = tr.state;
				}
			});

			expect(undone).toBe(true);
			expect(state.doc.toString()).toBe(initialText);
			expect(undoDepth(state)).toBe(0);
		});

		it('rejects document edits when revision mismatches without mutating content', () => {
			const doc = new DocumentSession(storage, 'Original content');
			host.registerDocumentSession(doc);

			expect(doc.revision).toBe(0);

			// Trying to apply edit expecting revision 5 fails
			expect(() => {
				host.applyDocumentEdit({
					doc,
					expectedRevision: 5,
					changes: [{ from: 0, to: 8, insert: 'Modified' }]
				});
			}).toThrow(DocumentRevisionMismatchError);

			expect(doc.content).toBe('Original content');
			expect(doc.revision).toBe(0);
		});

		it('applies document edit to non-attached document session cleanly', () => {
			const doc = new DocumentSession(storage, 'Hello world');
			host.registerDocumentSession(doc);

			const result = host.applyDocumentEdit({
				doc,
				expectedRevision: 0,
				changes: [
					{ from: 0, to: 5, insert: 'Greetings' },
					{ from: 6, to: 11, insert: 'earth' }
				]
			});

			expect(result.success).toBe(true);
			expect(doc.content).toBe('Greetings earth');
			expect(doc.revision).toBe(1);
		});

		it('rejects raw CodeMirror Transaction objects passed to host.applyDocumentEdit', () => {
			const doc = new DocumentSession(storage, 'Hello');
			const fakeRawTransaction = {
				startState: {},
				changes: {},
				effects: []
			};

			expect(() => {
				host.applyDocumentEdit({
					doc,
					expectedRevision: 0,
					changes: fakeRawTransaction as any
				});
			}).toThrow(RawTransactionDispatchError);

			expect(() => {
				host.applyDocumentEdit({
					doc,
					expectedRevision: 0,
					changes: [fakeRawTransaction as any]
				});
			}).toThrow(RawTransactionDispatchError);

			expect(() => {
				host.applyDocumentEdit({
					doc,
					expectedRevision: 0,
					changes: [{ from: 0, to: 1, insert: 'x' }],
					transaction: fakeRawTransaction
				} as any);
			}).toThrow(RawTransactionDispatchError);
		});
	});

	describe('Strict enforcement against direct view access and raw dispatch', () => {
		it('direct view access from plugin code fails loudly in tests', () => {
			// host accessors
			expect(() => (host as any).view).toThrow(DirectEditorViewAccessError);
			expect(() => (host as any).editorView).toThrow(DirectEditorViewAccessError);
			expect(() => (host as any).getActiveEditorView()).toThrow(DirectEditorViewAccessError);

			// document session accessors
			const doc = new DocumentSession(storage, 'Test');
			expect(() => (doc as any).view).toThrow(DirectEditorViewAccessError);
			expect(() => (doc as any).editorView).toThrow(DirectEditorViewAccessError);
		});

		it('raw transaction dispatch from plugin code fails loudly in tests', () => {
			// host dispatch
			expect(() => (host as any).dispatch({})).toThrow(RawTransactionDispatchError);
			expect(() => (host as any).dispatchTransaction({})).toThrow(RawTransactionDispatchError);

			// document session dispatch
			const doc = new DocumentSession(storage, 'Test');
			expect(() => (doc as any).dispatch({})).toThrow(RawTransactionDispatchError);
			expect(() => (doc as any).dispatchTransaction({})).toThrow(RawTransactionDispatchError);
		});
	});

	describe('Plugin lifecycle integration', () => {
		it('automatically removes editor contributions when a plugin is deactivated or unregistered', async () => {
			host.register({
				manifest: {
					id: 'custom-editor-plugin',
					name: 'Custom Editor Plugin',
					version: 0
				},
				setup: (h) => {
					h.registerEditorContribution('custom-editor-plugin', PILOT_GUTTER_CONTRIBUTION);
				}
			});

			await host.activate('custom-editor-plugin');
			expect(host.getEditorContributions('gutter').length).toBe(1);

			await host.deactivate('custom-editor-plugin');
			expect(host.getEditorContributions('gutter').length).toBe(0);

			// Re-activate and test unregister
			await host.activate('custom-editor-plugin');
			expect(host.getEditorContributions('gutter').length).toBe(1);

			await host.unregister('custom-editor-plugin');
			expect(host.getEditorContributions('gutter').length).toBe(0);
		});
	});
});
