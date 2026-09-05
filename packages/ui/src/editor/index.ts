import {
	EditorView,
	highlightSpecialChars,
	dropCursor,
	rectangularSelection,
	crosshairCursor,
	highlightActiveLine,
	keymap,
	lineNumbers,
	drawSelection,
} from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import {
	indentOnInput,
	bracketMatching,
	foldGutter,
	syntaxHighlighting,
	LanguageDescription,
} from "@codemirror/language";
import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap, autocompletion } from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Table, GFM, type MarkdownExtension } from "@lezer/markdown";
import { languages } from "@codemirror/language-data";
import {
	markdownTables,
	markdownTableAutocompleter,
	insertEmptyMarkdownTable,
	TableTheme,
	TableStyle,
} from "codemirror-markdown-tables";
import { vim, Vim, CodeMirror } from "@replit/codemirror-vim";

// Patch CodeMirror wrapper prototype methods to avoid RangeError on out-of-bounds selections/offsets.
// This handles a bug in @replit/codemirror-vim where pasting in Visual Line mode can calculate
// out-of-bounds indexes/positions for the last selection, throwing RangeError and causing
// keydowns (like 'p') to propagate to the browser and type literal characters.
if (CodeMirror && CodeMirror.prototype) {
	if (CodeMirror.prototype.posFromIndex) {
		const originalPosFromIndex = CodeMirror.prototype.posFromIndex;
		CodeMirror.prototype.posFromIndex = function(this: any, offset: number) {
			const docLength = this.cm6.state.doc.length;
			const clippedOffset = Math.max(0, Math.min(offset, docLength));
			return originalPosFromIndex.call(this, clippedOffset);
		};
	}
	if (CodeMirror.prototype.indexFromPos) {
		const originalIndexFromPos = CodeMirror.prototype.indexFromPos;
		CodeMirror.prototype.indexFromPos = function(this: any, pos: any) {
			if (!pos) return 0;
			const doc = this.cm6.state.doc;
			const lines = doc.lines;
			const clippedLine = Math.max(0, Math.min(pos.line, lines - 1));
			const lineObj = doc.line(clippedLine + 1);
			const clippedCh = Math.max(0, Math.min(pos.ch, lineObj.length));
			return originalIndexFromPos.call(this, { line: clippedLine, ch: clippedCh });
		};
	}
}

import { allLanguages } from "@np/core";
import { markdownHighlight } from "./extensions/highlight";
import { hideMarkersPlugin } from "./extensions/hide-markers";
import { codeBlockPlugin } from "./extensions/codeblocks";
import { blockquotePlugin } from "./extensions/blockquote";
import { horizontalRulePlugin } from "./extensions/hr";
import { calloutPlugin, calloutFoldField } from "./extensions/callout";
import { taskCheckboxPlugin, toggleTaskKeymap } from "./extensions/tasks";
import { sizeBadgePlugin } from "./extensions/image-size";
import { embedPlugin } from "./extensions/embeds";
import { FootnoteExtension } from "./extensions/footnote";
import { FadedExtension } from "./extensions/faded";
import { frontmatterPlugin } from "./extensions/frontmatter";
import { linkHandlers } from "./extensions/link-events";
import { editorTheme } from "./extensions/theme";
import { smartIndent } from "./extensions/lists";
import { WikiLinkExtension, wikilinkAutocompletion } from "./extensions/wikilinks";
import { StrikethroughExtension } from "./extensions/strikethrough";
import { HighlightExtension } from "./extensions/inline-highlight";
import { HashTagExtension } from "./extensions/hash-tags";
import { MathExtension } from "./extensions/math";
import { htmlPassthroughPlugin } from "./extensions/html";

// Central Markdown language composition (WikiLinkExtension precedent). The
// Editor's Markdown language must be a single markdown() superset — never a
// second stacked `lang` (CodeMirror resolves the tree from the first language,
// which would break [[Note]] parsing/hiding). To add a Markdown feature: define
// its MarkdownConfig in its own module, then append it here. New feature
// registrations collide only on these adjacent lines.
const markdownFeatureConfigs: MarkdownExtension[] = [
	Table,
	GFM,
	WikiLinkExtension,
	StrikethroughExtension,
	HighlightExtension,
	HashTagExtension,
	MathExtension,
	FootnoteExtension,
	FadedExtension,
];

