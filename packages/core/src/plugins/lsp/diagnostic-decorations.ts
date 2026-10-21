import {
	Facet,
	StateField,
	type EditorState,
	type Line,
	type Text
} from '@codemirror/state';
import {
	Decoration,
	EditorView,
	GutterMarker,
	gutter,
	type DecorationSet
} from '@codemirror/view';
import type { EditorContribution } from '../editor';
import type { SettingsRead } from '../services';
import {
	isMoreSevere,
	planDiagnosticDisplay,
	readDiagnosticDisplaySettings,
	type DiagnosticDisplaySettings,
	type DiagnosticGutterMark
} from './diagnostic-display';
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
 *
 * What is drawn is decided elsewhere, in `diagnostic-display.ts`: this file
 * turns a plan into marks. The split is the same one the store makes between
 * the protocol and the display (ADR 0022), one layer down — the plan says
 * which findings are painted and which the gutter carries, and this file knows
 * only about offsets and classes.
 */
export const LSP_DIAGNOSTIC_DECORATION_ID = 'lsp-diagnostics';
export const LSP_DIAGNOSTIC_GUTTER_ID = 'lsp-diagnostic-gutter';

export interface LspDiagnosticSource {
	/** URI of the document the editor is showing, or null for none. */
	currentUri(): string | null;
	readonly store: LspDiagnosticsStore;
	/**
	 * Reads the resolved settings the display obeys.
	 *
	 * Absent means the documented defaults: an app that publishes no settings
	 * reader gets the same answer "no platform published" already gives
	 * everywhere else in the plugin.
	 */
	readonly read?: SettingsRead;
}

/**
 * First input wins. Two owners would each be answering for the same editor, and
 * picking one by registration order would make the marks depend on which plugin
 * enabled first.
 */
export const lspDiagnosticSourceFacet = Facet.define<LspDiagnosticSource, LspDiagnosticSource | null>(
	{ combine: (values) => values[0] ?? null }
);

/**
 * A gutter mark, anchored at the offset it sits on.
 *
 * The offset rather than the line, because an offset is a place in the text
 * and a line number is a claim about it: the server's line numbers are
 * against the text it last saw, so they go stale the moment the user types.
 */
export interface DiagnosticGutterPlacement {
	/** The offset the mark is anchored at. */
	readonly offset: number;
	readonly severity: LspDiagnosticSeverity;
	readonly count: number;
	/** The findings the mark stands for. */
	readonly findings: readonly LspDiagnostic[];
}

/**
 * What the editor draws for the document it is showing.
 */
export interface DiagnosticDisplay {
	/** Identity of what this describes: the shown URI, the store revision, and the settings. */
	readonly stamp: string;
	/** The inline marks. */
	readonly marks: DecorationSet;
	/** The gutter marks, one per line that carries a finding. */
	readonly gutter: readonly DiagnosticGutterPlacement[];
}

export const lspDiagnosticField = StateField.define<DiagnosticDisplay>({
	create(state) {
		const source = state.facet(lspDiagnosticSourceFacet);
		const settings = readDiagnosticDisplaySettings(source?.read);
		return readDisplay(state, source, settings, stampFor(source, settings));
	},
	update(value, transaction) {
		const source = transaction.state.facet(lspDiagnosticSourceFacet);
		const settings = readDiagnosticDisplaySettings(source?.read);
		const stamp = stampFor(source, settings);
		if (stamp === value.stamp) {
			// Positions are line/character pairs against the text the server
			// answered for, so an edit moves them without invalidating the report.
			// Mapping keeps each mark on the characters it described until the
			// server publishes again.
			return transaction.docChanged
				? {
						stamp,
						marks: value.marks.map(transaction.changes),
						gutter: value.gutter.map((placement) => ({
							...placement,
							offset: transaction.changes.mapPos(placement.offset, -1)
						}))
					}
				: value;
		}
		return readDisplay(transaction.state, source, settings, stamp);
	},
	// A function-valued decoration input is re-evaluated on every view update,
	// which is what lets marks that arrived from a pipe reach the screen: the
	// field recomputes first, and this is where the view reads the result.
	provide: (field) => EditorView.decorations.of((view) => view.state.field(field).marks)
});

