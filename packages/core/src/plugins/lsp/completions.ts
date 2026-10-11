import type {
	CompletionAdditionalEdit,
	CompletionSuggestion,
	CompletionSuggestionCommand,
	CompletionSuggestionRange
} from '../services';

/**
 * Server completion items, as this plugin hands them to the editor.
 *
 * Everything protocol-shaped is decoded here, in the plugin that owns the
 * protocol (ADR 0020), so the completion source on the other side of the
 * package boundary reads a plain data structure and never parses
 * `CompletionItem` itself. `lsp_insert_mode` needs the server's own
 * `textEdit.range` to mean anything, and that range has to survive the crossing
 * verbatim or the mode would silently degrade into `replace_suffix`.
 *
 * Markup arrives in three shapes per the protocol — a bare string, a
 * `MarkupContent` with one `value`, or a `MarkedString[]` of alternating text
 * and `{ language, value }` entries — and a server is free to use whichever
 * fits. They all flatten to one string here, because a CodeMirror `info` is one
 * string and re-parsing the union at the presentation edge would put protocol
 * knowledge back where ADR 0020 put it.
 */

/** LSP `CompletionItemKind`, kept as the wire number the server sent. */
export type ServerCompletionItemKind = number;

/**
 * One decoded item, and the list it came in.
 *
 * Both are the generic `CompletionSuggestion` rather than a protocol type of
 * their own: the decode is this module's job, and everything downstream — the
 * popover, the insert mode, the source that ranks them — is written against the
 * shape a suggestion has, not the shape a `CompletionItem` has.
 */
