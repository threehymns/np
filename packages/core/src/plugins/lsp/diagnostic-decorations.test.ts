import '../../../../../tests/contract/rune-setup';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EditorState } from '@codemirror/state';
import { composeEditorContributions, reconfigureEditorContributions } from '../editor';
import { PluginHost } from '../host.svelte';
import { WORKSPACE_SERVICE_KEY, LSP_TRANSPORT_SERVICE_KEY, type WorkspaceLike } from '../services';
import { lspRegistration } from './registration';
import { createDiagnosticEditorContribution, lspDiagnosticField } from './diagnostic-decorations';
import { LspDiagnosticsStore, parsePublishDiagnostics } from './diagnostics';
import { LSP_LOG_STORE_SERVICE_KEY, type LspLogStore } from './logs';
import { LspRuntime, LSP_RUNTIME_SERVICE_KEY } from './lifecycle';
import { toFileUri } from './root';
import { createRealProcessTransport, waitFor, type RealProcessTransport } from '../../../../../tests/fixtures/lsp-transport';

/**
 * Server diagnostics as editor marks, through the decoration seam the plugin
 * contributes (spec #263, ticket #266, ADR 0016).
 *
 * Every assertion reads the decoration set the editor would draw, either from
 * the state field the contribution provides or from a state built out of the
 * host's own compartments — never from the offsets a diagnostic happened to
 * carry. The end-to-end case drives a real stub server over real pipes, so the
 * marks come from an actual `publishDiagnostics` notification.
 */

interface MarkView {
	readonly from: number;
	readonly to: number;
	readonly className: string;
	readonly title: string | undefined;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()!();
});

/** The marks an editor state would draw, in document order. */
function marksIn(state: EditorState): MarkView[] {
	const marks: MarkView[] = [];
	state.field(lspDiagnosticField, false)?.marks.between(0, state.doc.length, (from, to, value) => {
		const spec = (value as { spec: { class?: string; attributes?: Record<string, string> } }).spec;
		marks.push({
			from,
			to,
			className: spec.class ?? '',
			title: spec.attributes?.title
		});
	});
	return marks;
}

function range(line: number, from: number, to: number) {
	return { start: { line, character: from }, end: { line, character: to } };
}

function publish(store: LspDiagnosticsStore, uri: string, diagnostics: unknown[]) {
	store.publish(parsePublishDiagnostics('typescript@/repo', { uri, diagnostics })!);
}

interface TestEditor {
	/** The state the editor would be drawing from right now. */
	readonly state: EditorState;
	/** Switches the document this editor shows, as the shell does on a tab change. */
	show(path: string | null): EditorState;
}

const DOC = 'const a = 1;\nconst b = 2;\n';

/** An editor showing `path`, with the plugin's decoration contribution in it. */
function editorFor(
	store: LspDiagnosticsStore,
	path: string | null,
	doc = DOC
): TestEditor {
	let shown = path;
	const contribution = createDiagnosticEditorContribution({
		currentUri: () => (shown === null ? null : toFileUri(shown)),
		store
	});
	let state = EditorState.create({ doc, extensions: [contribution.extension] });
	return {
		get state() {
			return state;
		},
		show(next: string | null) {
			shown = next;
			state = state.update({}).state;
			return state;
		}
	};
}

/** Points the plugin's "which file is being edited" question at a path. */
function workspaceShowing(path: string | null): WorkspaceLike {
	return {
		project: { rootOrigin: null },
		activeDocument: path === null ? null : { id: 'doc', origin: { path } },
		tabs: [],
		activeTabId: 'doc',
		closeTab: () => {},
		saveFolderState: async () => {}
	} as unknown as WorkspaceLike;
}

function makeProject(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'lsp-diagnostics-'));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	for (const [relative, content] of Object.entries(files)) {
		const path = join(root, relative);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	return root;
}

