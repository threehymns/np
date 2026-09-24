import {
	Compartment,
	StateEffect,
	StateField,
	type Extension,
	type Transaction
} from '@codemirror/state';
import {
	EditorView,
	Decoration,
	type DecorationSet,
	gutter,
	GutterMarker,
	keymap
} from '@codemirror/view';
import type { DocumentSession } from '../document.svelte';
import {
	DirectEditorViewAccessError,
	RawTransactionDispatchError,
	DocumentRevisionMismatchError,
	DuplicateEditorContributionIdError
} from './errors';

/**
 * Categories of editor contributions corresponding to the host's configuration compartments (ADR 0016).
 */
export type EditorContributionType = 'gutter' | 'decoration' | 'keybinding';

/**
 * A CodeMirror extension declared as a contribution by a plugin.
 * The host places these into the correct compartments of its single composed configuration.
 */
export interface EditorContribution {
	/** Unique identifier within the contributing plugin */
	readonly id: string;
	/** The category of contribution */
	readonly type: EditorContributionType;
	/** CodeMirror extension (or array of extensions) provided */
	readonly extension: Extension;
	/**
	 * Priority for ordering within the compartment.
	 * Higher priority comes earlier. Defaults to 0.
	 */
	readonly priority?: number;
	/**
	 * Optional language filter (e.g. 'markdown').
	 * If omitted, the contribution applies to all languages.
	 */
	readonly language?: string;
	/** Optional human-readable description */
	readonly description?: string;
}

/**
 * Paired contribution and owner plugin ID.
 */
export interface EditorContributionEntry {
	readonly pluginId: string;
	readonly contribution: EditorContribution;
}

/**
 * Host-managed compartments for editor contributions.
 */
export interface EditorCompartments {
	readonly gutterCompartment: Compartment;
	readonly decorationsCompartment: Compartment;
	readonly keybindingsCompartment: Compartment;
}

/**
 * Creates fresh CodeMirror compartments for the editor contribution categories.
 */
export function createEditorContributionCompartments(): EditorCompartments {
	return {
		gutterCompartment: new Compartment(),
		decorationsCompartment: new Compartment(),
		keybindingsCompartment: new Compartment()
	};
}

/**
 * Filters and sorts contributions deterministically for a compartment and optional language.
 */
export function getContributionsForType(
	entries: readonly EditorContributionEntry[],
	type: EditorContributionType,
	language?: string
): EditorContributionEntry[] {
	return entries
		.filter((e) => {
			if (e.contribution.type !== type) return false;
			if (!e.contribution.language) return true;
			if (!language) return false;
			return e.contribution.language.toLowerCase() === language.toLowerCase();
		})
		.sort((a, b) => {
			const priorityA = a.contribution.priority ?? 0;
			const priorityB = b.contribution.priority ?? 0;
			if (priorityA !== priorityB) {
				return priorityB - priorityA; // higher priority first
			}
			if (a.pluginId !== b.pluginId) {
				return a.pluginId.localeCompare(b.pluginId);
			}
			return a.contribution.id.localeCompare(b.contribution.id);
		});
}

/**
 * Extracts the raw extensions from sorted contribution entries.
 */
export function getExtensionsForType(
	entries: readonly EditorContributionEntry[],
	type: EditorContributionType,
	language?: string
): Extension[] {
	return getContributionsForType(entries, type, language).map((e) => e.contribution.extension);
}

/**
 * Composes contributions into the host's compartments for an editor configuration.
 */
export function composeEditorContributions(
	entries: readonly EditorContributionEntry[],
	compartments: EditorCompartments,
	language?: string
): Extension[] {
	return [
		compartments.gutterCompartment.of(getExtensionsForType(entries, 'gutter', language)),
		compartments.decorationsCompartment.of(getExtensionsForType(entries, 'decoration', language)),
		compartments.keybindingsCompartment.of(getExtensionsForType(entries, 'keybinding', language))
	];
}

/**
 * Generates reconfiguration effects to update compartments when contributions change.
 */
export function reconfigureEditorContributions(
	entries: readonly EditorContributionEntry[],
	compartments: EditorCompartments,
	language?: string
): StateEffect<unknown>[] {
	return [
		compartments.gutterCompartment.reconfigure(getExtensionsForType(entries, 'gutter', language)),
		compartments.decorationsCompartment.reconfigure(getExtensionsForType(entries, 'decoration', language)),
		compartments.keybindingsCompartment.reconfigure(getExtensionsForType(entries, 'keybinding', language))
	];
}

