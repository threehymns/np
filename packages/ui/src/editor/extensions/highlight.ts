import { HighlightStyle } from "@codemirror/language";
import { tags as t, Tag } from "@lezer/highlight";
import type { TagStyle } from "@codemirror/language";

// Custom tag for Obsidian `==highlight==` so the composed style can target it.
export const markHighlightTag = Tag.define("mark");

// Custom tag for Obsidian taxonomy tags (#tag / #a/b).
export const taxTag = Tag.define("taxonomy");

// Obsidian footnote references: link-styled (derived) + raised via cm-footnote.
export const footnoteTag = Tag.define("footnote", t.link);

// Obsidian hidden text (%%…%%) and block anchors (^id): faded but visible.
export const fadedTag = Tag.define("faded");

// Per-feature statement style chunks, composed into one HighlightStyle.define
// below. We keep a single define (rather than several HighlightStyle.define +
// syntaxHighlighting() calls) so feature tags keep a stable intra-array
// precedence and the composed style tree stays byte-identical. To add a
// feature's live-source styling, append its chunk array to `markdownHighlightChunks`
// (e.g. spread `...s1HighlightStyles`); this one registration line is the seam.
const headingStyles: TagStyle[] = [
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
	{ tag: t.strikethrough, textDecoration: "line-through" },
	// NOTE: a TagStyle with `class` emits ONLY that class — CodeMirror builds
	// it as `style.class || generated`, so any sibling style props would be
	// silently dropped. Class-hooked chunks therefore stay class-only and
	// their visuals live in styles/markdown.css (same as .cm-footnote).
	{
		tag: markHighlightTag,
		class: "cm-mark",
	},
	{
		tag: taxTag,
		class: "cm-tag",
	},
	{
		tag: footnoteTag,
		class: "cm-footnote",
	},
	{
		tag: fadedTag,
		class: "md-faded",
	},
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
];

// Inline-code highlighting — using basic tags only to stay CM-safe.
const codeStyles: TagStyle[] = [
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
];

export const markdownHighlightChunks: TagStyle[] = [
	...headingStyles,
	...codeStyles,
	// New feature style chunks register here, e.g. `...s1HighlightStyles`..
];

export const markdownHighlight = HighlightStyle.define(markdownHighlightChunks);
