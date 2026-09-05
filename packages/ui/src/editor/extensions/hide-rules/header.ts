import { Decoration } from "@codemirror/view";
import type { HideMarkerRule } from "./types";

/**
 * Header markers: Setext underlines fade instead of disappearing; ATX hashes
 * (plus one trailing space) collapse to nothing.
 */
export const headerMarkerRule: HideMarkerRule = {
	name: "header",
	matches: (type) => type === "HeaderMark",
	decorate(node, view, builder) {
		const parentName = node.node.parent?.name;
		if (
			parentName === "SetextHeading1" ||
			parentName === "SetextHeading2"
		) {
			builder.add(
				node.from,
				node.to,
				Decoration.mark({
					class: "md-faded",
				}),
			);
		} else {
			let to = node.to;
			if (view.state.doc.sliceString(to, to + 1) === " ") {
				to++;
			}
			builder.add(
				node.from,
				to,
				Decoration.replace({}),
			);
		}
	},
};