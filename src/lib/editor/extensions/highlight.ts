import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

export const markdownHighlight = HighlightStyle.define([
	{
		tag: t.heading1,
		fontSize: "2.25rem",
		fontWeight: "bold",
		lineHeight: "1.2",
		color: "var(--foreground)",
	},
	{
		tag: t.heading2,
		fontSize: "1.875rem",
		fontWeight: "bold",
		lineHeight: "1.2",
		color: "var(--foreground)",
	},
	{
		tag: t.heading3,
		fontSize: "1.5rem",
		fontWeight: "bold",
		lineHeight: "1.2",
		color: "var(--foreground)",
	},
	{ tag: t.strong, fontWeight: "bold", color: "var(--foreground)" },
	{ tag: t.emphasis, fontStyle: "italic" },
	{ tag: t.quote, color: "var(--muted-foreground)", fontStyle: "italic" },
	{
		tag: [t.link, t.labelName],
		color: "var(--code-operator)",
		textDecoration: "none",
		class: "cm-link",
	},
	{
		tag: t.monospace,
		fontFamily: "var(--font-mono)",
		backgroundColor: "var(--muted)",
		padding: "0.1em 0.3em",
		borderRadius: "3px",
	},
	{
		tag: [t.processingInstruction, t.meta, t.punctuation, t.separator],
		color: "var(--muted-foreground)",
		class: "md-marker",
	},

	// Code highlighting - Safely using basic tags
	{ tag: t.keyword, color: "var(--code-keyword)", fontWeight: "600" },
	{
		tag: [t.name, t.variableName, t.macroName, t.attributeName],
		color: "var(--code-variable)",
	},
	{
		tag: [t.function(t.variableName), t.labelName, t.propertyName],
		color: "var(--code-function)",
	},
	{
		tag: [
			t.typeName,
			t.className,
			t.changed,
			t.annotation,
			t.modifier,
			t.namespace,
		],
		color: "var(--code-type)",
	},
	{
		tag: [t.number, t.bool, t.null, t.unit],
		color: "var(--code-number)",
	},
	{
		tag: [t.constant(t.name), t.literal],
		color: "var(--code-constant)",
	},
	{
		tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp],
		color: "var(--code-operator)",
	},
	{ tag: [t.comment], color: "var(--code-comment)", fontStyle: "italic" },
	{ tag: t.string, color: "var(--code-string)" },
	{ tag: t.invalid, color: "var(--destructive)" },
]);