/**
 * A single text replacement or insertion within a document.
 */
export interface SingleDocumentEdit {
	readonly from: number;
	readonly to: number;
	readonly insert: string;
}

/**
 * Host document edit request options (ADR 0016).
 */
export interface ApplyDocumentEditOptions {
	/** Target document session */
	readonly doc?: DocumentSession;
	/** Optional document ID if resolving via workspace */
	readonly documentId?: string;
	/**
	 * Expected document revision before applying edits.
	 * If doc.revision !== expectedRevision, throws DocumentRevisionMismatchError.
	 */
	readonly expectedRevision: number;
	/** Single change or array of changes to apply atomically as one undo transaction */
	readonly changes: readonly SingleDocumentEdit[] | SingleDocumentEdit;
	/** Originator (e.g. contributing plugin ID) */
	readonly origin?: string;
}

/**
 * Result of applying a host document edit operation.
 */
export interface DocumentEditResult {
	readonly success: boolean;
	readonly previousRevision: number;
	readonly newRevision: number;
	readonly newContent: string;
}

/**
 * Internal interface used by the host shell (e.g. Editor.svelte) to bind an
 * active CodeMirror editor to a document session. NEVER exposed to plugins.
 */
export interface AttachedEditor {
	getState(): { doc: { toString(): string; length: number } };
	dispatch(spec: { changes: readonly SingleDocumentEdit[]; annotations?: any[] }): void;
}

/**
 * Asserts that the options do not contain raw CodeMirror Transaction objects or direct dispatch calls.
 */
export function assertNotRawTransaction(options: any): void {
	if (!options) return;
	if (options.transaction !== undefined || options.dispatch !== undefined) {
		throw new RawTransactionDispatchError('Raw transaction or dispatch properties detected in document edit options.');
	}
	const changes = options.changes;
	if (changes && !Array.isArray(changes) && typeof changes === 'object') {
		if (changes.startState !== undefined || changes.effects !== undefined || typeof changes.annotation === 'function') {
			throw new RawTransactionDispatchError(
				'Passed object appears to be a raw CodeMirror Transaction instead of structured { from, to, insert } edits.'
			);
		}
	}
	if (Array.isArray(changes)) {
		for (const c of changes) {
			if (c && (c.startState !== undefined || c.effects !== undefined || typeof c.annotation === 'function')) {
				throw new RawTransactionDispatchError(
					'Passed object appears to be a raw CodeMirror Transaction instead of structured { from, to, insert } edits.'
				);
			}
		}
	}
}

/**
 * Applies a document edit through the host operation as one undo transaction with revision checks (ADR 0016).
 */
export function applyDocumentEditOperation(
	options: ApplyDocumentEditOptions,
	targetDoc: DocumentSession,
	attachedEditor?: AttachedEditor
): DocumentEditResult {
	assertNotRawTransaction(options);

	// Revision check
	if (targetDoc.revision !== options.expectedRevision) {
		throw new DocumentRevisionMismatchError(options.expectedRevision, targetDoc.revision, targetDoc.id);
	}

	const rawChanges = Array.isArray(options.changes) ? options.changes : [options.changes];
	if (rawChanges.length === 0) {
		return {
			success: true,
			previousRevision: targetDoc.revision,
			newRevision: targetDoc.revision,
			newContent: targetDoc.content
		};
	}

	const docLength = attachedEditor
		? attachedEditor.getState().doc.length
		: (targetDoc.content?.length ?? 0);

	// Validate edits
	for (const change of rawChanges) {
		if (typeof change.from !== 'number' || typeof change.to !== 'number' || typeof change.insert !== 'string') {
			throw new Error('Each document edit must specify numeric "from", "to", and string "insert" properties.');
		}
		if (change.from < 0 || change.to < change.from || change.to > docLength) {
			throw new Error(`Invalid change range: from=${change.from}, to=${change.to}`);
		}
	}

	if (rawChanges.length > 1) {
		const sorted = [...rawChanges].sort((a, b) => a.from - b.from || b.to - a.to);
		for (let i = 0; i < sorted.length - 1; i++) {
			if (sorted[i].to > sorted[i + 1].from) {
				throw new Error(
					`Overlapping change ranges: [${sorted[i].from}, ${sorted[i].to}] and [${sorted[i + 1].from}, ${sorted[i + 1].to}]`
				);
			}
		}
	}

	const normalizedChanges: SingleDocumentEdit[] = rawChanges.map((c) => ({
		from: c.from,
		to: c.to,
		insert: c.insert
	}));

	const prevRevision = targetDoc.revision;

	if (attachedEditor) {
		// Dispatched atomically to the attached editor as one transaction.
		// CodeMirror records this entire transaction as a single undo history item.
		attachedEditor.dispatch({
			changes: normalizedChanges
		});
		const newContent = attachedEditor.getState().doc.toString();
		targetDoc.content = newContent;
	} else if (targetDoc.editorState && typeof targetDoc.editorState.update === 'function') {
		// Update CodeMirror EditorState atomically
		const tr = targetDoc.editorState.update({
			changes: normalizedChanges
		});
		targetDoc.editorState = tr.state;
		targetDoc.content = tr.state.doc.toString();
	} else {
		// Fallback for headless / non-editor document sessions:
		// Sort changes descending by offset so earlier offsets remain valid
		let text = targetDoc.content;
		const sorted = [...normalizedChanges].sort((a, b) => b.from - a.from || b.to - a.to);
		for (const edit of sorted) {
			text = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
		}
		targetDoc.content = text;
	}

	return {
		success: true,
		previousRevision: prevRevision,
		newRevision: targetDoc.revision,
		newContent: targetDoc.content
	};
}