export interface ServerCompletionList {
	readonly items: readonly CompletionSuggestion[];
	/** Whether the server asked to be asked again as the user keeps typing. */
	readonly incomplete: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Flattens the three markup shapes to one string, or null when there is none.
 *
 * A `MarkedString[]` interleaves bare strings with `{ language, value }`
 * entries; the language is dropped because CodeMirror renders `info` as HTML
 * with no syntax highlighting, and keeping a stray fence around a bare string
 * would be worse than the plain text.
 */
export function flattenMarkup(value: unknown): string | null {
	if (typeof value === 'string') return value.length > 0 ? value : null;
	if (Array.isArray(value)) {
		const parts: string[] = [];
		for (const entry of value) {
			const flattened = flattenMarkup(entry);
			if (flattened !== null) parts.push(flattened);
		}
		return parts.length > 0 ? parts.join('\n\n') : null;
	}
	if (isRecord(value) && typeof value.value === 'string') {
		return value.value.length > 0 ? value.value : null;
	}
	return null;
}

function readRange(value: unknown): CompletionSuggestionRange | null {
	if (!isRecord(value)) return null;
	const start = isRecord(value.start) ? value.start : null;
	const end = isRecord(value.end) ? value.end : null;
	if (!start || !end) return null;
	if (
		typeof start.line !== 'number' ||
		typeof start.character !== 'number' ||
		typeof end.line !== 'number' ||
		typeof end.character !== 'number'
	) {
		return null;
	}
	return {
		start: { line: start.line, character: start.character },
		end: { line: end.line, character: end.character }
	};
}

/**
 * Decodes one `textDocument/completion` reply.
 *
 * The reply is a `CompletionList` or a bare `CompletionItem[]` depending on the
 * server's `completionList` capability, and both are accepted because which one
 * arrives is the server's choice, not ours.
 *
 * An item missing a usable label is dropped rather than offered: CodeMirror
 * filters every option against the typed pattern by label, so a nameless item
 * can never match anything and would only widen the result.
 *
 * The server's opaque `data` is kept for the resolve round trip (spec #280):
 * vtsls withholds documentation until asked, so the item that arrives without
 * docs carries the key the `completionItem/resolve` request sends back.
 */
export function parseServerCompletions(result: unknown): ServerCompletionList {
	const rawItems = Array.isArray(result)
		? result
		: isRecord(result) && Array.isArray(result.items)
			? result.items
			: [];
	const items: CompletionSuggestion[] = [];
	for (const raw of rawItems) {
		if (!isRecord(raw) || typeof raw.label !== 'string' || raw.label.length === 0) continue;
		const textEdit = isRecord(raw.textEdit) ? raw.textEdit : null;
		items.push({
			label: raw.label,
			// `insertText` first, then the text edit's own text: an item that
			// carries both says the edit is what replaces the range, so its text
			// is the one that lands.
			insertText:
				(typeof raw.insertText === 'string' && raw.insertText.length > 0
					? raw.insertText
					: typeof textEdit?.newText === 'string'
						? textEdit.newText
						: raw.label),
			detail: typeof raw.detail === 'string' && raw.detail.length > 0 ? raw.detail : null,
			documentation: flattenMarkup(raw.documentation),
			kind: typeof raw.kind === 'number' ? raw.kind : null,
			replaceRange: textEdit ? readRange(textEdit.range) : null,
			// Opaque for resolve; absent means nothing was withheld. Left
			// undefined (rather than null) when the server sent none, so the
			// shape stays exactly what it was for items that need no resolve.
			...(raw.data !== undefined ? { data: raw.data } : {}),
			...readAdditionalEdits(raw),
			...readCommand(raw)
		});
	}
	return {
		items,
		incomplete: isRecord(result) && result.isIncomplete === true
	};
}

/**
 * Merges one `completionItem/resolve` reply into the suggestion it resolves
 * (spec #280, Zed contract #292).
 *
 * `documentation` and `detail` land immediately — they are what the popover
 * and the hover surface show. Only the *text* of a resolved edit is
 * re-derived into `insertText` (the `completeFunctionCalls` flow that adds
 * snippet parentheses during resolve); the ranges stay as the anchors the
 * first reply named, because they were converted from the original response
 * and stay valid across buffer edits. `textEdit` itself is never advertised
 * in `resolveSupport` (it makes Zed slow), so a resolved range is ignored
 * rather than trusted.
 *
 * `additionalTextEdits` and `command` are kept for confirm time rather than
 * applied here: the edits land in a separate transaction with overlap-skip,
 * and the command runs only when the server's `executeCommandProvider`
 * offers it.
 */
export function mergeResolvedCompletion(
	original: CompletionSuggestion,
	resolved: unknown
): CompletionSuggestion {
	if (!isRecord(resolved)) return original;
	const textEdit = isRecord(resolved.textEdit) ? resolved.textEdit : null;
	const newText =
		typeof textEdit?.newText === 'string' && textEdit.newText.length > 0
			? textEdit.newText
			: typeof resolved.insertText === 'string' && resolved.insertText.length > 0
				? resolved.insertText
				: original.insertText;
	const detail =
		typeof resolved.detail === 'string' && resolved.detail.length > 0
			? resolved.detail
			: original.detail;
	const documentation = flattenMarkup(resolved.documentation) ?? original.documentation;
	return {
		...original,
		insertText: newText,
		detail,
		documentation,
		// The range stays the original's: a resolved edit's range is against
		// the revision the server answered for, not the document as it is now.
		replaceRange: original.replaceRange,
		...readAdditionalEdits(resolved, original.additionalTextEdits),
		...readCommand(resolved, original.command)
	};
}

/** Builds the params for one `completionItem/resolve` request from a suggestion. */
export function toResolveParams(item: CompletionSuggestion): Record<string, unknown> {
	return {
		label: item.label,
		...(item.kind !== null && item.kind !== undefined ? { kind: item.kind } : {}),
		...(item.detail ? { detail: item.detail } : {}),
		...(item.documentation
			? { documentation: { kind: 'markdown', value: item.documentation } }
			: {}),
		...(item.insertText && item.insertText !== item.label ? { insertText: item.insertText } : {}),
		...(item.data !== undefined ? { data: item.data } : {})
	};
}

function readAdditionalEdits(
	raw: Record<string, unknown>,
	fallback?: readonly CompletionAdditionalEdit[] | null
): { additionalTextEdits?: readonly CompletionAdditionalEdit[] | null } {
	if (!Array.isArray(raw.additionalTextEdits)) {
		return fallback !== undefined ? { additionalTextEdits: fallback } : {};
	}
	const edits: CompletionAdditionalEdit[] = [];
	for (const entry of raw.additionalTextEdits) {
		if (!isRecord(entry) || typeof entry.newText !== 'string') continue;
		const range = readRange(entry.range);
		if (!range) continue;
		edits.push({ range, newText: entry.newText });
	}
	if (edits.length === 0) return fallback !== undefined ? { additionalTextEdits: fallback } : {};
	return { additionalTextEdits: edits };
}

function readCommand(
	raw: Record<string, unknown>,
	fallback?: CompletionSuggestionCommand | null
): { command?: CompletionSuggestionCommand | null } {
	const value = raw.command;
	if (typeof value === 'string' && value.length > 0) {
		return { command: { command: value } };
	}
	if (isRecord(value) && typeof value.command === 'string' && value.command.length > 0) {
		return {
			command: {
				command: value.command,
				...(Array.isArray(value.arguments) ? { args: value.arguments } : {})
			}
		};
	}
	return fallback !== undefined ? { command: fallback } : {};
}
