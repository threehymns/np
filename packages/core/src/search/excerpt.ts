import { EditorState, Transaction } from '@codemirror/state';
import { history, historyField } from '@codemirror/commands';
import type { SearchMatch, FileSearchResult } from './types';
import type { FileOrigin } from '../storage';
import { toURI } from '../storage';
import { DocumentSession } from '../document.svelte';
import type { Workspace } from '../workspace.svelte';

export interface SingleEdit {
	from: number;
	to: number;
	insert: string;
}

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
	readonly bufferText: string = '';
	readonly separator: string;
	private fileContent: string;

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
	 * Maps an offset in the excerpt buffer to the 0-based character offset in the source file.
	 * Returns null if the offset falls into a separator between excerpts or out of bounds.
	 */
	excerptOffsetToFileOffset(bufferOffset: number): number | null {
		if (bufferOffset < 0 || bufferOffset > this.bufferText.length) {
			return null;
		}

		for (const segment of this.excerpts) {
			if (bufferOffset >= segment.bufferStart && bufferOffset <= segment.bufferEnd) {
				const delta = bufferOffset - segment.bufferStart;
				return segment.fileStart + delta;
			}
		}

		return null;
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
	 */
	mapExcerptEditToFileEdit(edit: SingleEdit): SingleEdit | null {
		const fileFrom = this.excerptOffsetToFileOffset(edit.from);
		const fileTo = this.excerptOffsetToFileOffset(edit.to);
		if (fileFrom === null || fileTo === null) {
			return null;
		}
		return { from: fileFrom, to: fileTo, insert: edit.insert };
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
 * Applies per-file transactions so each file can be independently undone.
 * Composes with unsaved changes without warnings or confirmation modals.
 */
export async function applyReplaceAll(options: {
	workspace: Workspace;
	fileResults: FileSearchResult[];
	replacement: string;
}): Promise<{ modifiedFiles: string[]; totalReplacements: number }> {
	const { workspace, fileResults, replacement } = options;
	let totalReplacements = 0;
	const modifiedFiles: string[] = [];

	for (const result of fileResults) {
		if (result.matches.length === 0) continue;

		// 1. Find or load DocumentSession
		let doc = workspace.documents.find(
			(d) =>
				d.origin &&
				(toURI(d.origin) === toURI(result.origin) || d.origin.path.endsWith(result.filepath))
		);

		if (!doc) {
			const content = await workspace.project.storage.readFile(result.origin);
			doc = new DocumentSession(workspace.project.storage, content, result.origin);
			if (typeof workspace.project.storage?.queryPermission === 'function') {
				doc.refreshPermissionState(workspace.project.coversOrigin(result.origin));
			} else {
				doc.markPermissionGranted();
			}
			workspace.documents.push(doc);
			workspace.tabs.push({ id: doc.id, type: 'document' });
			workspace.pluginHost?.emit('document:opened', { document: doc, origin: doc.origin });
		}

		// 2. Compute non-overlapping edits for this file
		const fileEdits = buildReplaceAllEditsForFile(result.matches, replacement, doc.content);
		if (fileEdits.length > 0) {
			applyEditsToDocumentSession(doc, fileEdits, workspace);
			totalReplacements += fileEdits.length;
			modifiedFiles.push(result.filepath);
		}
	}

	return { modifiedFiles, totalReplacements };
}
