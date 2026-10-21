import '../../../../../tests/contract/rune-setup';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EditorState } from '@codemirror/state';
import { composeEditorContributions, reconfigureEditorContributions } from '../editor';
import { PluginHost } from '../host.svelte';
import {
	WORKSPACE_SERVICE_KEY,
	LSP_PLATFORM_SERVICE_KEY,
	SETTINGS_READER_SERVICE_KEY,
	type SettingsRead,
	type WorkspaceLike
} from '../services';
import { lspRegistration } from './registration';
import {
	createDiagnosticEditorContribution,
	gutterMarksIn,
	lspDiagnosticField
} from './diagnostic-decorations';
import type { DiagnosticGutterMark } from './diagnostic-display';
import { SettingsResolver } from '../settings';
import { LSP_SCHEMA } from './settings';
import { LspDiagnosticsStore, parsePublishDiagnostics } from './diagnostics';
import { createRepaintScheduler } from './index';
import { LSP_LOG_STORE_SERVICE_KEY, type LspLogStore } from './logs';
import { LspRuntime, LSP_RUNTIME_SERVICE_KEY } from './lifecycle';
import { toFileUri } from './root';
import { createRealProcessPlatform, waitFor, type RealProcessPlatform } from '../../../../../tests/fixtures/lsp-platform';

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
	doc = DOC,
	read?: SettingsRead
): TestEditor {
	let shown = path;
	const contribution = createDiagnosticEditorContribution({
		currentUri: () => (shown === null ? null : toFileUri(shown)),
		store,
		read
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

/** A reader over the `lsp` namespace, as the app's own reader would be. */
function readerFor(values: Record<string, unknown>): SettingsRead {
	return (namespace, key) => (namespace === 'lsp' ? values[key] : undefined);
}

/**
 * A gutter mark as the test reads it: the line, the severity, how many
 * findings it stands for, and what they say.
 */
function markOf(mark: DiagnosticGutterMark) {
	return {
		line: mark.line,
		severity: mark.severity,
		count: mark.count,
		messages: mark.findings.map((finding) => finding.message)
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
		const platform: RealProcessPlatform = createRealProcessPlatform({
			script: ['--diagnostics']
		});
		host.provideService(LSP_PLATFORM_SERVICE_KEY, platform);
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
		// The method, not the bare name: the client's own initialize request
		// names the publish capability it declares, so a loose match would
		// find the handshake rather than the publish.
		await waitFor(() => (host.getService<LspLogStore>(LSP_LOG_STORE_SERVICE_KEY)?.read({ kind: 'protocol' }) ?? [])
			.some((entry) => entry.message.includes('"method":"textDocument/publishDiagnostics"')), {
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

	it('coalesces a burst of publishes into one request to re-read them', async () => {
		// A server publishes a report per file it has an opinion about, and the
		// repaint a publish asks for reconfigures every editor-contribution
		// compartment. Asking once per tick is the difference between one rebuild
		// and one per report.
		let repaints = 0;
		const schedule = createRepaintScheduler(() => {
			repaints++;
		});

		for (let i = 0; i < 25; i++) schedule();
		// Nothing yet: the whole point is that the burst collapses before it costs
		// anything.
		expect(repaints).toBe(0);

		await Promise.resolve();
		expect(repaints).toBe(1);

		// And the next burst is not swallowed by a queue that never drains.
		schedule();
		await Promise.resolve();
		expect(repaints).toBe(2);
	});
});

/**
 * The display controls (issue #310).
 *
 * The inline marks, the gutter marks, and the settings that narrow them. The
 * settings are read through the same resolver the app uses, so what is pinned
 * here is the whole path a user's answer travels: stored value, resolver,
 * display layer.
 */
describe('The display controls (#310)', () => {
	it('paints nothing inline when the inline toggle is off, and leaves the gutter marks', () => {
		const store = new LspDiagnosticsStore();
		publish(store, toFileUri('/repo/a.ts'), [
			{ range: range(0, 0, 5), severity: 1, message: 'a is broken' }
		]);

		const editor = editorFor(store, '/repo/a.ts', DOC, readerFor({ inline_diagnostics: false }));

		expect(marksIn(editor.state)).toEqual([]);
		// The gutter is its own surface: the toggle says whether findings are
		// painted into the text, and says nothing about the line markers.
		expect(gutterMarksIn(editor.state).map(markOf)).toEqual([
			{ line: 0, severity: 'error', count: 1, messages: ['a is broken'] }
		]);
	});

	it('narrows the marks and the gutter marks to the maximum severity', () => {
		const store = new LspDiagnosticsStore();
		publish(store, toFileUri('/repo/a.ts'), [
			{ range: range(0, 0, 5), severity: 1, message: 'broken' },
			{ range: range(1, 0, 5), severity: 2, message: 'suspicious' },
			{ range: range(2, 0, 5), severity: 3, message: 'a note' }
		]);

		const editor = editorFor(store, '/repo/a.ts', DOC, readerFor({ max_severity: 'warning' }));

		expect(marksIn(editor.state).map((mark) => mark.title)).toEqual(['broken', 'suspicious']);
		expect(gutterMarksIn(editor.state).map(markOf)).toEqual([
			{ line: 0, severity: 'error', count: 1, messages: ['broken'] },
			{ line: 1, severity: 'warning', count: 1, messages: ['suspicious'] }
		]);
	});

	it('takes the ceiling from the settings resolver, not from a value in hand', () => {
		const store = new LspDiagnosticsStore();
		publish(store, toFileUri('/repo/a.ts'), [
			{ range: range(0, 0, 5), severity: 1, message: 'broken' },
			{ range: range(1, 0, 5), severity: 4, message: 'a hint' }
		]);

		// The layered resolver the app resolves against: a user value, overridden
		// by the workspace.
		const resolver = new SettingsResolver(
			() => LSP_SCHEMA,
			() => ({ lsp: { max_severity: 'error' } }),
			() => ({ lsp: { max_severity: 'hint' } })
		);
		const editor = editorFor(
			store,
			'/repo/a.ts',
			DOC,
			(namespace, key) => resolver.get(namespace, key)
		);

		expect(marksIn(editor.state).map((mark) => mark.title)).toEqual(['broken', 'a hint']);
		expect(gutterMarksIn(editor.state).map((mark) => mark.severity)).toEqual(['error', 'hint']);
	});

	it('marks the line a finding is on, with the findings it stands for', () => {
		const store = new LspDiagnosticsStore();
		publish(store, toFileUri('/repo/a.ts'), [
			{ range: range(0, 0, 5), severity: 2, message: 'first' },
			{ range: range(0, 6, 7), severity: 1, message: 'second' },
			{ range: range(1, 0, 5), severity: 3, message: 'third' }
		]);

		const editor = editorFor(store, '/repo/a.ts', DOC);

		expect(gutterMarksIn(editor.state).map(markOf)).toEqual([
			// The line's worst finding, and how many it carries.
			{ line: 0, severity: 'error', count: 2, messages: ['first', 'second'] },
			{ line: 1, severity: 'info', count: 1, messages: ['third'] }
		]);
	});

	it('keeps the gutter mark on the line it described after an edit', () => {
		const store = new LspDiagnosticsStore();
		publish(store, toFileUri('/repo/a.ts'), [
			{ range: range(1, 0, 5), severity: 1, message: 'later line' }
		]);
		const editor = editorFor(store, '/repo/a.ts', DOC);
		expect(gutterMarksIn(editor.state).map((mark) => mark.line)).toEqual([1]);

		// A line typed above pushes the finding's line down. The mark follows
		// the text it described rather than staying on the number the server
		// named, the same rule the inline marks follow (ADR 0022).
		const inserted = 'let x = 0;\n';
		const edited = editor.state.update({
			changes: { from: 0, to: 0, insert: inserted }
		}).state;

		expect(gutterMarksIn(edited).map((mark) => mark.line)).toEqual([2]);
	});

	it('shows what a push-only server said, unchanged', () => {
		// A server that answers no pull publishes and nothing else. The display
		// reads the merged store (ADR 0029) and the merged store holds exactly
		// what the push carried, so the marks are the server's findings and not
		// a narrower version of them.
		const store = new LspDiagnosticsStore();
		publish(store, toFileUri('/repo/a.ts'), [
			{ range: range(0, 0, 5), severity: 1, message: 'a is broken' },
			{ range: range(1, 0, 5), severity: 2, message: 'b is suspicious' }
		]);
		const editor = editorFor(store, '/repo/a.ts', DOC);

		expect(marksIn(editor.state).map((mark) => mark.title)).toEqual([
			'a is broken',
			'b is suspicious'
		]);
		expect(gutterMarksIn(editor.state).map(markOf)).toEqual([
			{ line: 0, severity: 'error', count: 1, messages: ['a is broken'] },
			{ line: 1, severity: 'warning', count: 1, messages: ['b is suspicious'] }
		]);
	});

	it('paints differently as soon as the setting changes', () => {
		const store = new LspDiagnosticsStore();
		publish(store, toFileUri('/repo/a.ts'), [
			{ range: range(0, 0, 5), severity: 1, message: 'a is broken' }
		]);

		let inline: unknown = true;
		const editor = editorFor(store, '/repo/a.ts', DOC, (namespace, key) =>
			namespace === 'lsp' && key === 'inline_diagnostics' ? inline : undefined
		);
		expect(marksIn(editor.state)).toHaveLength(1);

		// The display reads the settings when it re-reads, so a switch is one
		// transaction away — the plugin asks for that re-read rather than
		// waiting for the next keystroke.
		inline = false;
		expect(marksIn(editor.state.update({}).state)).toHaveLength(0);
	});
});

/**
 * The plugin's own settings, wired into the host (issue #310).
 *
 * The namespace is the plugin's (ADR 0014), and a setting that changes has to
 * reach the editor while it sits idle: a switch that only takes effect on the
 * next keystroke is a switch a user has learned to distrust.
 */
describe('The plugin owns its display settings (#310)', () => {
	it('registers its own namespace with the two keys and their defaults', async () => {
		const host = new PluginHost({ platform: 'desktop' });
		host.register(lspRegistration);
		await host.activate('lsp');
		cleanups.push(async () => {
			if (host.isPluginActive('lsp')) await host.deactivate('lsp');
		});

		const schema = host.getSettingSchema('lsp');
		expect(schema?.properties.inline_diagnostics?.default).toBe(true);
		expect(schema?.properties.max_severity?.default).toBe('hint');
	});

	it('asks the editor to re-read the display when a setting changes', async () => {
		const host = new PluginHost({ platform: 'desktop' });
		const listeners: Array<() => void> = [];
		host.provideService(SETTINGS_READER_SERVICE_KEY, {
			read: () => undefined,
			subscribe: (listener: () => void) => {
				listeners.push(listener);
				return () => {};
			}
		});
		host.register(lspRegistration);
		await host.activate('lsp');
		cleanups.push(async () => {
			if (host.isPluginActive('lsp')) await host.deactivate('lsp');
		});

		expect(listeners.length).toBeGreaterThan(0);
		const before = host.editorRevision;
		for (const listener of listeners) listener();
		// The repaint is coalesced per tick, so it lands after the microtask.
		await Promise.resolve();
		expect(host.editorRevision).toBeGreaterThan(before);
	});
});
