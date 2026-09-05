import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { workspaceFacet, currentDocFacet } from "./wikilinks";
import { openInternalLink } from "@np/core/links";

export const linkHandlers = EditorView.domEventHandlers({
	mousedown: (event, view) => {
		// We still need preventDefault to stop cursor move on collapsed links
		const pos = view.posAtCoords({
			x: event.clientX,
			y: event.clientY,
		});
		if (pos == null) return;

		const node = syntaxTree(view.state).resolveInner(pos, -1);

		let curr: any = node;
		let isLink = false;
		let isMarkerOrURL = false;
		while (curr && curr.name !== "Document") {
			if (curr.name === "Link" || curr.name === "WikiLink") {
				isLink = true;
				break;
			}
			if (
				curr.name === "LinkMark" ||
				curr.name === "WikiLinkMark" ||
				curr.name === "URL"
			) {
				isMarkerOrURL = true;
			}
			curr = curr.parent;
		}

		if (isLink && !isMarkerOrURL && !event.altKey) {
			// Check if the link is currently expanded in the DOM
			const target = event.target as HTMLElement;
			const isExpanded =
				target.classList.contains("cm-link-expanded") ||
				target.closest(".cm-link-expanded");

			if (!isExpanded) {
				event.preventDefault();
				event.stopPropagation();
				view.focus();
				return true;
			}
		}
		return false;
	},
	click: (event, view) => {
		const pos = view.posAtCoords({
			x: event.clientX,
			y: event.clientY,
		});
		if (pos == null) return false;

		const node = syntaxTree(view.state).resolveInner(pos, -1);

		let curr: any = node;
		let isLink = false;
		let isMarkerOrURL = false;
		while (curr && curr.name !== "Document") {
			if (curr.name === "Link" || curr.name === "WikiLink") {
				isLink = true;
				break;
			}
			if (
				curr.name === "LinkMark" ||
				curr.name === "WikiLinkMark" ||
				curr.name === "URL"
			) {
				isMarkerOrURL = true;
			}
			curr = curr.parent;
		}

		let isLabel = isLink && !isMarkerOrURL && !event.altKey;

		if (!isLabel) {
			const target = event.target as HTMLElement;
			if (
				target.classList.contains("cm-link") ||
				target.closest(".cm-link")
			) {
				isLabel = true;
			}
		}

		if (isLabel) {
			const target = event.target as HTMLElement;
			const isExpanded =
				target.classList.contains("cm-link-expanded") ||
				target.closest(".cm-link-expanded");

			if (!isExpanded) {
				let linkNode: any = node;
				while (
					linkNode &&
					linkNode.name !== "Link" &&
					linkNode.name !== "WikiLink" &&
					linkNode.name !== "Document"
				) {
					linkNode = linkNode.parent;
				}

				if (linkNode && linkNode.name === "WikiLink") {
					const rawText = view.state.doc.sliceString(
						linkNode.from,
						linkNode.to
					);
					const workspace = view.state.facet(workspaceFacet);
					const currentDoc = view.state.facet(currentDocFacet);
					if (workspace) {
						openInternalLink(workspace, currentDoc, rawText).catch((error) => {
							console.error("Failed to open internal link:", error);
						});
						event.preventDefault();
						event.stopPropagation();
						return true;
					}
				}

				if (linkNode && linkNode.name === "Link") {
					let url = "";
					const cursor = linkNode.node.cursor();
					if (cursor.firstChild()) {
						do {
							if (cursor.name === "URL") {
								url = view.state.doc.sliceString(
									cursor.from,
									cursor.to,
								);
								break;
							}
						} while (cursor.nextSibling());
					}

					if (url) {
						if (/^(https?:|mailto:)/i.test(url)) {
							window.open(url, "_blank", "noopener,noreferrer");
							return true;
						}

						const workspace = view.state.facet(workspaceFacet);
						const currentDoc = view.state.facet(currentDocFacet);
						if (workspace) {
							openInternalLink(workspace, currentDoc, url).catch((error) => {
								console.error("Failed to open internal link:", error);
							});
							event.preventDefault();
							event.stopPropagation();
							return true;
						}
					}
				}
			}
		}
		return false;
	},
});
