import { Decoration } from "@codemirror/view";
import { BulletWidget } from "../../widgets/BulletWidget";
import type { HideMarkerRule } from "./types";

/**
 * List markers: ordered markers keep their number (faded substyle), unordered
 * markers collapse into a bullet widget.
 */
export const listMarkerRule: HideMarkerRule = {
	name: "list",
	matches: (type) => type === "ListMark",
	decorate(node, view, builder) {
		const text = view.state.doc.sliceString(node.from, node.to);
		const isOrdered = /\d/.test(text);
		if (isOrdered) {
			builder.add(
				node.from,
				node.to,
				Decoration.mark({
					class: "md-list-number",
				}),
			);
		} else {
			builder.add(
				node.from,
				node.to,
				Decoration.replace({
					widget: new BulletWidget(),
				}),
			);
		}
	},
};