import {
	Facet,
	StateField,
	type EditorState,
	type Line,
	type Text
} from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import type { EditorContribution } from '../editor';
import type {
	LspDiagnostic,
	LspDiagnosticSeverity,
	LspDiagnosticsStore,
	LspRange
} from './diagnostics';

/**
 * Diagnostics as editor marks (spec #263, ticket #266, ADR 0016).
 *
 * The plugin never sees the view, so this is a contributed CodeMirror extension
 * and nothing more: a source facet naming the document the editor is showing,
 * a state field holding the marks for that document, and the styles those marks
 * need. There is no new pane and no dispatch from plugin code.
 *
 * Which document an editor is showing arrives through the facet rather than
 * being captured, because the field itself is shared by every view while the
 * document is not. That is also what stops one file's errors appearing on
 * another: the marks are looked up by the URI the view reports, never carried
 * over from whichever document published last.
 */
export const LSP_DIAGNOSTIC_DECORATION_ID = 'lsp-diagnostics';

export interface LspDiagnosticSource {
	/** URI of the document the editor is showing, or null for none. */
	currentUri(): string | null;
	readonly store: LspDiagnosticsStore;
}

/**
 * First input wins. Two owners would each be answering for the same editor, and
 * picking one by registration order would make the marks depend on which plugin
 * enabled first.
 */
export const lspDiagnosticSourceFacet = Facet.define<LspDiagnosticSource, LspDiagnosticSource | null>(
	{ combine: (values) => values[0] ?? null }
);

/** Identity of what the marks describe: the shown URI and the store revision. */
interface DiagnosticMarks {
	readonly stamp: string;
	readonly marks: DecorationSet;
}

export const lspDiagnosticField = StateField.define<DiagnosticMarks>({
	create(state) {
		return readMarks(state);
	},
	update(value, transaction) {
		const stamp = stampFor(transaction.state);
		if (stamp === value.stamp) {
			// Positions are line/character pairs against the text the server
			// answered for, so an edit moves them without invalidating the report.
			// Mapping keeps each mark on the characters it described until the
			// server publishes again.
			return transaction.docChanged
				? { stamp, marks: value.marks.map(transaction.changes) }
				: value;
		}
		return readMarks(transaction.state, stamp);
	},
	// A function-valued decoration input is re-evaluated on every view update,
	// which is what lets marks that arrived from a pipe reach the screen: the
	// field recomputes first, and this is where the view reads the result.
	provide: (field) => EditorView.decorations.of((view) => view.state.field(field).marks)
});

export function diagnosticMarkClass(severity: LspDiagnosticSeverity): string {
	return `cm-lsp-diagnostic cm-lsp-diagnostic-${severity}`;
}

/**
 * The marks for one document's diagnostics.
 *
 * Positions are resolved against the document as it is now and clamped, because
 * a report can be about text that has since moved: an answer computed against a
 * longer document would put every range out of bounds, and one computed against
 * a shorter document would point past its end. Neither is worth dropping the
 * report over, since the next publish replaces it.
 */
export function diagnosticDecorations(
	doc: Text,
	diagnostics: readonly LspDiagnostic[]
): DecorationSet {
	if (diagnostics.length === 0) return Decoration.none;
	const marks = [];
	for (const diagnostic of diagnostics) {
		const offsets = diagnosticOffsets(doc, diagnostic.range);
		if (!offsets) continue;
		marks.push(
			Decoration.mark({
				class: diagnosticMarkClass(diagnostic.severity),
				attributes: { title: diagnosticTitle(diagnostic) }
			}).range(offsets.from, offsets.to)
		);
	}
	return marks.length === 0 ? Decoration.none : Decoration.set(marks, true);
}

export function createDiagnosticEditorContribution(source: LspDiagnosticSource): EditorContribution {
	return {
		id: LSP_DIAGNOSTIC_DECORATION_ID,
		type: 'decoration',
		extension: [lspDiagnosticSourceFacet.of(source), lspDiagnosticField, diagnosticTheme],
		description: 'Underlines the language-server diagnostics of the document being edited'
	};
}

function stampFor(state: EditorState): string {
	const source = state.facet(lspDiagnosticSourceFacet);
	if (!source) return '';
	return `${source.currentUri() ?? ''}\u0000${source.store.revision}`;
}

function readMarks(state: EditorState, stamp = stampFor(state)): DiagnosticMarks {
	const source = state.facet(lspDiagnosticSourceFacet);
	const uri = source?.currentUri() ?? null;
	if (!source || !uri) return { stamp, marks: Decoration.none };
	return { stamp, marks: diagnosticDecorations(state.doc, source.store.read(uri)) };
}

function diagnosticOffsets(doc: Text, range: LspRange): { from: number; to: number } | null {
	// The protocol counts lines from zero and `Text.line` counts from one.
	const startLineNumber = range.start.line + 1;
	if (startLineNumber < 1 || startLineNumber > doc.lines) return null;
	const endLineNumber = Math.min(range.end.line + 1, doc.lines);
	if (endLineNumber < startLineNumber) return null;
	const start = doc.line(startLineNumber);
	const end = doc.line(endLineNumber);
	const from = clampToLine(start, range.start.character);
	let to = clampToLine(end, range.end.character);
	// An empty range has nothing to underline and CodeMirror rejects an empty
	// mark, so it marks the one character it points at instead. An empty line has
	// no character to mark, and underlining the line would mean inventing a
	// widget, which is presentation this slice does not have.
	if (to <= from) to = Math.min(from + 1, end.to);
	if (to <= from) return null;
	return { from, to };
}

function clampToLine(line: Line, character: number): number {
	const wanted = line.from + Math.max(0, Math.trunc(character));
	return Math.max(line.from, Math.min(line.to, wanted));
}

/** The message in the mark's tooltip: an underline on its own says nothing. */
function diagnosticTitle(diagnostic: LspDiagnostic): string {
	const source = diagnostic.source ? `${diagnostic.source}: ` : '';
	const code = diagnostic.code ? `(${diagnostic.code}) ` : '';
	return `${source}${code}${diagnostic.message}`;
}

/**
 * Squiggles in the app's own tokens. The shared editor theme has no diagnostic
 * styles and adding them there would name a feature in a file every editor
 * loads, so the colours a plugin's marks need travel with the contribution.
 */
const diagnosticTheme = EditorView.baseTheme({
	'.cm-lsp-diagnostic': {
		textDecorationLine: 'underline',
		textDecorationStyle: 'wavy',
		textDecorationSkipInk: 'none'
	},
	'.cm-lsp-diagnostic-error': { textDecorationColor: 'var(--destructive)' },
	'.cm-lsp-diagnostic-warning': { textDecorationColor: 'var(--color-amber-500)' },
	'.cm-lsp-diagnostic-info': { textDecorationColor: 'var(--muted-foreground)' },
	'.cm-lsp-diagnostic-hint': {
		textDecorationColor: 'var(--muted-foreground)',
		textDecorationStyle: 'dotted'
	}
});
