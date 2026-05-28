import { EditorView } from "@codemirror/view";

export const editorTheme = EditorView.theme({
	"&": { 
		height: "100%",
		fontSize: "1.05rem",
		backgroundColor: "transparent",
	},
	".cm-content": {
		padding: "1.5rem",
		color: "var(--foreground)",
		caretColor: "var(--primary)",
		width: "100%",
	},
	"&.is-markdown .cm-content": {
		fontFamily: "ui-sans-serif, system-ui, sans-serif",
		maxWidth: "var(--editor-max-width)",
		margin: "0 auto",
	},
	"&.is-code .cm-content": {
		fontFamily: "var(--font-mono)",
		maxWidth: "none",
		margin: "0",
	},
	".cm-scroller": {
		lineHeight: "1.6",
	},
	".cm-gutters": {
		display: "none",
	},
	"&.is-code .cm-gutters": {
		display: "flex",
		backgroundColor: "transparent",
		border: "none",
		color: "var(--muted-foreground)",
		fontFamily: "var(--font-mono)",
		fontSize: "0.85rem",
	},
	"&.cm-focused": {
		outline: "none",
	},
	".cm-activeLine": {
		backgroundColor: "transparent",
	},
	".cm-panels": {
		backgroundColor: "transparent",
		color: "var(--foreground)",
	},
	".cm-panels-top": {
		borderBottom: "1px solid var(--border)",
	},
	".cm-panels-bottom": {
		borderTop: "1px solid var(--border)",
	},
	".cm-panel.cm-search": {
		padding: "0.5rem",
		backgroundColor:
			"color-mix(in srgb, var(--popover) 70%, transparent)",
		backdropFilter: "blur(24px) saturate(150%)",
		color: "var(--popover-foreground)",
		fontFamily: "ui-sans-serif, system-ui, sans-serif",
	},
	".cm-searchMatch": {
		backgroundColor:
			"color-mix(in oklch, var(--primary) 30%, transparent)",
	},
	".cm-searchMatch-selected": {
		backgroundColor:
			"color-mix(in oklch, var(--primary) 60%, transparent)",
	},
	".cm-textfield": {
		backgroundColor: "var(--background)",
		color: "var(--foreground)",
		border: "1px solid var(--input)",
		borderRadius: "var(--radius)",
		padding: "0.25rem 0.5rem",
		outline: "none",
		fontFamily: "inherit",
		fontSize: "0.875rem",
	},
	".cm-textfield:focus": {
		borderColor: "var(--ring)",
		boxShadow: "0 0 0 1px var(--ring)",
	},
	".cm-button": {
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		whiteSpace: "nowrap",
		transition: "all 150ms ease",
		outline: "none",
		userSelect: "none",
		border: "1px solid var(--border)",
		backgroundColor:
			"color-mix(in srgb, var(--input) 30%, transparent)",
		color: "var(--foreground)",
		backgroundImage: "none",
		borderRadius: "0.375rem" /* rounded-md */,
		height: "1.75rem" /* h-7 */,
		padding: "0 0.5rem" /* px-2 */,
		fontSize: "0.75rem" /* text-xs */,
		lineHeight: "1.625" /* relaxed */,
		fontWeight: "500" /* font-medium */,
		cursor: "pointer",
		fontFamily: "inherit",
		margin: "0 0.25rem",
		flexShrink: 0,
	},
	".cm-button:focus-visible": {
		borderColor: "var(--ring)",
		boxShadow:
			"0 0 0 2px color-mix(in srgb, var(--ring) 30%, transparent)",
	},
	".cm-button:active:not([disabled])": {
		transform: "translateY(1px)",
		backgroundImage: "none",
	},
	".cm-button:disabled": {
		opacity: "0.5",
		pointerEvents: "none",
	},
	".cm-button:hover": {
		backgroundColor:
			"color-mix(in srgb, var(--input) 50%, transparent)",
		color: "var(--foreground)",
	},
	".cm-panel.cm-search label": {
		fontSize: "0.875rem",
		marginRight: "0.5rem",
		display: "inline-flex",
		alignItems: "center",
		gap: "0.25rem",
		cursor: "pointer",
	},
	".cm-panel.cm-search input[type=checkbox]": {
		appearance: "none",
		width: "1rem",
		height: "1rem",
		border: "1px solid var(--primary)",
		borderRadius: "0.25rem",
		margin: "0",
		display: "grid",
		placeContent: "center",
		cursor: "pointer",
		backgroundColor: "var(--background)",
	},
	".cm-panel.cm-search input[type=checkbox]::before": {
		content: '""',
		width: "0.65em",
		height: "0.65em",
		transform: "scale(0)",
		transition: "120ms transform ease-in-out",
		boxShadow: "inset 1em 1em var(--primary-foreground)",
		backgroundColor: "var(--primary-foreground)",
		transformOrigin: "center",
		clipPath:
			"polygon(14% 44%, 0 65%, 50% 100%, 100% 16%, 80% 0%, 43% 62%)",
	},
	".cm-panel.cm-search input[type=checkbox]:checked": {
		backgroundColor: "var(--primary)",
		borderColor: "var(--primary)",
	},
	".cm-panel.cm-search input[type=checkbox]:checked::before":
		{
			transform: "scale(1)",
		},
	".cm-panel.cm-search [name=close]": {
		color: "var(--muted-foreground)",
		cursor: "pointer",
	},
	".cm-panel.cm-search [name=close]:hover": {
		color: "var(--foreground)",
	},
});
