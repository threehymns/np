import { flattenMarkup } from './completions';
import type { CompletionSuggestionRange } from '../services';

/**
 * Server hover, as this plugin hands it to the editor (spec #280).
 *
 * Everything protocol-shaped is decoded here, in the plugin that owns the
 * protocol (ADR 0020), so the hover source on the other side of the package
 * boundary reads a plain data structure and never parses `Hover` itself.
 * This is the same flattening `completions.ts` does for `documentation`:
 * one Markdown pipeline for both surfaces (#295), because resolve fills the
 * same string the hover shows.
 */

export interface ServerHover {
	/** Flattened Markdown to render: type, signature and documentation. */
	readonly contents: string;
	readonly range: CompletionSuggestionRange | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
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
 * Flattens one hover `contents` entry, keeping fenced code blocks intact.
 *
 * `flattenMarkup` drops the `language` of a `{ language, value }` entry
 * because a completion `info` renders with no syntax highlighting. A hover
 * surface keeps it as a fence, so ` ```ts ` survives the crossing rather
 * than arriving as plain text.
 */
function flattenHoverEntry(entry: unknown): string | null {
	if (typeof entry === 'string') return entry.length > 0 ? entry : null;
	if (isRecord(entry) && typeof entry.value === 'string') {
		// `MarkupContent` (`{ kind, value }`) and `MarkedString`
		// (`{ language, value }`) share the same shape; the difference is
		// which key names the format.
		if (entry.value.length === 0) return null;
		if (typeof entry.language === 'string' && entry.language.length > 0) {
			return `\`\`\`${entry.language}\n${entry.value}\n\`\`\``;
		}
		return entry.value;
	}
	return null;
}

/**
 * Decodes one `textDocument/hover` reply.
 *
 * Returns null when there is nothing to show: a null result, an empty
 * contents, or a reply that cannot be read. Null hovers to nothing rather
 * than to an error (spec #280), so the caller treats it as "no tooltip"
 * and leaves diagnostics, completions and note hovers exactly as they were.
 */
export function parseServerHover(result: unknown): ServerHover | null {
	if (result === null || result === undefined) return null;
	if (!isRecord(result)) return null;
	const raw = result.contents;
	let contents: string | null = null;
	if (Array.isArray(raw)) {
		const parts: string[] = [];
		for (const entry of raw) {
			// A bare string inside the array flattens directly; an object
			// keeps its fence. `flattenMarkup` would drop the language,
			// which is why the hover path has its own flattener above.
			const flattened = flattenHoverEntry(entry) ?? flattenMarkup(entry);
			if (flattened !== null) parts.push(flattened);
		}
		contents = parts.length > 0 ? parts.join('\n\n') : null;
	} else {
		contents = flattenHoverEntry(raw) ?? flattenMarkup(raw);
	}
	if (contents === null || contents.length === 0) return null;
	return {
		contents,
		range: readRange(result.range)
	};
}