export function diagnosticMarkClass(severity: LspDiagnosticSeverity): string {
	return `cm-lsp-diagnostic cm-lsp-diagnostic-${severity}`;
}

/** The class of a gutter mark, which carries the severity in its colour. */
export function diagnosticGutterClass(severity: LspDiagnosticSeverity): string {
	return `cm-lsp-diagnostic-gutter cm-lsp-diagnostic-gutter-${severity}`;
}

/**
 * The gutter marks the editor would draw, one per line that carries a finding.
 *
 * The line is read back from the offset the mark is anchored at, so a mark
 * that followed the text through an edit is reported on the line it is now on.
 */
export function gutterMarksIn(state: EditorState): DiagnosticGutterMark[] {
	const display = state.field(lspDiagnosticField, false);
	if (!display) return [];
	return display.gutter.map((placement) => ({
		line: state.doc.lineAt(placement.offset).number - 1,
		severity: placement.severity,
		count: placement.count,
		findings: placement.findings
	}));
}

/**
 * The marks for one document's diagnostics.
 *
 * Positions are resolved against the document as it is now and clamped, because
 * a report can be about text that has since moved: an answer computed against a
 * longer document would put every range out of bounds, and one computed against a
 * shorter document would point past its end. Neither is worth dropping the
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

/**
 * The gutter half of the display: one mark per line that carries a finding.
 *
 * A separate contribution rather than another extension in the decoration one,
 * because the host keeps the two in different compartments and a gutter
 * belongs in the gutter's.
 */
export function createDiagnosticGutterContribution(
	source: LspDiagnosticSource
): EditorContribution {
	return {
		id: LSP_DIAGNOSTIC_GUTTER_ID,
		type: 'gutter',
		extension: [lspDiagnosticSourceFacet.of(source), diagnosticGutterExtension],
		description: 'Marks the lines that carry language-server diagnostics'
	};
}

/**
 * The gutter itself.
 *
 * The marks come from the state field rather than from the store, so that a
 * gutter and the inline marks always describe the same document: the field is
 * where the store, the settings and the text have already been folded
 * together, and a gutter that read the store on its own would be a second
 * answer to the same question.
 */
const diagnosticGutterExtension = gutter({
	class: 'cm-lsp-diagnostic-gutter',
	lineMarker(view, line) {
		const display = view.state.field(lspDiagnosticField, false);
		if (!display) return null;
		const mark = markForLine(display.gutter, view.state.doc, line.from, line.to);
		return mark ? new LspDiagnosticGutterMarker(mark) : null;
	},
	// The marks are read from a state field, so the gutter has to be told to
	// look again when that field's value changes — a report arriving from a
	// pipe, or a setting switching, neither of which is a keystroke.
	lineMarkerChange(update) {
		return (
			update.startState.field(lspDiagnosticField, false) !==
			update.state.field(lspDiagnosticField, false)
		);
	}
});

/**
 * The mark for one line, or nothing when the line carries no finding.
 *
 * Two marks can end up on one line when the text between them was deleted, so
 * the line shows its worst finding and the sum of its findings rather than
 * whichever mark happened to be first.
 */
function markForLine(
	placements: readonly DiagnosticGutterPlacement[],
	doc: Text,
	from: number,
	to: number
): DiagnosticGutterMark | null {
	const onLine = placements.filter(
		(placement) => placement.offset >= from && placement.offset <= to
	);
	if (onLine.length === 0) return null;
	let severity = onLine[0].severity;
	const findings: LspDiagnostic[] = [];
	for (const placement of onLine) {
		findings.push(...placement.findings);
		if (isMoreSevere(placement.severity, severity)) severity = placement.severity;
	}
	return { line: doc.lineAt(from).number - 1, severity, count: findings.length, findings };
}

/**
 * The mark in the gutter: a dot in the line's severity, carrying the
 * findings' messages as its tooltip.
 */
