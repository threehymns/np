import type { MarkdownConfig } from "@lezer/markdown";
import { styleTags, tags as t } from "@lezer/highlight";
import { Facet } from "@codemirror/state";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import {
	type Workspace,
	type DocumentSession,
	getHeadings,
	getBlocks,
	getAllFilesFromTree,
} from "@np/core/links";

export const workspaceFacet = Facet.define<Workspace | null, Workspace | null>({
	combine: (values) => values[0] ?? null,
});

export const currentDocFacet = Facet.define<DocumentSession | null, DocumentSession | null>({
	combine: (values) => values[0] ?? null,
});

export const WikiLinkExtension: MarkdownConfig = {
	defineNodes: [
		{ name: "WikiLink" },
		{ name: "WikiLinkMark" },
		{ name: "WikiLinkTarget" },
		{ name: "WikiLinkAlias" },
	],
	parseInline: [
		{
			name: "WikiLink",
			before: "Link",
			parse(cx, next, pos) {
				let isEmbed = false;
				const start = pos;

				if (next === 33 /* ! */) {
					if (cx.char(pos + 1) === 91 && cx.char(pos + 2) === 91) {
						isEmbed = true;
					} else {
						return -1;
					}
				} else if (next === 91 /* [ */) {
					if (cx.char(pos + 1) === 91) {
						isEmbed = false;
					} else {
						return -1;
					}
				} else {
					return -1;
				}

				const markLen = isEmbed ? 3 : 2;
				const contentStart = start + markLen;
				let end = -1;
				let pipePos = -1;

				for (let i = contentStart; i < cx.end; i++) {
					const ch = cx.char(i);
					if (ch === 10 /* \n */) break;
					if (ch === 124 /* | */ && pipePos === -1) {
						pipePos = i;
					}
					if (ch === 93 /* ] */ && cx.char(i + 1) === 93) {
						end = i + 2;
						break;
					}
				}

				if (end === -1) return -1;

				const children: any[] = [];
				children.push(cx.elt("WikiLinkMark", start, contentStart));

				if (pipePos !== -1) {
					children.push(cx.elt("WikiLinkTarget", contentStart, pipePos));
					children.push(cx.elt("WikiLinkMark", pipePos, pipePos + 1));
					children.push(cx.elt("WikiLinkAlias", pipePos + 1, end - 2));
				} else {
					children.push(cx.elt("WikiLinkTarget", contentStart, end - 2));
				}

				children.push(cx.elt("WikiLinkMark", end - 2, end));
				cx.addElement(cx.elt("WikiLink", start, end, children));
				return end;
			},
		},
	],
	props: [
		styleTags({
			WikiLink: t.link,
			WikiLinkTarget: t.link,
			WikiLinkAlias: t.link,
			WikiLinkMark: t.processingInstruction,
		}),
	],
};

/**
 * Autocompletion for Obsidian wikilinks:
 * - [[ triggers note list
 * - [[# or [[Note# triggers heading list
 * - [[#^ or [[^ or [[Note#^ triggers block list
 */
export function wikilinkAutocompletion(
	context: CompletionContext
): CompletionResult | null {
	// Look for [[ followed by characters before cursor without ] or newline
	const match = context.matchBefore(/!?\[\[([^\]\n]*)/);
	if (!match) return null;

	const fullInside = match.text.replace(/^!?\[\[/, "");
	// If pipe is already typed, user is writing alias; don't complete
	if (fullInside.includes("|")) return null;

	const workspace = context.state.facet(workspaceFacet);
	const currentDoc = context.state.facet(currentDocFacet);

	// Case 1: Block link ([[#^ or [[^ or [[Target#^)
	if (fullInside.includes("^")) {
		const caretIdx = fullInside.indexOf("^");
		const targetNote = fullInside.slice(0, caretIdx).replace(/#$/, "").trim();
		const query = fullInside.slice(caretIdx + 1);

		let content = "";
		if (!targetNote) {
			content = currentDoc?.content ?? "";
		} else if (workspace) {
			const found = workspace.documents.find(
				(d) =>
					d.fileName === targetNote ||
					d.fileName === `${targetNote}.md` ||
					d.untitledTitle === targetNote
			);
			if (found) {
				content = found.content;
			}
		}

		const blocks = getBlocks(content);
		const prefixPos = match.from + match.text.lastIndexOf("^") + 1;
		const q = query.trim().toLowerCase();
		const filtered = q
			? blocks.filter((b) => b.id.toLowerCase().includes(q))
			: blocks;

		return {
			from: prefixPos,
			options: filtered.map((b) => ({
				label: b.id,
				detail: b.preview.slice(0, 40),
				type: "variable",
				apply: `${b.id}]]`,
			})),
		};
	}

	// Case 2: Heading link ([[# or [[Target#)
	if (fullInside.includes("#")) {
		const hashIdx = fullInside.indexOf("#");
		const targetNote = fullInside.slice(0, hashIdx).trim();
		const query = fullInside.slice(hashIdx + 1);

		let content = "";
		if (!targetNote) {
			content = currentDoc?.content ?? "";
		} else if (workspace) {
			const found = workspace.documents.find(
				(d) =>
					d.fileName === targetNote ||
					d.fileName === `${targetNote}.md` ||
					d.untitledTitle === targetNote
			);
			if (found) {
				content = found.content;
			}
		}

		const headings = getHeadings(content);
		const prefixPos = match.from + match.text.lastIndexOf("#") + 1;
		const q = query.trim().toLowerCase();
		const filtered = q
			? headings.filter((h) => h.text.toLowerCase().includes(q))
			: headings;

		return {
			from: prefixPos,
			options: filtered.map((h) => ({
				label: h.text,
				detail: `H${h.level}`,
				type: "section",
				apply: `${h.text}]]`,
			})),
		};
	}

	// Case 3: Note search ([[...)
	const options: { label: string; detail?: string; type: string; apply: string }[] = [];
	const noteQuery = fullInside.trim().toLowerCase();

	if (workspace) {
		const allTreeFiles = getAllFilesFromTree(workspace.projectTree.nodes);
		for (const f of allTreeFiles) {
			const nameWithoutExt = f.name.replace(/\.md$/, "");
			options.push({
				label: nameWithoutExt,
				detail: f.origin.path,
				type: "file",
				apply: `${nameWithoutExt}]]`,
			});
		}

		// Also include open tabs if not in project tree
		for (const doc of workspace.documents) {
			const name = (doc.fileName || doc.untitledTitle).replace(/\.md$/, "");
			if (!options.some((o) => o.label === name)) {
				options.push({
					label: name,
					type: "file",
					apply: `${name}]]`,
				});
			}
		}
	}

	return {
		from: match.from + (match.text.startsWith("!") ? 3 : 2),
		options: noteQuery
			? options.filter(
					(o) =>
						o.label.toLowerCase().includes(noteQuery) ||
						(o.detail?.toLowerCase().includes(noteQuery) ?? false)
				)
			: options,
	};
}
