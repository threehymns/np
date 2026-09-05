import {
	Decoration,
	ViewPlugin,
	ViewUpdate,
	EditorView,
} from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { LanguageLabelWidget } from "../widgets/LanguageLabelWidget";
import { markerHideRules } from "./hide-rules";

class HideMarkersPlugin {
	decorations: DecorationSet;

	constructor(view: EditorView) {
		this.decorations = this.getDecorations(view);
	}

	update(update: ViewUpdate) {
		if (
			update.docChanged ||
			update.selectionSet ||
			update.viewportChanged ||
			update.focusChanged
		) {
			this.decorations = this.getDecorations(update.view);
		}
	}

	getDecorations(view: EditorView) {
		const builder = new RangeSetBuilder<Decoration>();
		const selection = view.state.selection.main;
		const curLine = view.state.doc.lineAt(selection.from).number;

		for (let { from, to } of view.visibleRanges) {
			syntaxTree(view.state).iterate({
				from,
				to,
				enter: (node) => {
					const type = node.name;

					if (type === "FencedCode") {
						const startLine = view.state.doc.lineAt(node.from);
						const hasFocus = view.hasFocus;

						if (!(hasFocus && startLine.number === curLine)) {
							// Find language
							let lang = "";
							node.node.cursor().iterate((c) => {
								if (c.name === "CodeInfo") {
									lang = view.state.doc
										.sliceString(c.from, c.to)
										.trim();
									return false;
								}
							});

							builder.add(
								startLine.from,
								startLine.to,
								Decoration.replace({
									widget: lang
										? new LanguageLabelWidget(lang)
										: undefined,
								}),
							);
						}

						const lastChild = node.node.lastChild;
						if (
							lastChild &&
							lastChild.name === "CodeMark" &&
							lastChild.from > startLine.to
						) {
							const endLine = view.state.doc.lineAt(
								lastChild.from,
							);
							if (
								endLine.number !== startLine.number &&
								!(hasFocus && endLine.number === curLine)
							) {
								builder.add(
									endLine.from,
									endLine.to,
									Decoration.replace({}),
								);
							}
						}
						return false; // Don't process children as markers
					}

					// Add a class to the entire link node when expanded for CSS targeting
					if (type === "Link") {
						const isExpanded =
							view.hasFocus &&
							selection.from <= node.to &&
							selection.to >= node.from;
						if (isExpanded) {
							builder.add(
								node.from,
								node.to,
								Decoration.mark({
									class: "cm-link-expanded",
								}),
							);
						}
					}

					if (type === "WikiLink") {
						const isExpanded =
							view.hasFocus &&
							selection.from < node.to &&
							selection.to > node.from;
						if (isExpanded) {
							builder.add(
								node.from,
								node.to,
								Decoration.mark({
									class: "cm-link-expanded",
								}),
							);
						} else {
							let aliasNode: { from: number; to: number } | null = null;
							let cursor = node.node.cursor();
							if (cursor.firstChild()) {
								do {
									if (cursor.name === "WikiLinkAlias") {
										aliasNode = { from: cursor.from, to: cursor.to };
										break;
									}
								} while (cursor.nextSibling());
							}

							if (aliasNode) {
								builder.add(node.from, aliasNode.from, Decoration.replace({}));
								builder.add(node.to - 2, node.to, Decoration.replace({}));
							} else {
								const openMarkLen = view.state.doc.sliceString(node.from, node.from + 1) === "!" ? 3 : 2;
								builder.add(node.from, node.from + openMarkLen, Decoration.replace({}));
								builder.add(node.to - 2, node.to, Decoration.replace({}));
							}
						}
						return false;
					}

					if (type === "WikiLinkMark") {
						return false;
					}

					const isMarker =
						type.includes("Mark") ||
						type.includes("Delimiter") ||
						type === "HeaderMark" ||
						type === "CodeMark" ||
						type === "CodeInfo" ||
						type === "URL" ||
						type === "LinkTitle";

					if (isMarker) {
						const line = view.state.doc.lineAt(
							node.from,
						).number;
						let shouldShow = view.hasFocus && line === curLine;

						// Surgical hiding for inline markers: only show if cursor is inside the parent node
						const inlineTypes = [
							"Emphasis",
							"StrongEmphasis",
							"Strikethrough",
							"InlineCode",
							"Link",
							"Image",
						];
						let parent = node.node.parent;

						// Special case for Link: Hide [ ] around label and (url) part
						if (type === "LinkMark") {
							let linkNode = parent;
							while (
								linkNode &&
								linkNode.name !== "Link" &&
								linkNode.name !== "Document"
							) {
								linkNode = linkNode.parent;
							}

							if (linkNode && linkNode.name === "Link") {
								shouldShow =
									view.hasFocus &&
									selection.from <= linkNode.to &&
									selection.to >= linkNode.from;
							}
						}

						// Handle URL inside markdown links - only hide if inside a Link node
						if (type === "URL") {
							let linkNode = parent;
							while (
								linkNode &&
								linkNode.name !== "Link" &&
								linkNode.name !== "Document"
							) {
								linkNode = linkNode.parent;
							}

							// Only hide URL if it's inside a markdown Link; otherwise leave visible
							if (!linkNode || linkNode.name !== "Link") {
								shouldShow = true; // Don't hide standalone URLs
							} else {
								shouldShow =
									view.hasFocus &&
									selection.from <= linkNode.to &&
									selection.to >= linkNode.from;
							}
						} else if (
							parent &&
							inlineTypes.includes(parent.name)
						) {
							// For other inline elements, only show if selection intersects the parent node
							shouldShow =
								view.hasFocus &&
								selection.from <= parent.to &&
								selection.to >= parent.from;
						}

							if (!shouldShow) {
								const rule = markerHideRules.find((r) =>
									r.matches(type),
								);
								if (rule) {
									rule.decorate(node, view, builder);
								}
							}
					}
				},
			});
		}
		return builder.finish();
	}
}

export { HideMarkersPlugin };
export const hideMarkersPlugin = ViewPlugin.fromClass(HideMarkersPlugin, {
	decorations: (v) => v.decorations,
});