class LspDiagnosticGutterMarker extends GutterMarker {
	readonly mark: DiagnosticGutterMark;

	constructor(mark: DiagnosticGutterMark) {
		super();
		this.mark = mark;
	}

	eq(other: LspDiagnosticGutterMarker): boolean {
		return (
			other.mark.severity === this.mark.severity &&
			other.mark.count === this.mark.count &&
			other.mark.findings.length === this.mark.findings.length &&
			other.mark.findings.every(
				(finding, index) => finding === this.mark.findings[index]
			)
		);
	}

	toDOM(): Node {
		if (typeof document === 'undefined') {
			// Fallback for non-DOM test environments, as the git gutter does.
			return { nodeType: 1, textContent: gutterMarkText(this.mark) } as any;
		}
		const span = document.createElement('span');
		span.className = diagnosticGutterClass(this.mark.severity);
		span.textContent = gutterMarkText(this.mark);
		// The same text the inline mark carries, because the two stand for the
		// same finding: a user who reads one wants to read the other.
		span.setAttribute(
			'title',
			this.mark.findings.map((finding) => diagnosticTitle(finding)).join('\n')
		);
		return span;
	}
}

/**
 * The text of the mark: a dot, and how many findings it stands for when there
 * is more than one.
 */
function gutterMarkText(mark: DiagnosticGutterMark): string {
	return mark.count > 1 ? `●${mark.count}` : '●';
}

/**
 * Identity of what the display describes: the shown URI, the store revision,
 * and the settings.
 *
 * The settings are part of it because a switch that takes effect is a different
 * display, and the field has to notice it the way it notices a new report —
 * neither is a keystroke.
 */
function stampFor(
	source: LspDiagnosticSource | null,
	settings: DiagnosticDisplaySettings
): string {
	if (!source) return '';
	return `${source.currentUri() ?? ''}\u0000${source.store.revision}\u0000${
		settings.inline ? '1' : '0'
	}\u0000${settings.maxSeverity}`;
}

function readDisplay(
	state: EditorState,
	source: LspDiagnosticSource | null,
	settings: DiagnosticDisplaySettings,
	stamp: string
): DiagnosticDisplay {
	const uri = source?.currentUri() ?? null;
	if (!source || !uri) return { stamp, marks: Decoration.none, gutter: [] };
	const plan = planDiagnosticDisplay(source.store.read(uri), settings);
	return {
		stamp,
		marks: diagnosticDecorations(state.doc, plan.inline),
		gutter: placeGutterMarks(state.doc, plan.gutter)
	};
}

/**
 * The gutter marks, anchored at the line they stand for.
 *
 * A mark is anchored at the *start* of its line rather than at the finding's
 * first character, because a line start is a stable place: it moves with the
 * text above it and stays a line start when the text below it is edited. The
 * finding's own offset is not stable in the same way, and a mark that jumped
 * to a character the server never named is the bug the inline marks avoid by
 * mapping (ADR 0022).
 */
function placeGutterMarks(
	doc: Text,
	marks: readonly DiagnosticGutterMark[]
): DiagnosticGutterPlacement[] {
	const placed: DiagnosticGutterPlacement[] = [];
	for (const mark of marks) {
		const lineNumber = mark.line + 1;
		if (lineNumber < 1 || lineNumber > doc.lines) continue;
		placed.push({
			offset: doc.line(lineNumber).from,
			severity: mark.severity,
			count: mark.count,
			findings: mark.findings
		});
	}
	return placed;
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
	},
	'.cm-lsp-diagnostic-gutter': {
		fontSize: '0.75em',
		lineHeight: 1
	},
	'.cm-lsp-diagnostic-gutter-error': { color: 'var(--destructive)' },
	'.cm-lsp-diagnostic-gutter-warning': { color: 'var(--color-amber-500)' },
	'.cm-lsp-diagnostic-gutter-info': { color: 'var(--muted-foreground)' },
	'.cm-lsp-diagnostic-gutter-hint': { color: 'var(--muted-foreground)', opacity: '0.7' }
});
