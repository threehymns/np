import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

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
			if (curr.name === "Link") {
				isLink = true;
				break;
			}
			if (curr.name === "LinkMark" || curr.name === "URL") {
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
			if (curr.name === "Link") {
				isLink = true;
				break;
			}
			if (curr.name === "LinkMark" || curr.name === "URL") {
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
					linkNode.name !== "Document"
				) {
					linkNode = linkNode.parent;
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
						window.open(url, "_blank", "noopener,noreferrer");
						return true;
					}
				}
			}
		}
		return false;
	},
});
