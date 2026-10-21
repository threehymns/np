import { EditorState, Transaction } from '@codemirror/state';
import { history, historyField } from '@codemirror/commands';
import type {
	SearchMatch,
	FileSearchResult,
	SearchQuery,
	SingleEdit,
	ReplaceAllFileChange,
	ReplaceAllUndo
} from './types';
import type { FileOrigin } from '../storage';
import { toURI } from '../storage';
import { buildSearchRegex, findMatchesInContent } from './engine';
import type { DocumentSession } from '../document.svelte';
import type { Workspace } from '../workspace.svelte';

export type { SingleEdit, ReplaceAllFileChange, ReplaceAllUndo };

export interface ExcerptSegment {
	id: string;
	/** 0-based character start in source file */
	fileStart: number;
	/** 0-based character end in source file */
	fileEnd: number;
	/** 1-based start line in source file */
	startLine: number;
	/** 1-based end line in source file */
	endLine: number;
	/** Text of this excerpt from source file */
	text: string;
	/** Matches inside this excerpt */
	matches: SearchMatch[];
	/** 0-based start in excerpt buffer */
	bufferStart: number;
	/** 0-based end in excerpt buffer */
	bufferEnd: number;
}

export interface ExcerptMapOptions {
	contextLines?: number;
	separator?: string;
}

export function computeLineStarts(content: string): number[] {
	const lineStarts: number[] = [0];
	for (let i = 0; i < content.length; i++) {
		if (content[i] === '\n') {
			lineStarts.push(i + 1);
		}
	}
	return lineStarts;
}

/**
 * Maps coordinates between an excerpt multibuffer and a source file.
 * Handles merging adjacent and overlapping matches into continuous excerpts.
 */
export class FileExcerptMap {
	readonly filepath: string;
	readonly origin: FileOrigin;
	readonly excerpts: ExcerptSegment[] = [];
	/** Current excerpt buffer text; updated by applyExcerptEdit after direct edits */
	bufferText: string = '';
	readonly separator: string;
	/**
	 * The file content the map was built from. Every file offset the map
	 * hands out is relative to this text, so a map whose content no longer
	 * matches the document would write an edit to the wrong place.
	 */
	fileContent: string;

	constructor(
		filepath: string,
		origin: FileOrigin,
		fileContent: string,
		matches: SearchMatch[],
		options?: ExcerptMapOptions
	) {
		this.filepath = filepath;
		this.origin = origin;
		this.fileContent = fileContent;
		const contextLines = options?.contextLines ?? 1;
		this.separator = options?.separator ?? '\n---\n';

		if (matches.length === 0) {
			this.bufferText = '';
			return;
		}

		const lineStarts = computeLineStarts(fileContent);
		const totalLines = lineStarts.length;

		const getLineBounds = (lineNum: number): { start: number; end: number } => {
			const clamped = Math.max(1, Math.min(lineNum, totalLines));
			const start = lineStarts[clamped - 1];
			const end = clamped < totalLines ? lineStarts[clamped] : fileContent.length;
			return { start, end };
		};

		// 1. Compute raw line and character ranges for each match
		interface RawRange {
			startLine: number;
			endLine: number;
			fileStart: number;
			fileEnd: number;
			matches: SearchMatch[];
		}

		// Sort matches by offset ascending
		const sortedMatches = [...matches].sort((a, b) => a.offset - b.offset);

		const rawRanges: RawRange[] = sortedMatches.map((m) => {
			const startLine =
				m.contextBefore.length > 0
					? m.contextBefore[0].line
					: Math.max(1, m.line - contextLines);
			const endLine =
				m.contextAfter.length > 0
					? m.contextAfter[m.contextAfter.length - 1].line
					: Math.min(totalLines, m.line + contextLines);

			const fileStart = lineStarts[Math.max(1, startLine) - 1];
			const fileEnd = getLineBounds(endLine).end;

			return {
				startLine,
				endLine,
				fileStart,
				fileEnd,
				matches: [m]
			};
		});

		// 2. Merge overlapping or adjacent ranges
		const mergedRanges: RawRange[] = [];
		for (const range of rawRanges) {
			if (mergedRanges.length === 0) {
				mergedRanges.push({ ...range, matches: [...range.matches] });
				continue;
			}

			const prev = mergedRanges[mergedRanges.length - 1];
			// Merge if line ranges touch/overlap, or character ranges touch/overlap
			const linesAdjacentOrOverlap = range.startLine <= prev.endLine + 1;
			const offsetsAdjacentOrOverlap = range.fileStart <= prev.fileEnd;

			if (linesAdjacentOrOverlap || offsetsAdjacentOrOverlap) {
				prev.endLine = Math.max(prev.endLine, range.endLine);
				prev.fileEnd = Math.max(prev.fileEnd, range.fileEnd);
				prev.matches.push(...range.matches);
			} else {
				mergedRanges.push({ ...range, matches: [...range.matches] });
			}
		}

		// 3. Construct segments and buffer text
		let currentBufferOffset = 0;
		const bufferParts: string[] = [];

		for (let i = 0; i < mergedRanges.length; i++) {
			const r = mergedRanges[i];
			const text = fileContent.slice(r.fileStart, r.fileEnd);

			if (i > 0) {
				bufferParts.push(this.separator);
				currentBufferOffset += this.separator.length;
			}

			const bufferStart = currentBufferOffset;
			const bufferEnd = bufferStart + text.length;
			currentBufferOffset = bufferEnd;
			bufferParts.push(text);

			this.excerpts.push({
				id: `${filepath}-${i}`,
				fileStart: r.fileStart,
				fileEnd: r.fileEnd,
				startLine: r.startLine,
				endLine: r.endLine,
				text,
				matches: r.matches,
				bufferStart,
				bufferEnd
			});
		}

		this.bufferText = bufferParts.join('');
	}

