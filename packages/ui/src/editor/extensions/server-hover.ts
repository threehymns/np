import { hoverTooltip, type Tooltip } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { currentDocFacet } from "./wikilinks";
import { renderLspMarkdown } from "./server-completions";

/**
 * Server hover as a tooltip (spec #280).
 *
 * A separate `textDocument/hover` request with no resolve phase (#292): it
 * shares only the Markdown pipeline with the resolve path. A symbol the
 * server does not report hovers to nothing (null) rather than to an error,
 * so diagnostics (title attributes), completions and note hovers keep their
 * current behaviour — this extension never claims a tooltip it cannot fill.
 */

export type HoverFetchDocument = {
	readonly path: string;
	readonly fileName: string;
	readonly content: string;
	readonly language: string | null;
};

export type HoverFetchQuery = {
	readonly document: HoverFetchDocument;
	readonly line: number;
	readonly character: number;
	readonly timeoutMs?: number;
};

export type HoverFetchResult =
	| { readonly state: "inactive"; readonly reason: string }
	| { readonly state: "serving"; readonly hover: { readonly contents: string } | null }
	| { readonly state: "unavailable"; readonly provider: string; readonly reason: string };

export type HoverFetch = (query: HoverFetchQuery) => Promise<HoverFetchResult>;

/**
 * The one setting the hover source consults: the same server gate the
 * completion source reads. A language whose server is off answers neither a
 * completion nor a hover, so there is no hover-specific switch to read.
 */
export type ServerHoverSettings = { readonly lsp: boolean };

export interface ServerHoverOptions {
	readonly fetchHover: HoverFetch;
	readonly readSettings?: () => ServerHoverSettings;
	readonly fetchTimeoutMs?: number;
}

function defaultSettings(): ServerHoverSettings {
	return { lsp: true };
}

function posToLineChar(state: EditorState, pos: number): { line: number; character: number } {
	const line = state.doc.lineAt(pos);
	return { line: line.number - 1, character: pos - line.from };
}

/**
 * Builds the hover tooltip extension for one language.
 *
 * Returns null (no tooltip) for every non-serving path: untitled documents,
 * languages with `lsp: false`, files nothing serves, servers that cannot
 * answer, and symbols the server reports nothing for. Each of those is "no
 * hover", not an error, which is what keeps every other hover behaviour
 * exactly where it was.
 */
export function createHoverSource(
	options: ServerHoverOptions & { readonly languageName: string | null }
) {
	const { languageName, fetchHover, readSettings = defaultSettings } = options;
	const timeoutMs = options.fetchTimeoutMs;

	return async (view: { state: EditorState }, pos: number): Promise<Tooltip | null> => {
		if (!languageName || !readSettings().lsp) return null;
		const document = view.state.facet(currentDocFacet);
		const path = document?.origin?.path ?? null;
		if (!path) return null;
		const { line, character } = posToLineChar(view.state, pos);
		let answer: HoverFetchResult;
		try {
			answer = await fetchHover({
				document: {
					path,
					fileName: document?.fileName ?? path,
					content: view.state.doc.toString(),
					language: languageName
				},
				line,
				character,
				...(timeoutMs !== undefined ? { timeoutMs } : {})
			});
		} catch {
			return null;
		}
		if (answer.state !== "serving" || !answer.hover) return null;
		const dom = renderLspMarkdown(answer.hover.contents);
		dom.className = "cm-lsp-hover";
		return { pos, end: pos, create: () => ({ dom }) };
	};
}

export function serverHover(
	options: ServerHoverOptions & { readonly languageName: string | null }
) {
	return hoverTooltip(createHoverSource(options));
}


