import { Decoration } from "@codemirror/view";
import type { HideMarkerRule } from "./types";

/**
 * Blockquote markers: the leading `>` (plus one trailing space) collapses to
 * nothing when hidden.
 */
export const quoteMarkerRule: HideMarkerRule = {
	name: "quote",
	matches: (type) => type === "QuoteMark",
	decorate(node, view, builder) {
		let to = node.to;
		if (view.state.doc.sliceString(to, to + 1) === " ") {
			to++;
		}
		builder.add(
			node.from,
			to,
			Decoration.replace({}),
		);
	},
};