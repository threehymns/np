import {
	EditorView,
	highlightSpecialChars,
	dropCursor,
	rectangularSelection,
	crosshairCursor,
	highlightActiveLine,
	keymap,
} from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import {
	indentOnInput,
	bracketMatching,
	foldGutter,
	syntaxHighlighting,
	LanguageDescription,
} from "@codemirror/language";
import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Table, GFM } from "@lezer/markdown";
import { languages } from "@codemirror/language-data";
import { svelte } from "@replit/codemirror-lang-svelte";
import {
	markdownTables,
	markdownTableAutocompleter,
	insertEmptyMarkdownTable,
	TableTheme,
	TableStyle,
} from "codemirror-markdown-tables";

import { markdownHighlight } from "./extensions/highlight";
import { hideMarkersPlugin } from "./extensions/hide-markers";
import { codeBlockPlugin } from "./extensions/codeblocks";
import { blockquotePlugin } from "./extensions/blockquote";
import { horizontalRulePlugin } from "./extensions/hr";
import { linkHandlers } from "./extensions/link-events";
import { editorTheme } from "./extensions/theme";
import { smartIndent } from "./extensions/lists";

export function createEditorExtensions(options: {
	wrapCompartment: any;
	wrap: boolean;
}) {
	const { wrapCompartment, wrap } = options;

	return [
		wrapCompartment.of(wrap ? EditorView.lineWrapping : []),
		highlightSpecialChars(),
		history(),
		foldGutter(),
		dropCursor(),
		EditorState.allowMultipleSelections.of(true),
		indentOnInput(),
		bracketMatching(),
		closeBrackets(),
		rectangularSelection(),
		crosshairCursor(),
		highlightActiveLine(),
		highlightSelectionMatches(),
		markdown({
			codeLanguages: [
				...languages,
				LanguageDescription.of({
					name: "svelte",
					alias: ["sv", "svelte"],
					load: async () => svelte(),
				}),
			],
			extensions: [Table, GFM],
		}),
		markdownLanguage.data.of({
			autocomplete: markdownTableAutocompleter(),
		}),
		markdownTables({
			theme: {
				light: TableTheme.light.with({
					"--tbl-theme-row-background": "var(--background)",
					"--tbl-theme-header-row-background": "var(--muted)",
					"--tbl-theme-even-row-background": "var(--background)",
					"--tbl-theme-odd-row-background": "var(--background)",
					"--tbl-theme-text-color": "var(--foreground)",
					"--tbl-theme-menu-background": "var(--background)",
					"--tbl-theme-menu-text-color": "var(--foreground)",
					"--tbl-theme-border-color": "var(--border)",
					"--tbl-theme-border-hover-color": "var(--primary)",
					"--tbl-theme-border-active-color": "var(--primary)",
					"--tbl-theme-outline-color": "var(--primary)",
					"--tbl-theme-select-all-focus-overlay":
						"color-mix(in srgb, var(--primary), transparent 80%)",
					"--tbl-theme-select-all-blur-overlay":
						"color-mix(in srgb, var(--foreground), transparent 92%)",
					"--tbl-theme-menu-hover-background": "var(--accent)",
					"--tbl-theme-menu-hover-text-color": "var(--accent-foreground)",
				}),
				dark: TableTheme.dark.with({
					"--tbl-theme-row-background": "var(--background)",
					"--tbl-theme-header-row-background": "var(--muted)",
					"--tbl-theme-even-row-background": "var(--background)",
					"--tbl-theme-odd-row-background": "var(--background)",
					"--tbl-theme-text-color": "var(--foreground)",
					"--tbl-theme-menu-background": "var(--background)",
					"--tbl-theme-menu-text-color": "var(--foreground)",
					"--tbl-theme-border-color": "var(--border)",
					"--tbl-theme-border-hover-color": "var(--primary)",
					"--tbl-theme-border-active-color": "var(--primary)",
					"--tbl-theme-outline-color": "var(--primary)",
					"--tbl-theme-select-all-focus-overlay":
						"color-mix(in srgb, var(--primary), transparent 80%)",
					"--tbl-theme-select-all-blur-overlay":
						"color-mix(in srgb, var(--foreground), transparent 92%)",
					"--tbl-theme-menu-hover-background": "var(--accent)",
					"--tbl-theme-menu-hover-text-color": "var(--accent-foreground)",
				}),
			},
			style: TableStyle.default,
			markdownConfig: {
				extensions: [Table, GFM],
			},
			extensions: [
				keymap.of(defaultKeymap),
				highlightActiveLine(),
				hideMarkersPlugin,
				syntaxHighlighting(markdownHighlight),
			],
			globalKeyBindings: [...historyKeymap, ...searchKeymap],
		}),
		syntaxHighlighting(markdownHighlight),
		hideMarkersPlugin,
		codeBlockPlugin,
		blockquotePlugin,
		horizontalRulePlugin,
		linkHandlers,
		editorTheme,
		keymap.of([
			...closeBracketsKeymap,
			...defaultKeymap,
			...searchKeymap,
			...historyKeymap,
			{ key: "Tab", run: smartIndent("more") },
			{ key: "Shift-Tab", run: smartIndent("less") },
			{
				key: "Alt-Mod-t",
				run: insertEmptyMarkdownTable({
					size: { rows: 2, cols: 2 },
				}),
			},
		]),
	];
}

export * from "./extensions/lists";
export * from "./extensions/highlight";
export * from "./extensions/codeblocks";
export * from "./extensions/blockquote";
export * from "./extensions/hr";
export * from "./extensions/hide-markers";
export * from "./extensions/link-events";
export * from "./extensions/theme";