	/**
	 * Finds the excerpt segment containing a buffer offset, or null when the
	 * offset falls into a separator between excerpts or out of bounds.
	 */
	private segmentAtBufferOffset(bufferOffset: number): ExcerptSegment | null {
		if (bufferOffset < 0 || bufferOffset > this.bufferText.length) {
			return null;
		}

		for (const segment of this.excerpts) {
			if (bufferOffset >= segment.bufferStart && bufferOffset <= segment.bufferEnd) {
				return segment;
			}
		}

		return null;
	}

	/**
	 * Maps an offset in the excerpt buffer to the 0-based character offset in the source file.
	 * Returns null if the offset falls into a separator between excerpts or out of bounds.
	 */
	excerptOffsetToFileOffset(bufferOffset: number): number | null {
		const segment = this.segmentAtBufferOffset(bufferOffset);
		if (!segment) {
			return null;
		}
		const delta = bufferOffset - segment.bufferStart;
		return segment.fileStart + delta;
	}

	/**
	 * Maps an offset in the source file to the 0-based character offset in the excerpt buffer.
	 * Returns null if the offset is not contained in any excerpt of this file.
	 */
	fileOffsetToExcerptOffset(fileOffset: number): number | null {
		if (fileOffset < 0 || fileOffset > this.fileContent.length) {
			return null;
		}

		for (const segment of this.excerpts) {
			if (fileOffset >= segment.fileStart && fileOffset <= segment.fileEnd) {
				const delta = fileOffset - segment.fileStart;
				return segment.bufferStart + delta;
			}
		}

		return null;
	}

	/**
	 * Maps a single edit { from, to, insert } from excerpt buffer coordinates to file coordinates.
	 * Returns null when either endpoint falls in a separator between excerpts or when the
	 * edit spans more than one segment: mapping the endpoints independently would silently
	 * delete file text that is hidden between the excerpts.
	 */
	mapExcerptEditToFileEdit(edit: SingleEdit): SingleEdit | null {
		const segment = this.segmentAtBufferOffset(edit.from);
		if (
			!segment ||
			edit.to < segment.bufferStart ||
			edit.to > segment.bufferEnd
		) {
			return null;
		}
		return {
			from: segment.fileStart + (edit.from - segment.bufferStart),
			to: segment.fileStart + (edit.to - segment.bufferStart),
			insert: edit.insert
		};
	}

