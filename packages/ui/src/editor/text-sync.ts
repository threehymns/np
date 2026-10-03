/**
 * Minimal single-hunk sync change between two full texts (#271).
 *
 * External syncs (tab keystrokes echoed into the diff Working-copy pane
 * and vice versa) must not destroy the receiving view's independent undo
 * history. A full-document replacement dispatched with
 * `Transaction.addToHistory.of(false)` still maps history through the
 * changeset, and mapping an edit through a delete-all/insert-all drops it
 * — wiping the other view's undo stack on every keystroke. Shrinking the
 * sync to the common-prefix/suffix middle keeps unrelated history events
 * mappable, so each view keeps its own undo stack over the shared text.
 *
 * Returns null when the texts are already equal (caller should dispatch
 * no changes). Otherwise returns a single `{ from, to, insert }` against
 * `prev` that produces `next`. Falls back to a full replacement when the
 * texts share no prefix/suffix.
 */
export function minimalTextChange(
	prev: string,
	next: string
): { from: number; to: number; insert: string } | null {
	if (prev === next) return null;
	let start = 0;
	const minLen = Math.min(prev.length, next.length);
	while (start < minLen && prev.charCodeAt(start) === next.charCodeAt(start)) start++;
	let endPrev = prev.length;
	let endNext = next.length;
	while (
		endPrev > start &&
		endNext > start &&
		prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)
	) {
		endPrev--;
		endNext--;
	}
	return { from: start, to: endPrev, insert: next.slice(start, endNext) };
}