// ---------------------------------------------------------------------------
// Pilot Contributions (ADR 0016 Acceptance Test Fixtures)
// ---------------------------------------------------------------------------

/**
 * Pilot gutter marker showing an indicator on designated lines.
 */
export class PilotGutterMarker extends GutterMarker {
	readonly markerText: string;

	constructor(markerText = '▶') {
		super();
		this.markerText = markerText;
	}

	toDOM(): Node {
		if (typeof document !== 'undefined') {
			const span = document.createElement('span');
			span.className = 'cm-pilot-gutter-marker';
			span.textContent = this.markerText;
			return span;
		}
		// Fallback for non-DOM test environments
		return { nodeType: 1, textContent: this.markerText } as any;
	}
}

/**
 * Pilot gutter extension providing line markers.
 */
export const pilotGutterExtension: Extension = gutter({
	class: 'cm-pilot-gutter',
	lineMarker(view, line) {
		const docLine = view.state.doc.lineAt(line.from);
		if (docLine.number === 1) {
			return new PilotGutterMarker('▶');
		}
		return null;
	}
});

/**
 * Effect to dynamically add pilot mark decorations.
 */
export const addPilotDecorationEffect = StateEffect.define<{
	from: number;
	to: number;
	className?: string;
}>();

/**
 * Pilot decoration StateField providing decorations to the editor.
 */
export const pilotDecorationField = StateField.define<DecorationSet>({
	create() {
		return Decoration.none;
	},
	update(decorations, tr) {
		decorations = decorations.map(tr.changes);
		for (const effect of tr.effects) {
			if (effect.is(addPilotDecorationEffect)) {
				decorations = decorations.update({
					add: [
						Decoration.mark({
							class: effect.value.className ?? 'cm-pilot-decoration'
						}).range(effect.value.from, effect.value.to)
					]
				});
			}
		}
		return decorations;
	},
	provide: (f) => EditorView.decorations.from(f)
});

/**
 * Pilot editor-scoped keymap extension.
 */
export const pilotKeymapExtension: Extension = keymap.of([
	{
		key: 'Ctrl-Alt-p',
		run: () => true
	}
]);

export const PILOT_GUTTER_CONTRIBUTION: EditorContribution = {
	id: 'pilot-gutter',
	type: 'gutter',
	extension: pilotGutterExtension,
	priority: 10,
	description: 'Pilot gutter contribution for line annotations'
};

export const PILOT_DECORATION_CONTRIBUTION: EditorContribution = {
	id: 'pilot-decoration',
	type: 'decoration',
	extension: pilotDecorationField,
	priority: 10,
	description: 'Pilot decoration contribution for inline highlights'
};

export const PILOT_KEYBINDING_CONTRIBUTION: EditorContribution = {
	id: 'pilot-keybinding',
	type: 'keybinding',
	extension: pilotKeymapExtension,
	priority: 10,
	description: 'Pilot editor keybinding contribution'
};
