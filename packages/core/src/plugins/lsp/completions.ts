/**
 * Server completion items, as this plugin hands them to the editor.
 *
 * Everything protocol-shaped is decoded here, in the plugin that owns the
 * protocol (ADR 0019), so the completion source on the other side of the
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
 * knowledge back where ADR 0019 put it.
 */

/** LSP `CompletionItemKind`, kept as the wire number the server sent. */
export type ServerCompletionItemKind = number;

/** What an accepted item replaces, named by the server. */
export interface ServerCompletionRange {
	readonly start: { readonly line: number; readonly character: number };
	readonly end: { readonly line: number; readonly character: number };
}

export interface ServerCompletionItem {
	readonly label: string;
	/**
	 * Text an accept inserts. Defaults to the label when the server sent no
	 * `textEdit`, `insertText` or `insertTextFormat`.
	 */
	readonly insertText: string;
	/** One-line signature, for the popover's right-hand column. */
	readonly detail: string | null;
	/** Documentation as one string: JSDoc, a signature, or a markdown blob. */
	readonly documentation: string | null;
	readonly kind: ServerCompletionItemKind | null;
	/**
	 * The range the item replaces, when the server named one. Only meaningful
	 * under `lsp_insert_mode: 'replace_range'`.
	 */
	readonly replaceRange: ServerCompletionRange | null;
}

export interface ServerCompletionList {
	readonly items: readonly ServerCompletionItem[];
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

function readRange(value: unknown): ServerCompletionRange | null {
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
 */
export function parseServerCompletions(result: unknown): ServerCompletionList {
	const rawItems = Array.isArray(result)
		? result
		: isRecord(result) && Array.isArray(result.items)
			? result.items
			: [];
	const items: ServerCompletionItem[] = [];
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
			replaceRange: textEdit ? readRange(textEdit.range) : null
		});
	}
	return {
		items,
		incomplete: isRecord(result) && result.isIncomplete === true
	};
}