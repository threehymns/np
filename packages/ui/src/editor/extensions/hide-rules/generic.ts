import { Decoration } from "@codemirror/view";
import type { HideMarkerRule } from "./types";

/**
 * Fallback catch-all: any marker/delimiter/URL node with no dedicated rule
 * collapses to nothing when hidden. Registered last so feature-specific rules
 * run first.
 */
export const genericMarkerRule: HideMarkerRule = {
	name: "generic",
	matches: () => true,
	decorate(node, view, builder) {
		builder.add(
			node.from,
			node.to,
			Decoration.replace({}),
		);
	},
};