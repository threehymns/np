import { EditorView } from "@codemirror/view";

/**
 * A CodeMirror theme extension for diff and merge views.
 * It should be used in addition to the base editorTheme.
 */
export const diffTheme = EditorView.theme({
	"&": {
		height: "100%",
		backgroundColor: "transparent",
	},
	".cm-scroller": {
		overflow: "visible",
	},
	".cm-content": {
		fontFamily: "var(--font-mono, monospace) !important",
		padding: "0.5rem 0 !important",
		maxWidth: "none !important",
		margin: "0 !important",
	},
	".cm-line": {
		paddingLeft: "0.5rem",
	},
	".cm-deletedChunk, .cm-deletedText": {
		backgroundColor: "var(--diff-deleted) !important",
	},
	".cm-insertedChunk, .cm-insertedText, .cm-addedLine": {
		backgroundColor: "var(--diff-added) !important",
	},
	".cm-gutters": {
		borderRight: "1px solid var(--border) !important",
		paddingRight: "0.5rem !important",
		display: "flex !important",
	},
});