	/**
	 * Maps a single edit { from, to, insert } from file coordinates to excerpt buffer coordinates.
	 */
	mapFileEditToExcerptEdit(edit: SingleEdit): SingleEdit | null {
		const bufFrom = this.fileOffsetToExcerptOffset(edit.from);
		const bufTo = this.fileOffsetToExcerptOffset(edit.to);
		if (bufFrom === null || bufTo === null) {
			return null;
		}
		return { from: bufFrom, to: bufTo, insert: edit.insert };
	}

	/**
	 * Maps multiple edits from excerpt coordinates to file coordinates.
	 */
	mapExcerptEditsToFileEdits(edits: SingleEdit[]): SingleEdit[] {
		const result: SingleEdit[] = [];
		for (const edit of edits) {
			const mapped = this.mapExcerptEditToFileEdit(edit);
			if (mapped) result.push(mapped);
		}
		return result;
	}

	/**
	 * Keeps segment bounds in sync after a direct edit to the excerpt buffer.
	 * `edit` is in pre-edit buffer coordinates (as CodeMirror's iterChanges
	 * reports fromA/toA). Pass the file edit produced by
	 * `mapExcerptEditToFileEdit` for the same change, or null when the edit
	 * did not reach the file (e.g. it landed in a separator), so the
	 * file-side bounds shift only when the file actually changed.
	 * Without this, a length-changing edit leaves later segment bounds stale
	 * and subsequent edits map to wrong file offsets.
	 */
	applyExcerptEdit(edit: SingleEdit, fileEdit: SingleEdit | null): void {
		const bufferDelta = edit.insert.length - (edit.to - edit.from);
		this.bufferText =
			this.bufferText.slice(0, edit.from) + edit.insert + this.bufferText.slice(edit.to);
		if (bufferDelta !== 0) {
			// Identify the owning segment first: an insertion at a segment's
			// end belongs to that segment (segmentAtBufferOffset is inclusive
			// of bufferEnd), so the owner's end must grow. Later segments shift;
			// the owner resizes.
			const owner = this.segmentAtBufferOffset(edit.from);
			for (const segment of this.excerpts) {
				if (segment === owner) {
					segment.bufferEnd = Math.max(
						segment.bufferStart,
						segment.bufferEnd + bufferDelta
					);
				} else if (segment.bufferStart >= edit.to) {
					segment.bufferStart += bufferDelta;
					segment.bufferEnd += bufferDelta;
				}
			}
		}

		if (fileEdit) {
			const fileDelta = fileEdit.insert.length - (fileEdit.to - fileEdit.from);
			this.fileContent =
				this.fileContent.slice(0, fileEdit.from) +
				fileEdit.insert +
				this.fileContent.slice(fileEdit.to);
			if (fileDelta !== 0) {
				const fileOwner = this.excerpts.find(
					(s) => fileEdit.from >= s.fileStart && fileEdit.from <= s.fileEnd
				);
				for (const segment of this.excerpts) {
					if (segment === fileOwner) {
						segment.fileEnd = Math.max(
							segment.fileStart,
							segment.fileEnd + fileDelta
						);
					} else if (segment.fileStart >= fileEdit.to) {
						segment.fileStart += fileDelta;
						segment.fileEnd += fileDelta;
					}
				}
			}
		}
	}
}

/**
 * True when the document no longer holds the content an excerpt map was
 * built from. The map hands out file offsets relative to that content, so a
 * stale map would write an edit to the wrong place in the file.
 *
 * A document that is not open has no content to compare against: the map
 * mirrors the file on disk, and the snapshot search covers that case.
 */
export function isExcerptMapStale(map: FileExcerptMap, documentContent: string | undefined): boolean {
	if (documentContent === undefined) return false;
	return map.fileContent !== documentContent;
}

export interface ExcerptMapBuild {
	/** The map for the given content. */
	map: FileExcerptMap;
	/** The matches the map was built from, re-derived from the content. */
	matches: SearchMatch[];
}

