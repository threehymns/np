import type { Decoration } from "@codemirror/view";
import type { RangeSetBuilder } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { SyntaxNodeRef } from "@lezer/common";

/**
 * A per-feature marker-hiding rule. Each feature that owns marker nodes
 * (list markers, header hashes, quote bars, code marks, ...) provides one rule
 * describing how its markers should be hidden when the cursor is elsewhere.
 *
 * Rules are composed centrally in `hide-rules/index.ts`. To add a feature:
 * define its rule in its own module and append it to the central list — the
 * edit collides only on that one adjacent registration line.
 */
export interface HideMarkerRule {
	/** Stable feature identifier, used for ordering/debugging. */
	name: string;
	/** Return true when this rule owns the given syntax node type. */
	matches(type: string): boolean;
	/**
	 * Add the hidden-marker decoration(s) for `node`. `node.node` is the
	 * underlying syntax node (its `.parent` is available). Only called when the
	 * marker should be hidden (cursor outside the marker's line/context).
	 */
	decorate(
		node: SyntaxNodeRef,
		view: EditorView,
		builder: RangeSetBuilder<Decoration>,
	): void;
}