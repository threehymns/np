<script lang="ts">
	import { untrack } from "svelte";
	import { EditorView } from "codemirror";
	import {
		Decoration,
		ViewPlugin,
		ViewUpdate,
		WidgetType,
		keymap,
		highlightSpecialChars,
		dropCursor,
		rectangularSelection,
		crosshairCursor,
		highlightActiveLine,
	} from "@codemirror/view";
	import type { DecorationSet } from "@codemirror/view";
	import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
	import { Table, GFM } from "@lezer/markdown";
	import {
		EditorState,
		RangeSetBuilder,
		Compartment,
		Annotation,
	} from "@codemirror/state";
	import {
		syntaxHighlighting,
		HighlightStyle,
		syntaxTree,
		foldGutter,
		indentOnInput,
		bracketMatching,
		LanguageDescription,
	} from "@codemirror/language";
	import { tags as t } from "@lezer/highlight";
	import {
		indentMore,
		indentLess,
		history,
		historyKeymap,
		defaultKeymap,
	} from "@codemirror/commands";
	import {
		closeBrackets,
		closeBracketsKeymap,
	} from "@codemirror/autocomplete";
	import {
		highlightSelectionMatches,
		searchKeymap,
	} from "@codemirror/search";
	import { languages } from "@codemirror/language-data";
	import { svelte } from "@replit/codemirror-lang-svelte";
	import {
		markdownTables,
		markdownTableAutocompleter,
		insertEmptyMarkdownTable,
		TableTheme,
		TableStyle,
	} from "codemirror-markdown-tables";

	let {
		content = $bindable(),
		style = "",
		wrap = true,
		view = $bindable(),
	} = $props();

	let editorEl = $state<HTMLDivElement>();
	let altPressed = $state(false);
	const wrapCompartment = new Compartment();
	const syncAnnotation = Annotation.define<boolean>();

	// Helper to find all children of a list item
	function getListBlockRange(state: EditorState, pos: number) {
		const line = state.doc.lineAt(pos);
		const match = line.text.match(/^(\s*)/);
		const indent = match ? match[1].length : 0;
		let to = line.to;

		for (let i = line.number + 1; i <= state.doc.lines; i++) {
			const nextLine = state.doc.line(i);
			if (nextLine.text.trim() === "") continue;
			const nextIndent = nextLine.text.match(/^(\s*)/)?.[1].length || 0;
			if (nextIndent > indent) {
				to = nextLine.to;
			} else {
				break;
			}
		}
		return { from: line.from, to };
	}

	// Helper to renumber all ordered lists in the document
	function renumberLists(view: EditorView) {
		const { state } = view;
		const doc = state.doc;
		const changes: { from: number; to: number; insert: string }[] = [];
		const stack: { indent: number; count: number }[] = [];

		for (let i = 1; i <= doc.lines; i++) {
			const line = doc.line(i);
			const match = line.text.match(/^(\s*)(\d+)\.\s/);

			if (match) {
				const indent = match[1].length;
				const currentNum = parseInt(match[2]);

				// Manage hierarchy stack
				while (
					stack.length > 0 &&
					stack[stack.length - 1].indent > indent
				) {
					stack.pop();
				}

				if (
					stack.length === 0 ||
					stack[stack.length - 1].indent < indent
				) {
					stack.push({ indent, count: 1 });
				} else {
					stack[stack.length - 1].count++;
				}

				const expectedNum = stack[stack.length - 1].count;
				if (currentNum !== expectedNum) {
					const from = line.from + match[1].length;
					const to = from + match[2].length;
					changes.push({ from, to, insert: String(expectedNum) });
				}
			} else if (line.text.trim() === "") {
				continue;
			} else {
				// Non-list line resets stack for this level and deeper
				const indent = line.text.match(/^\s*/)?.[0].length || 0;
				while (
					stack.length > 0 &&
					stack[stack.length - 1].indent >= indent
				) {
					stack.pop();
				}
			}
		}

		if (changes.length > 0) {
			view.dispatch({ changes });
		}
	}

	const smartIndent = (direction: "more" | "less") => (view: EditorView) => {
		const { state } = view;
		const selection = state.selection.main;
		const line = state.doc.lineAt(selection.from);

		// Only use smart indent if it looks like a list item
		if (!/^(\s*)([*+-]|\d+\.)\s/.test(line.text)) {
			return direction === "more" ? indentMore(view) : indentLess(view);
		}

		const range = getListBlockRange(state, selection.from);
		const changes: { from: number; to: number; insert: string }[] = [];
		const indentUnit = "  "; // We'll use 2 spaces as the default for now

		for (
			let i = state.doc.lineAt(range.from).number;
			i <= state.doc.lineAt(range.to).number;
			i++
		) {
			const l = state.doc.line(i);
			if (l.text.trim() === "") continue;

			if (direction === "more") {
				changes.push({ from: l.from, to: l.from, insert: indentUnit });
			} else {
				const match = l.text.match(/^(\s+)/);
				if (match && match[1].length >= indentUnit.length) {
					changes.push({
						from: l.from,
						to: l.from + indentUnit.length,
						insert: "",
					});
				}
			}
		}

		if (changes.length > 0) {
			view.dispatch({
				changes,
				// This keeps the cursor relative to the text
				selection: {
					anchor:
						selection.from +
						(direction === "more"
							? indentUnit.length
							: -indentUnit.length),
					head:
						selection.head +
						(direction === "more"
							? indentUnit.length
							: -indentUnit.length),
				},
			});
			setTimeout(() => renumberLists(view), 10);
			return true;
		}

		return false;
	};

	const markdownHighlight = HighlightStyle.define([
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

	class CopyButtonWidget extends WidgetType {
		text: string;
		constructor(text: string) {
			super();
			this.text = text;
		}
		eq(other: CopyButtonWidget) {
			return other.text === this.text;
		}
		toDOM() {
			const btn = document.createElement("button");
			btn.className = "cm-copy-button";
			btn.setAttribute("aria-label", "Copy code");
			btn.title = "Copy code";
			btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="copy-icon"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
							<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="check-icon" style="display: none;"><polyline points="20 6 9 17 4 12"/></svg>`;

			btn.onclick = (e) => {
				e.preventDefault();
				e.stopPropagation();
				navigator.clipboard.writeText(this.text).then(() => {
					const copyIcon = btn.querySelector(
						".copy-icon",
					) as HTMLElement;
					const checkIcon = btn.querySelector(
						".check-icon",
					) as HTMLElement;
					if (copyIcon && checkIcon) {
						copyIcon.style.display = "none";
						checkIcon.style.display = "block";
						btn.classList.add("copied");
						setTimeout(() => {
							copyIcon.style.display = "block";
							checkIcon.style.display = "none";
							btn.classList.remove("copied");
						}, 2000);
					}
				});
			};
			return btn;
		}
	}

	// Plugin to add classes to code block lines for background and font
	class CodeBlockPlugin {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = this.getDecorations(view);
		}
		update(update: ViewUpdate) {
			if (update.docChanged || update.viewportChanged)
				this.decorations = this.getDecorations(update.view);
		}
		getDecorations(view: EditorView) {
			const builder = new RangeSetBuilder<Decoration>();
			for (let { from, to } of view.visibleRanges) {
				syntaxTree(view.state).iterate({
					from,
					to,
					enter: (node) => {
						if (node.name === "FencedCode") {
							const fullText = view.state.doc.sliceString(
								node.from,
								node.to,
							);
							const linesArr = fullText.split("\n");
							// Extract content between fences
							const codeToCopy = linesArr.slice(1, -1).join("\n");

							const startLine = view.state.doc.lineAt(
								node.from,
							).number;
							const endLine = view.state.doc.lineAt(
								node.to,
							).number;
							for (let i = startLine; i <= endLine; i++) {
								const line = view.state.doc.line(i);
								let cls = "cm-fencedCode";
								if (i === startLine)
									cls += " cm-fencedCode-top";
								if (i === endLine)
									cls += " cm-fencedCode-bottom";
								if (i > startLine && i < endLine)
									cls += " cm-fencedCode-line";

								// Line decoration must be added at line.from (start of line)
								builder.add(
									line.from,
									line.from,
									Decoration.line({ class: cls }),
								);

								if (i === startLine) {
									// Widget decoration added at line.to (end of line), which is >= line.from
									builder.add(
										line.to,
										line.to,
										Decoration.widget({
											widget: new CopyButtonWidget(
												codeToCopy,
											),
											side: 1,
										}),
									);
								}
							}
						}
					},
				});
			}
			return builder.finish();
		}
	}
	const codeBlockPlugin = ViewPlugin.fromClass(CodeBlockPlugin, {
		decorations: (v) => v.decorations,
	});
	
	class BlockquotePlugin {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = this.getDecorations(view);
		}
		update(update: ViewUpdate) {
			if (update.docChanged || update.viewportChanged)
				this.decorations = this.getDecorations(update.view);
		}
		getDecorations(view: EditorView) {
			const builder = new RangeSetBuilder<Decoration>();
			for (let { from, to } of view.visibleRanges) {
				syntaxTree(view.state).iterate({
					from,
					to,
					enter: (node) => {
						if (node.name === "Blockquote") {
							const startLine = view.state.doc.lineAt(
								node.from,
							).number;
							const endLine = view.state.doc.lineAt(
								node.to,
							).number;
							for (let i = startLine; i <= endLine; i++) {
								const line = view.state.doc.line(i);
								builder.add(
									line.from,
									line.from,
									Decoration.line({ class: "cm-blockquote" }),
								);
							}
						}
					},
				});
			}
			return builder.finish();
		}
	}
	const blockquotePlugin = ViewPlugin.fromClass(BlockquotePlugin, {
		decorations: (v) => v.decorations,
	});

	class HorizontalRuleWidget extends WidgetType {
		view: EditorView;
		from: number;
		to: number;
		constructor(view: EditorView, from: number, to: number) {
			super();
			this.view = view;
			this.from = from;
			this.to = to;
		}
		toDOM() {
			const wrapper = document.createElement("div");
			wrapper.className = "cm-horizontal-rule-wrapper";
			const hr = document.createElement("div");
			hr.className = "cm-horizontal-rule-inner";
			wrapper.appendChild(hr);

			wrapper.onclick = (e) => {
				e.preventDefault();
				this.view.focus();
				this.view.dispatch({
					selection: { anchor: this.from, head: this.to },
					scrollIntoView: true,
				});
			};

			return wrapper;
		}
	}

	class HorizontalRulePlugin {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = this.getDecorations(view);
		}
		update(update: ViewUpdate) {
			if (
				update.docChanged ||
				update.viewportChanged ||
				update.selectionSet ||
				update.focusChanged
			)
				this.decorations = this.getDecorations(update.view);
		}
		getDecorations(view: EditorView) {
			const builder = new RangeSetBuilder<Decoration>();
			const selection = view.state.selection.main;
			const curLine = view.state.doc.lineAt(selection.from).number;

			for (let { from, to } of view.visibleRanges) {
				syntaxTree(view.state).iterate({
					from,
					to,
					enter: (node) => {
						if (node.name === "HorizontalRule") {
							const line = view.state.doc.lineAt(node.from);
							const isLineActive =
								view.hasFocus && line.number === curLine;

							if (!isLineActive) {
								builder.add(
									line.from,
									line.from,
									Decoration.line({
										class: "cm-hr-line",
									}),
								);
								builder.add(
									line.from,
									line.to,
									Decoration.replace({
										widget: new HorizontalRuleWidget(
											view,
											line.from,
											line.to,
										),
									}),
								);
							} else {
								builder.add(
									line.from,
									line.from,
									Decoration.line({
										class: "cm-horizontal-rule-active",
									}),
								);
							}
						}
					},
				});
			}
			return builder.finish();
		}
	}
	const horizontalRulePlugin = ViewPlugin.fromClass(HorizontalRulePlugin, {
		decorations: (v) => v.decorations,
	});

	class BulletWidget extends WidgetType {
		toDOM() {
			let span = document.createElement("span");
			span.textContent = "•";
			span.className = "md-bullet";
			return span;
		}
	}

	class LanguageLabelWidget extends WidgetType {
		lang: string;
		constructor(lang: string) {
			super();
			this.lang = lang;
		}
		eq(other: LanguageLabelWidget) {
			return other.lang === this.lang;
		}
		toDOM() {
			const span = document.createElement("span");
			span.className = "cm-language-label";
			span.textContent = this.lang;
			return span;
		}
	}

	class HideMarkersPlugin {
		decorations: DecorationSet;

		constructor(view: EditorView) {
			this.decorations = this.getDecorations(view);
		}

		update(update: ViewUpdate) {
			if (
				update.docChanged ||
				update.selectionSet ||
				update.viewportChanged ||
				update.focusChanged
			) {
				this.decorations = this.getDecorations(update.view);
			}
		}

		getDecorations(view: EditorView) {
			const builder = new RangeSetBuilder<Decoration>();
			const selection = view.state.selection.main;
			const curLine = view.state.doc.lineAt(selection.from).number;

			for (let { from, to } of view.visibleRanges) {
				syntaxTree(view.state).iterate({
					from,
					to,
					enter: (node) => {
						const type = node.name;

						if (type === "FencedCode") {
							const startLine = view.state.doc.lineAt(node.from);
							const hasFocus = view.hasFocus;

							if (!(hasFocus && startLine.number === curLine)) {
								// Find language
								let lang = "";
								node.node.cursor().iterate((c) => {
									if (c.name === "CodeInfo") {
										lang = view.state.doc
											.sliceString(c.from, c.to)
											.trim();
										return false;
									}
								});

								builder.add(
									startLine.from,
									startLine.to,
									Decoration.replace({
										widget: lang
											? new LanguageLabelWidget(lang)
											: undefined,
									}),
								);
							}

							const lastChild = node.node.lastChild;
							if (
								lastChild &&
								lastChild.name === "CodeMark" &&
								lastChild.from > startLine.to
							) {
								const endLine = view.state.doc.lineAt(
									lastChild.from,
								);
								if (
									endLine.number !== startLine.number &&
									!(hasFocus && endLine.number === curLine)
								) {
									builder.add(
										endLine.from,
										endLine.to,
										Decoration.replace({}),
									);
								}
							}
							return false; // Don't process children as markers
						}

						// Add a class to the entire link node when expanded for CSS targeting
						if (type === "Link") {
							const isExpanded =
								view.hasFocus &&
								selection.from <= node.to &&
								selection.to >= node.from;
							if (isExpanded) {
								builder.add(
									node.from,
									node.to,
									Decoration.mark({
										class: "cm-link-expanded",
									}),
								);
							}
						}

						const isMarker =
							type.includes("Mark") ||
							type.includes("Delimiter") ||
							type === "HeaderMark" ||
							type === "CodeMark" ||
							type === "CodeInfo" ||
							type === "URL";

						if (isMarker) {
							const line = view.state.doc.lineAt(
								node.from,
							).number;
							let shouldShow = view.hasFocus && line === curLine;

							// Surgical hiding for inline markers: only show if cursor is inside the parent node
							const inlineTypes = [
								"Emphasis",
								"StrongEmphasis",
								"InlineCode",
								"Link",
								"Image",
							];
							let parent = node.node.parent;

							// Special case for Link: Hide [ ] around label and (url) part
							if (type === "LinkMark") {
								let linkNode = parent;
								while (
									linkNode &&
									linkNode.name !== "Link" &&
									linkNode.name !== "Document"
								) {
									linkNode = linkNode.parent;
								}

								if (linkNode && linkNode.name === "Link") {
									shouldShow =
										view.hasFocus &&
										selection.from <= linkNode.to &&
										selection.to >= linkNode.from;
								}
							}

							// Handle URL inside markdown links - only hide if inside a Link node
							if (type === "URL") {
								let linkNode = parent;
								while (
									linkNode &&
									linkNode.name !== "Link" &&
									linkNode.name !== "Document"
								) {
									linkNode = linkNode.parent;
								}

								// Only hide URL if it's inside a markdown Link; otherwise leave visible
								if (!linkNode || linkNode.name !== "Link") {
									shouldShow = true; // Don't hide standalone URLs
								} else {
									shouldShow =
										view.hasFocus &&
										selection.from <= linkNode.to &&
										selection.to >= linkNode.from;
								}
							} else if (
								parent &&
								inlineTypes.includes(parent.name)
							) {
								// For other inline elements, only show if selection intersects the parent node
								shouldShow =
									view.hasFocus &&
									selection.from <= parent.to &&
									selection.to >= parent.from;
							}

							if (!shouldShow) {
								if (type === "ListMark") {
									const text = view.state.doc.sliceString(
										node.from,
										node.to,
									);
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
								} else if (type === "HeaderMark") {
									let parentName = node.node.parent?.name;
									if (
										parentName === "SetextHeading1" ||
										parentName === "SetextHeading2"
									) {
										builder.add(
											node.from,
											node.to,
											Decoration.mark({
												class: "md-faded",
											}),
										);
									} else {
										let to = node.to;
										if (
											view.state.doc.sliceString(
												to,
												to + 1,
											) === " "
										) {
											to++;
										}
										builder.add(
											node.from,
											to,
											Decoration.replace({}),
										);
									}
								} else if (type === "QuoteMark") {
									let to = node.to;
									if (
										view.state.doc.sliceString(
											to,
											to + 1,
										) === " "
									) {
										to++;
									}
									builder.add(
										node.from,
										to,
										Decoration.replace({}),
									);
								} else {
									builder.add(
										node.from,
										node.to,
										Decoration.replace({}),
									);
								}
							}
						}
					},
				});
			}
			return builder.finish();
		}
	}

	// Obsidian-style: hide markers when not on active line
	const hideMarkersPlugin = ViewPlugin.fromClass(HideMarkersPlugin, {
		decorations: (v) => v.decorations,
	});

	$effect(() => {
		if (!editorEl) return;

		let wasExpandedBeforeMousedown = false;

		const startState = EditorState.create({
			doc: untrack(() => content),
			extensions: [
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
							"--tbl-theme-even-row-background":
								"var(--background)",
							"--tbl-theme-odd-row-background":
								"var(--background)",
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
							"--tbl-theme-menu-hover-background":
								"var(--accent)",
							"--tbl-theme-menu-hover-text-color":
								"var(--accent-foreground)",
						}),
						dark: TableTheme.dark.with({
							"--tbl-theme-row-background": "var(--background)",
							"--tbl-theme-header-row-background": "var(--muted)",
							"--tbl-theme-even-row-background":
								"var(--background)",
							"--tbl-theme-odd-row-background":
								"var(--background)",
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
							"--tbl-theme-menu-hover-background":
								"var(--accent)",
							"--tbl-theme-menu-hover-text-color":
								"var(--accent-foreground)",
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
				EditorView.domEventHandlers({
					mousedown: (event, view) => {
						// We still need preventDefault to stop cursor move on collapsed links
						const pos = view.posAtCoords({
							x: event.clientX,
							y: event.clientY,
						});
						if (pos == null) return;

						const node = syntaxTree(view.state).resolveInner(
							pos,
							-1,
						);

						let curr: any = node;
						let isLink = false;
						let isMarkerOrURL = false;
						while (curr && curr.name !== "Document") {
							if (curr.name === "Link") {
								isLink = true;
								break;
							}
							if (
								curr.name === "LinkMark" ||
								curr.name === "URL"
							) {
								isMarkerOrURL = true;
							}
							curr = curr.parent;
						}

						if (isLink && !isMarkerOrURL && !event.altKey) {
							// Check if the link is currently expanded in the DOM
							const target = event.target as HTMLElement;
							const isExpanded =
								target.classList.contains(
									"cm-link-expanded",
								) || target.closest(".cm-link-expanded");

							if (!isExpanded) {
								event.preventDefault();
								event.stopPropagation();
								view.focus();
								return true;
							}
						}
						return false;
					},
					click: (event, view) => {
						const pos = view.posAtCoords({
							x: event.clientX,
							y: event.clientY,
						});
						if (pos == null) return false;

						const node = syntaxTree(view.state).resolveInner(
							pos,
							-1,
						);

						let curr: any = node;
						let isLink = false;
						let isMarkerOrURL = false;
						while (curr && curr.name !== "Document") {
							if (curr.name === "Link") {
								isLink = true;
								break;
							}
							if (
								curr.name === "LinkMark" ||
								curr.name === "URL"
							) {
								isMarkerOrURL = true;
							}
							curr = curr.parent;
						}

						let isLabel = isLink && !isMarkerOrURL && !event.altKey;

						if (!isLabel) {
							const target = event.target as HTMLElement;
							if (
								target.classList.contains("cm-link") ||
								target.closest(".cm-link")
							) {
								isLabel = true;
							}
						}

						if (isLabel) {
							const target = event.target as HTMLElement;
							const isExpanded =
								target.classList.contains(
									"cm-link-expanded",
								) || target.closest(".cm-link-expanded");

							if (!isExpanded) {
								let linkNode: any = node;
								while (
									linkNode &&
									linkNode.name !== "Link" &&
									linkNode.name !== "Document"
								) {
									linkNode = linkNode.parent;
								}

								if (linkNode && linkNode.name === "Link") {
									let url = "";
									const cursor = linkNode.node.cursor();
									if (cursor.firstChild()) {
										do {
											if (cursor.name === "URL") {
												url = view.state.doc.sliceString(
													cursor.from,
													cursor.to,
												);
												break;
											}
										} while (cursor.nextSibling());
									}

									if (url) {
										window.open(
											url,
											"_blank",
											"noopener,noreferrer",
										);
										return true;
									}
								}
							}
						}
						return false;
					},
				}),
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
				EditorView.theme({
					"&": {
						height: "100%",
						fontSize: "1.05rem",
						backgroundColor: "transparent",
					},
					".cm-content": {
						fontFamily: "ui-sans-serif, system-ui, sans-serif",
						padding: "1.5rem",
						color: "var(--foreground)",
						caretColor: "var(--primary)",
						width: "100%",
						maxWidth: "var(--editor-max-width)",
						margin: "0 auto",
					},
					".cm-scroller": {
						lineHeight: "1.6",
						display: "flex",
						flexDirection: "column",
					},
					".cm-gutters": {
						display: "none",
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
				}),
				EditorView.updateListener.of((update) => {
					if (
						update.docChanged &&
						!update.transactions.some((tr) =>
							tr.annotation(syncAnnotation),
						)
					) {
						const newContent = update.state.doc.toString();
						if (newContent !== content) {
							content = newContent;
						}
					}
				}),
			],
		});

		view = new EditorView({
			state: startState,
			parent: editorEl,
		});

		return () => {
			view?.destroy();
			view = undefined;
		};
	});

	// Sync wrap setting
	$effect(() => {
		if (view) {
			view.dispatch({
				effects: wrapCompartment.reconfigure(
					wrap ? EditorView.lineWrapping : [],
				),
			});
		}
	});

	// Sync content from outside (e.g. file open)
	$effect(() => {
		const c = content; // Track content
		untrack(() => {
			if (view) {
				const currentDoc = view.state.doc.toString();
				if (c !== currentDoc) {
					view.dispatch({
						changes: {
							from: 0,
							to: view.state.doc.length,
							insert: c,
						},
						annotations: syncAnnotation.of(true),
					});
				}
			}
		});
	});
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key === "Alt") altPressed = true;
	}}
	onkeyup={(e) => {
		if (e.key === "Alt") altPressed = false;
	}}
	onblur={() => (altPressed = false)}
/>

<div
	bind:this={editorEl}
	class="editor-wrapper {style}"
	class:alt-pressed={altPressed}
	data-testid="editor-input"
></div>

<style>
	.editor-wrapper {
		flex: 1;
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
		background: var(--background);

		/* Editor Width */
		--editor-max-width: 800px;

		/* Font Variables - Match Tailwind 4 font-mono stack */
		--font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
			"Liberation Mono", "Courier New", monospace;

		/* Table Support Variables */
		--tbl-style-font-family: ui-sans-serif, system-ui, sans-serif;
		--tbl-style-font-size: 1.05rem;
		--tbl-theme-row-background: var(--background);
		--tbl-theme-text-color: var(--foreground);
		--tbl-theme-menu-background: var(--background);
		--tbl-theme-menu-text-color: var(--foreground);
		--tbl-theme-border-color: var(--border);
	}

	:global(.cm-fencedCode) {
		position: relative;
	}

	:global(.cm-copy-button) {
		position: absolute;
		right: 1.5rem; /* Match editor padding */
		top: 0.5rem;
		z-index: 10;
		opacity: 0;
		transition: all 0.2s ease;
		background-color: var(--background);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 5px;
		color: var(--muted-foreground);
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
	}

	:global(.cm-fencedCode-top:hover .cm-copy-button),
	:global(.cm-copy-button:hover) {
		opacity: 1;
	}

	:global(.cm-copy-button:hover) {
		background-color: var(--muted);
		color: var(--foreground);
		border-color: var(--muted-foreground);
	}

	:global(.cm-copy-button.copied) {
		color: var(--primary);
		border-color: var(--primary);
		background-color: color-mix(
			in srgb,
			var(--primary) 10%,
			var(--background)
		);
	}

	:global(.cm-editor) {
		height: 100%;
	}

	:global(.cm-content ::selection) {
		background-color: var(--primary);
		color: var(--primary-foreground);
	}

	:global(.cm-content .cm-link) {
		cursor: pointer;
		color: var(--code-operator) !important;
	}

	.alt-pressed :global(.cm-content .cm-link) {
		cursor: text !important;
	}

	:global(.cm-content .cm-link:hover) {
		text-decoration: underline !important;
	}

	/* Disable pointer and hover underline when link is expanded for editing */
	:global(.cm-content .cm-link-expanded .cm-link),
	:global(.cm-content .cm-link.cm-link-expanded) {
		cursor: text !important;
		text-decoration: none !important;
	}

	:global(.cm-cursor) {
		border-left: 2px solid var(--primary) !important;
		margin-left: -1px;
	}

	:global(.md-bullet) {
		color: var(--primary);
		font-weight: bold;
		margin-right: 0.2rem;
	}

	:global(.md-list-number) {
		color: var(--primary);
		font-weight: 500;
	}

	:global(.cm-blockquote) {
		border-left: 3px solid var(--primary);
		padding-left: 1.5rem;
		margin-left: 0.2rem;
		color: var(--muted-foreground);
		font-style: italic;
	}

	:global(.cm-hr-line) {
		line-height: 0 !important;
	}

	:global(.cm-hr-line .cm-widgetBuffer) {
		display: none !important;
	}

	:global(.cm-horizontal-rule-wrapper) {
		width: 100%;
		height: 1.6em; /* This will provide the actual line height */
		display: flex;
		align-items: center;
		justify-content: center;
	}

	:global(.cm-horizontal-rule-inner) {
		border-top: 1px solid var(--border);
		width: 100%;
		height: 0;
	}

	:global(.cm-horizontal-rule-active) {
		color: var(--primary);
		font-weight: bold;
		opacity: 0.5;
	}

	/* Tables */
	:global(.tbl-table) {
		border-radius: 8px;
		border: 1px solid var(--border) !important;
		border-collapse: separate !important;
		border-spacing: 0 !important;
		overflow: hidden;
	}

	:global(.cm-content .cm-tableCell),
	:global(.cm-content .tbl-cell) {
		font-family: var(--font-mono) !important;
		padding: 0 0.5rem;
		background-color: var(--background) !important;
		border-color: var(--border) !important;
	}

	:global(.cm-content .cm-tableHeader),
	:global(.cm-content .tbl-header-cell) {
		font-weight: bold;
		color: var(--primary);
		background-color: var(--muted) !important;
		border-color: var(--border) !important;
	}

	/* Round corner cells specifically to match the table rounding */
	:global(.tbl-table tr:first-child th:first-child) {
		border-top-left-radius: 7px;
	}
	:global(.tbl-table tr:first-child th:last-child) {
		border-top-right-radius: 7px;
	}
	:global(.tbl-table tr:last-child td:first-child) {
		border-bottom-left-radius: 7px;
	}
	:global(.tbl-table tr:last-child td:last-child) {
		border-bottom-right-radius: 7px;
	}

	/* Conditional rounding: remove cell and table corner radius if touching handle is hovered or active */
	/* Only triggers on selection handles (header) or edge addition handles (table), not on insertion lines (border) */

	/* Top-Left Corner: First row/col selection handles inside first cell */
	:global(
			.tbl-table-wrapper:has(
					.tbl-cell[data-row="0"][data-col="0"]
						.tbl-handle[data-type="header"]:hover
				)
				.tbl-table
		),
	:global(
			.tbl-table-wrapper:has(
					.tbl-cell[data-row="0"][data-col="0"]
						.tbl-handle[data-type="header"][data-active="true"]
				)
				.tbl-table
		),
	:global(
			.tbl-table
				tr:first-child
				th:first-child:has(.tbl-handle[data-type="header"]:hover)
		),
	:global(
			.tbl-table
				tr:first-child
				th:first-child:has(
					.tbl-handle[data-type="header"][data-active="true"]
				)
		) {
		border-top-left-radius: 0 !important;
	}

	/* Top-Right Corner: Last col selection handle, right edge handle, or bottom-right corner handle */
	:global(
			.tbl-table-wrapper:has(
					.tbl-table
						tr:first-child
						th:last-child
						.tbl-handle[data-type="header"]:hover
				)
				.tbl-table
		),
	:global(
			.tbl-table-wrapper:has(
					.tbl-table
						tr:first-child
						th:last-child
						.tbl-handle[data-type="header"][data-active="true"]
				)
				.tbl-table
		),
	:global(
			.tbl-table-wrapper:has(.tbl-handle[data-location="right"]:hover)
				.tbl-table
		),
	:global(
			.tbl-table-wrapper:has(
					.tbl-handle[data-location="right"][data-active="true"]
				)
				.tbl-table
		),
	:global(
			.tbl-table-wrapper:has(
					.tbl-handle[data-location="bottom-right"]:hover
				)
				.tbl-table
		),
	:global(
			.tbl-table-wrapper:has(
					.tbl-handle[data-location="bottom-right"][data-active="true"]
				)
				.tbl-table
		),
	:global(
			.tbl-table
				tr:first-child
				th:last-child:has(.tbl-handle[data-type="header"]:hover)
		),
	:global(
			.tbl-table
				tr:first-child
				th:last-child:has(
					.tbl-handle[data-type="header"][data-active="true"]
				)
		),
	:global(
			.tbl-table-wrapper:has(.tbl-handle[data-location="right"]:hover)
				.tbl-table
				tr:first-child
				th:last-child
		),
	:global(
			.tbl-table-wrapper:has(
					.tbl-handle[data-location="right"][data-active="true"]
				)
				.tbl-table
				tr:first-child
				th:last-child
		),
	:global(
			.tbl-table-wrapper:has(
					.tbl-handle[data-location="bottom-right"]:hover
				)
				.tbl-table
				tr:first-child
				th:last-child
		),
	:global(
			.tbl-table-wrapper:has(
					.tbl-handle[data-location="bottom-right"][data-active="true"]
				)
				.tbl-table
				tr:first-child
				th:last-child
		) {
		border-top-right-radius: 0 !important;
	}

	/* Bottom-Left Corner: Last row selection handle, bottom edge handle, or bottom-right corner handle */
	:global(
			.tbl-table-wrapper:has(
					.tbl-table
						tr:last-child
						td:first-child
						.tbl-handle[data-type="header"]:hover
				)
				.tbl-table
		),
	:global(
			.tbl-table-wrapper:has(
					.tbl-table
						tr:last-child
						td:first-child
						.tbl-handle[data-type="header"][data-active="true"]
				)
				.tbl-table
		),
	:global(
			.tbl-table-wrapper:has(.tbl-handle[data-location="bottom"]:hover)
				.tbl-table
		),
	:global(
			.tbl-table-wrapper:has(
					.tbl-handle[data-location="bottom"][data-active="true"]
				)
				.tbl-table
		),
	:global(
			.tbl-table-wrapper:has(
					.tbl-handle[data-location="bottom-right"]:hover
				)
				.tbl-table
		),
	:global(
			.tbl-table-wrapper:has(
					.tbl-handle[data-location="bottom-right"][data-active="true"]
				)
				.tbl-table
		),
	:global(
			.tbl-table
				tr:last-child
				td:first-child:has(.tbl-handle[data-type="header"]:hover)
		),
	:global(
			.tbl-table
				tr:last-child
				td:first-child:has(
					.tbl-handle[data-type="header"][data-active="true"]
				)
		),
	:global(
			.tbl-table-wrapper:has(.tbl-handle[data-location="bottom"]:hover)
				.tbl-table
				tr:last-child
				td:first-child
		),
	:global(
			.tbl-table-wrapper:has(
					.tbl-handle[data-location="bottom"][data-active="true"]
				)
				.tbl-table
				tr:last-child
				td:first-child
		),
	:global(
			.tbl-table-wrapper:has(
					.tbl-handle[data-location="bottom-right"]:hover
				)
				.tbl-table
				tr:last-child
				td:first-child
		),
	:global(
			.tbl-table-wrapper:has(
					.tbl-handle[data-location="bottom-right"][data-active="true"]
				)
				.tbl-table
				tr:last-child
				td:first-child
		) {
		border-bottom-left-radius: 0 !important;
	}

	/* Bottom-Right Corner: Right, Bottom, or Bottom-Right edge handles */
	:global(
			.tbl-table-wrapper:has(.tbl-handle[data-location="right"]:hover)
				.tbl-table
		),
	:global(
			.tbl-table-wrapper:has(.tbl-handle[data-location="bottom"]:hover)
				.tbl-table
		),
	:global(
			.tbl-table-wrapper:has(
					.tbl-handle[data-location="bottom-right"]:hover
				)
				.tbl-table
		),
	:global(
			.tbl-table-wrapper:has(
					.tbl-handle[data-location="right"][data-active="true"]
				)
				.tbl-table
		),
	:global(
			.tbl-table-wrapper:has(
					.tbl-handle[data-location="bottom"][data-active="true"]
				)
				.tbl-table
		),
	:global(
			.tbl-table-wrapper:has(
					.tbl-handle[data-location="bottom-right"][data-active="true"]
				)
				.tbl-table
		),
	:global(
			.tbl-table
				tr:last-child
				td:last-child:has(.tbl-handle[data-type="header"]:hover)
		),
	:global(
			.tbl-table
				tr:last-child
				td:last-child:has(
					.tbl-handle[data-type="header"][data-active="true"]
				)
		),
	:global(
			.tbl-table-wrapper:has(.tbl-handle[data-location="right"]:hover)
				.tbl-table
				tr:last-child
				td:last-child
		),
	:global(
			.tbl-table-wrapper:has(
					.tbl-handle[data-location="right"][data-active="true"]
				)
				.tbl-table
				tr:last-child
				td:last-child
		),
	:global(
			.tbl-table-wrapper:has(.tbl-handle[data-location="bottom"]:hover)
				.tbl-table
				tr:last-child
				td:last-child
		),
	:global(
			.tbl-table-wrapper:has(
					.tbl-handle[data-location="bottom"][data-active="true"]
				)
				.tbl-table
				tr:last-child
				td:last-child
		),
	:global(
			.tbl-table-wrapper:has(
					.tbl-handle[data-location="bottom-right"]:hover
				)
				.tbl-table
				tr:last-child
				td:last-child
		),
	:global(
			.tbl-table-wrapper:has(
					.tbl-handle[data-location="bottom-right"][data-active="true"]
				)
				.tbl-table
				tr:last-child
				td:last-child
		) {
		border-bottom-right-radius: 0 !important;
	}

	/* Table Handles */
	:global(.tbl-handle) {
		color: var(--muted-foreground) !important;
		border-radius: 0 !important;
	}
	:global(.tbl-handle[data-hover]),
	:global(.tbl-handle[data-active]) {
		color: var(--primary) !important;
	}
	:global(.tbl-handle[data-type="border"]) {
		background-color: transparent !important;
	}
	:global(.tbl-handle[data-type="border"][data-hover]),
	:global(.tbl-handle[data-type="border"][data-active]) {
		background-color: var(--primary) !important;
	}

	/* Row Headers (Left) - round outer left corners */
	:global(.tbl-handle[data-type="header"][data-location="row"]) {
		border-top-left-radius: 4px !important;
		border-bottom-left-radius: 4px !important;
	}

	/* Column Headers (Top) - round outer top corners */
	:global(.tbl-handle[data-type="header"][data-location="col"]) {
		border-top-left-radius: 4px !important;
		border-top-right-radius: 4px !important;
	}

	:global(.tbl-handle[data-type="header"]:hover),
	:global(.tbl-handle[data-type="header"][data-active]) {
		background-color: var(--accent) !important;
		color: var(--primary) !important;
	}
	:global(.tbl-handle[data-type="header"][data-active]) {
		background-color: var(--primary) !important;
		color: var(--primary-foreground) !important;
		border-color: var(--primary) !important;
	}

	:global(.tbl-handle[data-type="header"][data-active] .tbl-handle-grip) {
		color: var(--primary-foreground) !important;
	}

	/* Table Edge Handles (Right/Bottom) */
	:global(.tbl-handle[data-type="table"]) {
		background-color: var(--muted) !important;
		color: var(--muted-foreground) !important;
		border: 1px solid var(--border) !important;
	}

	/* Right Edge Handle - round outer right corners */
	:global(.tbl-handle[data-type="table"][data-location="right"]) {
		border-top-right-radius: 4px !important;
		border-bottom-right-radius: 4px !important;
		border-left: none !important;
	}

	/* Bottom Edge Handle - round outer bottom corners */
	:global(.tbl-handle[data-type="table"][data-location="bottom"]) {
		border-bottom-left-radius: 4px !important;
		border-bottom-right-radius: 4px !important;
		border-top: none !important;
	}

	/* Bottom-Right Corner Handle - round only the very corner */
	:global(.tbl-handle[data-type="table"][data-location="bottom-right"]) {
		border-bottom-right-radius: 4px !important;
	}

	:global(.tbl-handle[data-type="table"][data-hover]),
	:global(.tbl-handle[data-type="table"][data-active]) {
		background-color: var(--accent) !important;
		color: var(--primary) !important;
		border-color: var(--border) !important;
	}
	:global(.tbl-handle[data-type="table"][data-location="right"]) {
		border-left: none !important;
	}
	:global(.tbl-handle[data-type="table"][data-location="bottom"]) {
		border-top: none !important;
	}
	:global(.tbl-handle-grip) {
		color: var(--primary) !important;
	}
	:global(.tbl-handle-grip circle) {
		fill: currentColor !important;
	}

	/* Table Menus */
	:global(.tbl-menu) {
		background-color: var(--background) !important;
		border: 1px solid var(--border) !important;
		color: var(--foreground) !important;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2) !important;
		border-radius: 8px !important;
		padding: 4px 0 !important;
	}

	:global(.tbl-menu-item) {
		color: var(--foreground) !important;
		padding: 6px 12px !important;
		margin: 0 4px !important;
		border-radius: 4px !important;
	}

	:global(.tbl-menu-item:hover),
	:global(.tbl-menu-item:active) {
		background-color: var(--accent) !important;
		color: var(--accent-foreground) !important;
	}

	:global(.tbl-menu-item::after) {
		display: none !important; /* Remove library's default hover overlay to use our own */
	}

	:global(.tbl-menu-separator) {
		background-color: var(--border) !important;
		margin: 4px 0 !important;
	}

	:global(.tbl-menu-item-icon) {
		color: var(--primary) !important;
	}

	/* Table Cell Selection */
	:global(.tbl-cell-editor .cm-content ::selection),
	:global(.tbl-cell[data-selected="true"]),
	:global(.tbl-cell[data-selected="true"]::after) {
		background-color: color-mix(
			in srgb,
			var(--primary),
			transparent 80%
		) !important;
	}

	:global(.tbl-cell-editor .cm-content ::selection) {
		background-color: var(--primary) !important;
		color: var(--primary-foreground) !important;
	}

	/* Force outline/focus colors */
	:global(.tbl-cell[data-outline*="top"]::after),
	:global(.tbl-cell[data-outline*="right"]::after),
	:global(.tbl-cell[data-outline*="bottom"]::after),
	:global(.tbl-cell[data-outline*="left"]::after) {
		border-color: var(--primary) !important;
	}

	:global(.cm-content .cm-tableRow) {
		border-bottom: 1px solid var(--border);
	}

	:global(.cm-line.cm-fencedCode) {
		position: relative;
		background-color: var(--muted);
		font-family: var(--font-mono) !important;
		padding-left: 2.2rem !important;
		border-left: 1px solid var(--border);
		border-right: 1px solid var(--border);
	}

	:global(.cm-line.cm-fencedCode.cm-activeLine) {
		background-color: color-mix(
			in srgb,
			var(--primary) 8%,
			var(--muted)
		) !important;
	}

	:global(.cm-fencedCode *) {
		font-family: var(--font-mono) !important;
	}

	:global(.cm-line.cm-fencedCode-top) {
		border-top: 1px solid var(--border);
		border-top-left-radius: 8px;
		border-top-right-radius: 8px;
		padding-top: 0.5rem !important;
		padding-bottom: 0.5rem !important;
		counter-reset: code-line;
	}

	:global(.cm-line.cm-fencedCode-line) {
		counter-increment: code-line;
	}

	:global(.cm-line.cm-fencedCode-line::before) {
		content: counter(code-line);
		position: absolute;
		left: 0;
		top: 50%;
		transform: translateY(-50%);
		display: flex;
		align-items: center;
		justify-content: flex-end;
		width: 1.5rem;
		font-size: 0.7rem;
		color: var(--muted-foreground);
		opacity: 0.4;
		font-family: var(--font-mono);
		user-select: none;
	}

	:global(.cm-line.cm-fencedCode-bottom) {
		border-bottom: 1px solid var(--border);
		border-bottom-left-radius: 8px;
		border-bottom-right-radius: 8px;
		padding-top: 0 !important;
	}

	/* Show visible markers in focused editor on the active line slightly transparent */
	:global(.cm-activeLine .md-marker) {
		opacity: 0.5 !important;
	}

	/* Keep Setext header lines always slightly faded */
	:global(.md-faded) {
		opacity: 0.5 !important;
	}

	:global(.cm-language-label) {
		position: absolute;
		left: 0.6rem;
		top: 50%;
		transform: translateY(-50%);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		line-height: 1;
		font-family: var(--font-mono);
		font-size: 0.7rem;
		color: var(--muted-foreground);
		background-color: color-mix(
			in srgb,
			var(--muted-foreground) 10%,
			transparent
		);
		padding: 0.15rem 0.4rem;
		border-radius: 4px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		font-weight: 700;
		user-select: none;
		pointer-events: none;
	}
	/* Hide markers in static table cells */
	:global(.tbl-cell-view .md-marker) {
		display: none !important;
	}
</style>