/**
 * Builds an excerpt map for the current content of a file, re-deriving the
 * file's matches from the query.
 *
 * A map built from older content hands out offsets that no longer point at
 * the text the user sees, so a map that has to survive a change made
 * elsewhere has to start from the content the document holds now. The
 * query's own options (regular expression, case sensitivity, whole word)
 * decide how the matches are found, exactly as they did for the search.
 *
 * Returns null when the query is not a usable pattern, for example an
 * invalid regular expression: the caller keeps the map it has rather than
 * replacing it with an empty one.
 */
export function buildExcerptMapForContent(
	filepath: string,
	origin: FileOrigin,
	content: string,
	query: SearchQuery,
	contextLines = 1
): ExcerptMapBuild | null {
	let regex: RegExp;
	try {
		regex = buildSearchRegex(query);
	} catch {
		return null;
	}

	const { matches } = findMatchesInContent(
		content,
		regex,
		contextLines,
		Number.POSITIVE_INFINITY
	);

	return {
		map: new FileExcerptMap(filepath, origin, content, matches, { contextLines }),
		matches
	};
}

/**
 * Builds non-overlapping file-coordinate replacement edits for all matches in a file.
 * Handles adjacent matches cleanly; skips or merges overlapping matches so CodeMirror
 * receives valid, strictly non-overlapping change ranges.
 */
export function buildReplaceAllEditsForFile(
	matches: SearchMatch[],
	replacement: string,
	fileContent?: string
): SingleEdit[] {
	if (matches.length === 0) return [];

	// Sort ascending by offset
	const sorted = [...matches].sort((a, b) => a.offset - b.offset);

	const edits: SingleEdit[] = [];
	let lastEnd = -1;

	for (const m of sorted) {
		// Skip matches whose text no longer sits at the recorded offset: the
		// document may have changed since the search ran (e.g. unsaved edits).
		// The original matched text is recovered from the match's own
		// line/column, so this holds for literal, case-insensitive, and regex
		// matches alike. When the original text can't be recovered (e.g. a
		// multi-line regex match), fall back to the previous behavior.
		const originalText = m.lineText.slice(m.column - 1, m.column - 1 + m.matchLength);
		if (
			fileContent !== undefined &&
			originalText.length === m.matchLength &&
			fileContent.slice(m.offset, m.offset + m.matchLength) !== originalText
		) {
			continue;
		}

		// If match starts at or after the end of the previous match, it is non-overlapping (adjacent is valid!)
		if (m.offset >= lastEnd) {
			edits.push({
				from: m.offset,
				to: m.offset + m.matchLength,
				insert: replacement
			});
			lastEnd = m.offset + m.matchLength;
		}
		// If m.offset < lastEnd, it overlaps with the previous match and is skipped
	}

	return edits;
}

/**
 * Dispatches edits to a DocumentSession as one atomic transaction, preserving undo history per file.
 */
export function applyEditsToDocumentSession(
	doc: DocumentSession,
	edits: SingleEdit[],
	workspace?: Workspace
): void {
	if (edits.length === 0) return;

	// Sort ascending by 'from'
	const sorted = [...edits].sort((a, b) => a.from - b.from || a.to - b.to);

	// Rehydrate or create an EditorState with history extension so undo history is tracked per file
	let baseState: EditorState;
	if (doc.editorState && typeof (doc.editorState as any).update === 'function') {
		baseState = doc.editorState;
	} else if (doc.editorState && typeof doc.editorState === 'object') {
		try {
			baseState = EditorState.fromJSON(
				doc.editorState,
				{ extensions: [history()] },
				{ history: historyField }
			);
		} catch {
			baseState = EditorState.create({
				doc: doc.content,
				extensions: [history()]
			});
		}
	} else {
		baseState = EditorState.create({
			doc: doc.content,
			extensions: [history()]
		});
	}

	// The document content is the source of truth. A stale editorState — for
	// example the main editor's state from before an external content update —
	// would misalign every edit offset, so rebuild from the current content.
	// The history extension is kept so per-file undo still works.
	if (baseState.doc.toString() !== doc.content) {
		baseState = EditorState.create({
			doc: doc.content,
			extensions: [history()]
		});
	}

	const tr = baseState.update({ changes: sorted });
	doc.editorState = tr.state.toJSON({ history: historyField });
	doc.content = tr.state.doc.toString();
	doc.incrementRevision();

	if (workspace) {
		workspace.updateDocumentContent(doc, doc.content);
	}
}

