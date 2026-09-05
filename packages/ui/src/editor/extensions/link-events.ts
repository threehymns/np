import { EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { workspaceFacet, currentDocFacet } from "./wikilinks";
import { openInternalLink } from "@np/core/links";

function findLinkNode(node: any): any {
	let curr: any = node;
	while (curr && curr.name !== "Link" && curr.name !== "WikiLink" && curr.name !== "Document") {
		curr = curr.parent;
	}
	return curr && curr.name !== "Document" ? curr : null;
}

function classifyLinkNode(node: any): { isLink: boolean; isMarkerOrURL: boolean } {
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
	return { isLink, isMarkerOrURL };
}

function eventOnLinkContent(target: EventTarget | null): boolean {
	const el = target as HTMLElement | null;
	return (
		!!el &&
		(el.classList.contains("cm-link") || !(!el.closest(".cm-link")))
	);
}

function eventOnExpandedLink(target: EventTarget | null): boolean {
	const el = target as HTMLElement | null;
	return (
		!!el &&
		(el.classList.contains("cm-link-expanded") ||
			!(!el.closest(".cm-link-expanded")))
	);
}

export interface LinkClickVerdict {
	readonly kind: "wikilink" | "link" | null;
	/** WikiLink raw text (`[[..]]`) or Link URL destination. */
	readonly raw: string;
}

/**
 * Pure click verdict for link presses (no side effects, headless-testable).
 *
 * `posAtCoords` snaps clicks in trailing empty space to the label edge of a
 * collapsed link, so the tree alone reports a label hit. The event target
 * disambiguates: only presses landing on rendered link content (`.cm-link`)
 * count as link clicks; the rest fall through to cursor placement.
 */
export function decideLinkClick(
	state: EditorState,
	pos: number,
	target: EventTarget | null,
	altKey: boolean
): LinkClickVerdict {
	const none: LinkClickVerdict = { kind: null, raw: "" };
	const node = syntaxTree(state).resolveInner(pos, -1);
	const { isLink, isMarkerOrURL } = classifyLinkNode(node);

	// Bare URL (a URL node with no Link ancestor) opens externally. Resolve with
	// forward bias so a press on the URL's leading edge still lands on the node.
	const urlNode = syntaxTree(state).resolveInner(pos, 1);
	if (
		urlNode.name === "URL" &&
		!isLink &&
		pos >= urlNode.from &&
		pos < urlNode.to
	) {
		let url = state.doc.sliceString(urlNode.from, urlNode.to);
		if (/^www\./i.test(url)) url = "https://" + url;
		return { kind: "link", raw: url };
	}

	let isLabel = isLink && !isMarkerOrURL && !altKey;
	const onLinkContent = eventOnLinkContent(target);

	if (isLabel && !onLinkContent) {
		isLabel = false;
	} else if (!isLabel && onLinkContent) {
		isLabel = true;
	}

	if (!isLabel || eventOnExpandedLink(target)) return none;

	const linkNode: any = findLinkNode(node);
	if (linkNode && linkNode.name === "WikiLink") {
		return {
			kind: "wikilink",
			raw: state.doc.sliceString(linkNode.from, linkNode.to),
		};
	}

	if (linkNode && linkNode.name === "Link") {
		let url = "";
		const cursor = linkNode.node.cursor();
		if (cursor.firstChild()) {
			do {
				if (cursor.name === "URL") {
					url = state.doc.sliceString(cursor.from, cursor.to);
					break;
				}
			} while (cursor.nextSibling());
		}

		if (url) return { kind: "link", raw: url };
	}

	return none;
}

/**
 * Pure mousedown verdict: true claims the event (preventDefault + focus),
 * which suppresses cursor placement — so it must only fire for presses on
 * rendered link content, never for snapped trailing-space clicks.
 */
export function decideLinkMousedown(
	state: EditorState,
	pos: number,
	target: EventTarget | null,
	altKey: boolean
): boolean {
	// We still need preventDefault to stop cursor move on collapsed links
	const node = syntaxTree(state).resolveInner(pos, -1);
	const { isLink, isMarkerOrURL } = classifyLinkNode(node);

	return (
		isLink &&
		!isMarkerOrURL &&
		!altKey &&
		!eventOnExpandedLink(target) &&
		eventOnLinkContent(target)
	);
}

/**
 * Pure click verdict for Markdown images (`![alt](dest)`): external URLs open
 * externally; vault-relative paths navigate without ever creating a file.
 */
export function decideImageClick(
	state: EditorState,
	pos: number
): { kind: "image"; dest: string; external: boolean } | { kind: null; raw: "" } {
	let cur: any = syntaxTree(state).resolveInner(pos, 1);
	while (cur && cur.name !== "Image" && cur.parent) cur = cur.parent;
	if (!cur || cur.name !== "Image") return { kind: null, raw: "" };
	let url = "";
	const c = cur.node.cursor();
	if (c.firstChild()) {
		do {
			if (c.name === "URL") {
				url = state.doc.sliceString(c.from, c.to);
				break;
			}
		} while (c.nextSibling());
	}
	if (!url) return { kind: null, raw: "" };
	return {
		kind: "image",
		dest: url,
		external: /^(https?:|mailto:)/i.test(url),
	};
}

export const linkHandlers = EditorView.domEventHandlers({
	keydown: (event, view) => {
		if (event.defaultPrevented) return false;
		if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
		if (!view.state.selection.main.empty) return false;
		const pos = view.state.selection.main.head;
		const linkNode = findLinkNode(syntaxTree(view.state).resolveInner(pos, -1));
		if (!linkNode || linkNode.name !== "WikiLink") return false;

		const rawText = view.state.doc.sliceString(linkNode.from, linkNode.to);
		const workspace = view.state.facet(workspaceFacet);
		const currentDoc = view.state.facet(currentDocFacet);
		if (!workspace) return false;
		openInternalLink(workspace, currentDoc, rawText).catch((error) => {
			console.error("Failed to open internal link:", error);
		});
		event.preventDefault();
		event.stopPropagation();
		return true;
	},
	mousedown: (event, view) => {
		const pos = view.posAtCoords({
			x: event.clientX,
			y: event.clientY,
		});
		if (pos == null) return;

		if (!decideLinkMousedown(view.state, pos, event.target, event.altKey)) {
			return false;
		}

		event.preventDefault();
		event.stopPropagation();
		view.focus();
		return true;
	},
	click: (event, view) => {
		const pos = view.posAtCoords({
			x: event.clientX,
			y: event.clientY,
		});
		if (pos == null) return false;

		const verdict = decideLinkClick(
			view.state,
			pos,
			event.target,
			event.altKey
		);

		if (verdict.kind === "wikilink") {
			const workspace = view.state.facet(workspaceFacet);
			const currentDoc = view.state.facet(currentDocFacet);
			if (workspace) {
				openInternalLink(workspace, currentDoc, verdict.raw).catch(
					(error) => {
						console.error("Failed to open internal link:", error);
					}
				);
				event.preventDefault();
				event.stopPropagation();
				return true;
			}
		}

		if (verdict.kind === "link") {
			const url = verdict.raw;
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

		const image = decideImageClick(view.state, pos);
		if (image.kind === "image" && image.external) {
			window.open(image.dest, "_blank", "noopener,noreferrer");
			return true;
		}
		if (image.kind === "image") {
			// vault-relative: navigate, never create
			const workspace = view.state.facet(workspaceFacet);
			const currentDoc = view.state.facet(currentDocFacet);
			if (workspace) {
				openInternalLink(workspace, currentDoc, image.dest, { allowCreate: false }).catch((error) => {
					console.error("Failed to open image target:", error);
				});
				event.preventDefault();
				event.stopPropagation();
				return true;
			}
		}

		return false;
	},
});