describe('Diagnostics in the editor through decoration contributions (#266)', () => {
	it('marks the character range a published diagnostic names', () => {
		const store = new LspDiagnosticsStore();
		publish(store, toFileUri('/repo/a.ts'), [
			{
				range: range(1, 0, 5),
				severity: 1,
				message: 'Cannot find name "b".',
				source: 'ts',
				code: 2304
			},
			{ range: range(0, 6, 7), severity: 2, message: 'unused' }
		]);
		const editor = editorFor(store, '/repo/a.ts');

		// In document order, whatever order the server listed them in.
		expect(marksIn(editor.state)).toEqual([
			{
				from: 6,
				to: 7,
				className: 'cm-lsp-diagnostic cm-lsp-diagnostic-warning',
				title: 'unused'
			},
			{
				from: 13,
				to: 18,
				className: 'cm-lsp-diagnostic cm-lsp-diagnostic-error',
				title: 'ts: (2304) Cannot find name "b".'
			}
		]);
	});

	it('never shows one file\'s diagnostics on another file', () => {
		const store = new LspDiagnosticsStore();
		publish(store, toFileUri('/repo/a.ts'), [
			{ range: range(0, 0, 5), severity: 1, message: 'a is broken' }
		]);
		publish(store, toFileUri('/repo/b.ts'), [
			{ range: range(1, 0, 5), severity: 2, message: 'b is suspicious' }
		]);

		const editor = editorFor(store, '/repo/a.ts');
		expect(marksIn(editor.state).map((mark) => mark.title)).toEqual(['a is broken']);

		// The same editor, now showing the other document: the marks follow the
		// document rather than linger from whichever one reported last.
		expect(marksIn(editor.show('/repo/b.ts')).map((mark) => mark.title)).toEqual([
			'b is suspicious'
		]);

		// And a document no server said anything about is painted with nothing,
		// rather than with whatever the previous document reported.
		expect(marksIn(editor.show('/repo/c.ts'))).toEqual([]);
	});

	it('marks nothing while no document is being edited', () => {
		const store = new LspDiagnosticsStore();
		publish(store, toFileUri('/repo/a.ts'), [
			{ range: range(0, 0, 5), severity: 1, message: 'a is broken' }
		]);
		expect(marksIn(editorFor(store, null).state)).toEqual([]);
	});

	it('keeps each mark on its characters after an edit, until the server answers again', () => {
		const store = new LspDiagnosticsStore();
		publish(store, toFileUri('/repo/a.ts'), [
			{ range: range(1, 0, 5), severity: 1, message: 'later line' }
		]);
		const editor = editorFor(store, '/repo/a.ts');
		expect(marksIn(editor.state)).toEqual([
			{
				from: 13,
				to: 18,
				className: 'cm-lsp-diagnostic cm-lsp-diagnostic-error',
				title: 'later line'
			}
		]);

		// Typing a line on the first line shifts the text the server answered
		// about, so the mark moves with the characters it described.
		const inserted = 'let x = 0;\n';
		const edited = editor.state.update({
			changes: { from: 0, to: 0, insert: inserted }
		}).state;

		expect(marksIn(edited)).toEqual([
			{
				from: 13 + inserted.length,
				to: 18 + inserted.length,
				className: 'cm-lsp-diagnostic cm-lsp-diagnostic-error',
				title: 'later line'
			}
		]);
	});

	it('re-reads the store when the editor-contribution registry is rebuilt', () => {
		// A report arrives from a pipe while the editor sits idle, and a plugin may
		// not dispatch into the view (ADR 0016). The editor re-applies its
		// decoration compartment whenever the registry is rebuilt, so a rebuild is
		// the trigger; this asserts the marks actually follow it.
		const store = new LspDiagnosticsStore();
		let shown = '/repo/a.ts';
		const contribution = createDiagnosticEditorContribution({
			currentUri: () => toFileUri(shown),
			store
		});
		const state = EditorState.create({
			doc: 'const a = 1;\n',
			extensions: [contribution.extension]
		});
		expect(marksIn(state)).toEqual([]);

		publish(store, toFileUri('/repo/a.ts'), [
			{ range: range(0, 0, 5), severity: 1, message: 'arrived while idle' }
		]);
		// No transaction of its own: the state cannot know the pipe wrote.
		expect(marksIn(state.update({}).state)).toEqual([
			{ from: 0, to: 5, className: 'cm-lsp-diagnostic cm-lsp-diagnostic-error', title: 'arrived while idle' }
		]);

		publish(store, toFileUri('/repo/a.ts'), []);
		expect(marksIn(state.update({}).state)).toEqual([]);
		shown = '/repo/b.ts';
		expect(marksIn(state.update({}).state)).toEqual([]);
	});

	it('marks an empty range as one character and an empty line not at all', () => {
		const store = new LspDiagnosticsStore();
		publish(store, toFileUri('/repo/a.ts'), [
			// A missing import is reported at an insertion point, and CodeMirror
			// rejects an empty mark.
			{ range: range(0, 1, 1), severity: 1, message: 'insert here' },
			// At the very end of a line, and on an empty line, there is no character
			// left to underline.
			{ range: range(0, 3, 3), severity: 1, message: 'end of the line' },
			{ range: range(1, 0, 0), severity: 1, message: 'nothing to underline' }
		]);
		const editor = editorFor(store, '/repo/a.ts', 'abc\n\n');

		expect(marksIn(editor.state).map((mark) => [mark.from, mark.to])).toEqual([[1, 2]]);
	});

	it('clips a report whose positions no longer fit the document', () => {
		const store = new LspDiagnosticsStore();
		publish(store, toFileUri('/repo/a.ts'), [
			// Answered against a longer document: past the end of its own line, which
			// clips to the characters the line still has.
			{ range: range(0, 11, 46), severity: 1, message: 'clipped to the line' },
			// Past the end of the line and nothing left to underline.
			{ range: range(0, 40, 46), severity: 1, message: 'nothing to underline' },
			// A line the document no longer has.
			{ range: range(9, 0, 2), severity: 1, message: 'a line that is gone' },
			{ range: range(1, 0, 2), severity: 1, message: 'on the second line' }
		]);
		const editor = editorFor(store, '/repo/a.ts', 'const a = 1;\nconst b = 2;\n');

		// A stale report is worth less than a mark on a character the server never
		// named, so only the part that still fits is drawn.
		expect(marksIn(editor.state).map((mark) => [mark.from, mark.to, mark.title])).toEqual([
			[11, 12, 'clipped to the line'],
			[13, 15, 'on the second line']
		]);
	});

	it('turns a real server\'s publishDiagnostics into marks in the editor', async () => {
		const root = makeProject({
			'tsconfig.json': '{}',
			'src/a.ts': 'const a = 1;\nconst b = 2;\n'
		});
		const host = new PluginHost({ platform: 'desktop' });
		const transport: RealProcessTransport = createRealProcessTransport({
			script: ['--diagnostics']
		});
		host.provideService(LSP_TRANSPORT_SERVICE_KEY, transport);
		const path = join(root, 'src/a.ts');
		host.provideService(WORKSPACE_SERVICE_KEY, workspaceShowing(path));
		host.register(lspRegistration);
		await host.activate('lsp');
		cleanups.push(async () => {
			if (host.isPluginActive('lsp')) await host.deactivate('lsp');
		});

		// The editor state the shell builds: the host's own compartments holding
		// whatever the plugin contributed.
		const build = () =>
			EditorState.create({
				doc: 'const a = 1;\nconst b = 2;\n',
				extensions: composeEditorContributions(
					host.getEditorContributions(),
					host.editorCompartments,
					'TypeScript'
				)
			});
		let state = build();

		host.emit('document:opened', {
			document: {
				origin: { scheme: 'file', path, name: 'a.ts' },
				fileName: 'a.ts',
				content: 'const a = 1;\nconst b = 2;\n',
				language: { name: 'TypeScript' }
			}
		});
		await waitFor(() => (host.getService<LspLogStore>(LSP_LOG_STORE_SERVICE_KEY)?.read({ kind: 'protocol' }) ?? [])
			.some((entry) => entry.message.includes('publishDiagnostics')), {
			label: 'the server to publish diagnostics'
		});

		// The publish itself is not a transaction; the registry rebuild the plugin
		// asks for is what makes the editor read the store again.
		state = state.update({
			effects: reconfigureEditorContributions(
				host.getEditorContributions(),
				host.editorCompartments,
				'TypeScript'
			)
		}).state;

		expect(marksIn(state)).toEqual([
			{
				from: 0,
				to: 5,
				className: 'cm-lsp-diagnostic cm-lsp-diagnostic-error',
				title: 'stub: (2304) stub server: cannot find name'
			},
			{
				from: 13,
				to: 18,
				className: 'cm-lsp-diagnostic cm-lsp-diagnostic-warning',
				title: 'stub: stub server: unused variable'
			}
		]);

		// Stopping the server drops its findings: they described a process that is
		// no longer watching the file.
		await host.getService<LspRuntime>(LSP_RUNTIME_SERVICE_KEY)?.stopAll();
		state = state.update({
			effects: reconfigureEditorContributions(
				host.getEditorContributions(),
				host.editorCompartments,
				'TypeScript'
			)
		}).state;
		expect(marksIn(state)).toEqual([]);
	});
});