/**
 * Replaces all occurrences across all search results in one action.
 *
 * A file that is open is changed in its document, the way a keystroke
 * would: the user saves it, and the file's own history can undo it. A
 * file that is not open is written, because a replace-all that opened a
 * tab for every file it touched buried the user's window in tabs, and
 * the tab was only ever there to host an undo the search tab now owns.
 *
 * The operation is returned as an undo record, so the search tab can
 * undo the whole thing in one step.
 */
export async function applyReplaceAll(options: {
	workspace: Workspace;
	fileResults: FileSearchResult[];
	replacement: string;
}): Promise<{
	modifiedFiles: string[];
	totalReplacements: number;
	undo: ReplaceAllUndo;
}> {
	const { workspace, fileResults, replacement } = options;
	let totalReplacements = 0;
	const modifiedFiles: string[] = [];
	const changes: ReplaceAllFileChange[] = [];

	for (const result of fileResults) {
		if (result.matches.length === 0) continue;

		// 1. Find the open document. Match by exact URI only: a path-suffix
		// fallback can resolve to a different file that happens to share
		// the same filename.
		const doc = workspace.documents.find(
			(d) => d.origin && toURI(d.origin) === toURI(result.origin)
		);

		if (doc) {
			// 2. The file is open: the change belongs to its document.
			const before = doc.content;
			const fileEdits = buildReplaceAllEditsForFile(result.matches, replacement, doc.content);
			if (fileEdits.length === 0) continue;
			applyEditsToDocumentSession(doc, fileEdits, workspace);
			totalReplacements += fileEdits.length;
			modifiedFiles.push(result.filepath);
			changes.push({ origin: result.origin, before, doc });
			continue;
		}

		// 3. The file is not open: write it. The user's next visit to the
		// file finds the replacement already in it.
		let content: string;
		try {
			content = await workspace.project.storage.readFile(result.origin);
		} catch {
			// A file that cannot be read is left alone.
			continue;
		}
		const fileEdits = buildReplaceAllEditsForFile(result.matches, replacement, content);
		if (fileEdits.length === 0) continue;
		try {
			// saveFile with the file's own origin writes it in place: the
			// picker is only for a file that has no origin yet.
			await workspace.project.storage.saveFile(
				applyEditsToText(content, fileEdits),
				result.origin
			);
		} catch {
			// A file that cannot be written is left alone.
			continue;
		}
		totalReplacements += fileEdits.length;
		modifiedFiles.push(result.filepath);
		changes.push({ origin: result.origin, before: content, doc: null });
	}

	return { modifiedFiles, totalReplacements, undo: { changes } };
}

/**
 * Undoes a replace-all operation: every file it changed goes back to what
 * it held before, in the reverse order the operation changed them.
 */
export async function undoReplaceAll(undo: ReplaceAllUndo, workspace: Workspace): Promise<void> {
	for (const change of [...undo.changes].reverse()) {
		if (change.doc) {
			// The change went into an open document: put the document back
			// the way it was, through the same path the change took, so the
			// editor's state and history follow. The whole content is
			// restored, because one replace-all is one operation: the edits
			// it made are not separable from what came after them.
			const current = change.doc.content;
			if (current === change.before) continue;
			applyEditsToDocumentSession(
				change.doc,
				[{ from: 0, to: current.length, insert: change.before }],
				workspace
			);
			continue;
		}
		try {
			await workspace.project.storage.saveFile(change.before, change.origin);
		} catch {
			// A file that cannot be written back stays as it is.
		}
	}
}

/**
 * Applies edits to text. The edits address the text as it was before
 * them, so they are applied from the last one backwards.
 */
export function applyEditsToText(text: string, edits: SingleEdit[]): string {
	let result = text;
	for (const edit of [...edits].sort((a, b) => b.from - a.from)) {
		result = result.slice(0, edit.from) + edit.insert + result.slice(edit.to);
	}
	return result;
}