export async function getLanguageExtensions(langDesc: LanguageDescription | null) {
	if (!langDesc) return [];

	const lang = await langDesc.load();
	
	if (langDesc.name === "Markdown") {
		// NOTE: do not include the plain `lang` here. It is a second,
		// WikiLink-less Markdown language and CodeMirror resolves the
		// syntax tree from the first language in the stack — so keeping it
		// makes [[Note]] parse as the inner single-bracket Link instead of
		// the outer WikiLink (breaking click/Enter, marker hiding, styling).
		// The custom markdown() below is a superset (codeLanguages + Table,
		// GFM, WikiLinkExtension) and must be the sole language.
		return [
			markdown({
				codeLanguages: allLanguages as any,
				extensions: markdownFeatureConfigs,
			}),
			markdownLanguage.data.of({
				autocomplete: markdownTableAutocompleter(),
			}),
			markdownLanguage.data.of({
				autocomplete: wikilinkAutocompletion,
			}),
			markdownTables({
				theme: markdownTableTheme,
				style: TableStyle.default,
				markdownConfig: {
					extensions: markdownFeatureConfigs,
				},
				extensions: [
					keymap.of(defaultKeymap),
					highlightActiveLine(),
					hideMarkersPlugin,
					syntaxHighlighting(markdownHighlight),
				],
				globalKeyBindings: [...historyKeymap, ...searchKeymap],
			}),
			hideMarkersPlugin,
			codeBlockPlugin,
			blockquotePlugin,
			horizontalRulePlugin,
			calloutPlugin,
			calloutFoldField,
			taskCheckboxPlugin,
			toggleTaskKeymap,
			sizeBadgePlugin,
			embedPlugin,
			frontmatterPlugin,
			htmlPassthroughPlugin,
			EditorView.editorAttributes.of({ class: "is-markdown" }),
		];
	}

	return [
		lang,
		lineNumbers(),
		EditorView.editorAttributes.of({ class: "is-code" }),
	];
}

const markdownTableTheme = {
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
};

export function createEditorExtensions(options: {
	wrapCompartment: Compartment;
	languageCompartment: Compartment;
	vimCompartment: Compartment;
	wrap: boolean;
	vimEnabled: boolean;
	initialLanguageExtensions: any[];
}) {
	const { wrapCompartment, languageCompartment, vimCompartment, wrap, vimEnabled, initialLanguageExtensions } = options;

	return [
		wrapCompartment.of(wrap ? EditorView.lineWrapping : []),
		languageCompartment.of(initialLanguageExtensions),
		vimCompartment.of(vimEnabled ? vim() : []),
		highlightSpecialChars(),
		history(),
		drawSelection(),
		foldGutter(),
		dropCursor(),
		EditorState.allowMultipleSelections.of(true),
		indentOnInput(),
		bracketMatching(),
		closeBrackets(),
		autocompletion(),
		rectangularSelection(),
		crosshairCursor(),
		highlightActiveLine(),
		highlightSelectionMatches(),
		syntaxHighlighting(markdownHighlight),
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
export * from "./extensions/callout";
export * from "./extensions/tasks";
export * from "./extensions/image-size";
export * from "./extensions/embeds";
export * from "./extensions/hide-markers";
export * from "./extensions/link-events";
export * from "./extensions/wikilinks";
export * from "./extensions/strikethrough";
export * from "./extensions/inline-highlight";
export * from "./extensions/hash-tags";
export * from "./extensions/math";
export * from "./extensions/footnote";
export * from "./extensions/faded";
export * from "./extensions/frontmatter";
export * from "./extensions/html";
export * from "./extensions/theme";
export * from "./extensions/diff-theme";
import "./styles/diff.css";
export { allLanguages, LanguageSupport } from "@np/core";
export { SelectionState, selectionState } from "@np/core";

let originalMethods: Map<any, { setText: any; pushText: any }> = new Map();

export function setupVimClipboardSync(enabled: boolean) {
	if (typeof window === "undefined" || !navigator.clipboard) return;

	try {
		const controller = Vim.getRegisterController();
		if (!controller) return;

		const registersToSync = ['"', '+', '*'];

		registersToSync.forEach(name => {
			const reg = name === '"' ? controller.unnamedRegister : controller.getRegister(name);
			if (!reg) return;

			if (enabled) {
				if (originalMethods.has(reg)) return;

				const originalSetText = reg.setText.bind(reg);
				const originalPushText = reg.pushText.bind(reg);

				originalMethods.set(reg, { setText: originalSetText, pushText: originalPushText });

				reg.setText = (text: string, linewise?: boolean, blockwise?: boolean) => {
					originalSetText(text, linewise, blockwise);
					if (text) {
						navigator.clipboard.writeText(text).catch(() => {});
					}
				};

				reg.pushText = (text: string, linewise?: boolean) => {
					originalPushText(text, linewise);
					const currentText = reg.toString();
					if (currentText) {
						navigator.clipboard.writeText(currentText).catch(() => {});
					}
				};
			} else {
				const original = originalMethods.get(reg);
				if (original) {
					reg.setText = original.setText;
					reg.pushText = original.pushText;
					originalMethods.delete(reg);
				}
			}
		});
	} catch (e) {
		console.warn("Failed to toggle Vim clipboard sync:", e);
	}
}

export async function syncVimRegistersFromClipboard() {
	if (typeof window === "undefined" || !navigator.clipboard) return;

	try {
		const text = await navigator.clipboard.readText();
		if (!text) return;

		const controller = Vim.getRegisterController();
		if (!controller) return;

		const registersToSync = ['"', '+', '*'];
		registersToSync.forEach(name => {
			const reg = name === '"' ? controller.unnamedRegister : controller.getRegister(name);
			if (reg && reg.toString() !== text) {
				reg.keyBuffer = [text];
				reg.linewise = false;
				reg.blockwise = false;
			}
		});
	} catch (e) {
		// Fail silently
	}
}
