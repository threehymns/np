import { Decoration } from "@codemirror/view";
import { BulletWidget } from "../../widgets/BulletWidget";
import { getListItemTaskInfo } from "../tasks";
import type { HideMarkerRule } from "./types";

/**
 * List markers: task items collapse the bullet marker and following space to
 * empty (leaving only the checkbox widget); ordered markers keep their number
 * (faded substyle); unordered markers collapse into a bullet widget.
 */
export const listMarkerRule: HideMarkerRule = {
	name: "list",
	matches: (type) => type === "ListMark",
	decorate(node, view, builder) {
		let parent = node.node.parent;
		while (
			parent &&
			parent.name !== "ListItem" &&
			parent.name !== "Document"
		) {
			parent = parent.parent;
		}
		const taskInfo =
			parent && parent.name === "ListItem"
				? getListItemTaskInfo(parent)
				: null;

		if (taskInfo?.taskMarker) {
			const to = Math.max(node.to, taskInfo.taskMarker.from);
			builder.add(
				node.from,
				to,
				Decoration.replace({}),
			);
			return;
		}

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