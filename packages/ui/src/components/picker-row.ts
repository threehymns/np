/**
 * A row in a picker list.
 *
 * The row carries what the shared picker needs — what the list filters by,
 * what the side tooltip shows, whether it is the current selection — next to
 * the text the row displays. The picker renders the shell of the row; the
 * picker that owns the list decides what a row looks like.
 */
export type PickerRow = {
	/** Stable identity of the row. Falls back to `value`. */
	key?: string;
	/** Value the list filters the row by. */
	value: string;
	/** Extra terms the row is filtered by, beside its value. */
	keywords?: string[];
	/** Primary text of the row. */
	label: string;
	/** Secondary text under the label, e.g. a path. */
	description?: string;
	/** Text shown in the row's side tooltip. Falls back to `label`. */
	tooltip?: string;
	/** Marks the row as the current selection. */
	current?: boolean;
	/** Disables the row on its own, apart from the picker-wide disabled state. */
	disabled?: boolean;
};
