import {
	Decoration,
	ViewPlugin,
	ViewUpdate,
	EditorView,
	WidgetType,
} from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { sanitizeHtml, isSafeStyle } from "@np/core/transformer";

export class HTMLBlockWidget extends WidgetType {
	constructor(
		readonly rawHtml: string,
		readonly from: number,
		readonly to: number,
	) {
		super();
	}

	eq(other: HTMLBlockWidget) {
		return other.rawHtml === this.rawHtml;
	}

	toDOM(view: EditorView) {
		const container = document.createElement("div");
		container.className = "cm-html-block-widget";
		container.innerHTML = sanitizeHtml(this.rawHtml);

		container.addEventListener("click", (e) => {
			const target = e.target as HTMLElement | null;
			// Allow normal interaction for clickable child elements like summary/links/buttons/inputs
			if (
				target?.closest("summary") ||
				target?.closest("a") ||
				target?.closest("button") ||
				target?.closest("input")
			) {
				return;
			}
			e.preventDefault();
			view.focus();
			let anchor = this.from;
			let head = this.to;
			try {
				const pos = view.posAtDOM(container);
				anchor = pos;
				head = pos + this.rawHtml.length;
			} catch {
				// Fallback to static offsets if posAtDOM is unavailable
			}
			view.dispatch({
				selection: { anchor, head },
				scrollIntoView: true,
			});
		});

		return container;
	}
}

export class HTMLBreakWidget extends WidgetType {
	toDOM() {
		return document.createElement("br");
	}
}

const PAIRED_BLOCK_TAG_NAMES = new Set([
	"div",
	"table",
	"details",
	"section",
	"article",
	"aside",
	"nav",
	"header",
	"footer",
	"figure",
	"figcaption",
	"blockquote",
	"form",
	"fieldset",
	"iframe",
	"audio",
	"video",
	"style",
	"canvas",
	"svg",
]);

interface PairedBlock {
	from: number;
	to: number;
	rawHtml: string;
}

function findPairedHtmlBlocks(
	docText: string,
	codeRanges: { from: number; to: number }[],
): PairedBlock[] {
	const blocks: PairedBlock[] = [];
	const isCode = (pos: number) =>
		codeRanges.some((r) => pos >= r.from && pos < r.to);

	const openTagRegex = /<([a-zA-Z0-9]+)(\s[^>]*)?>/g;
	let match: RegExpExecArray | null;

	while ((match = openTagRegex.exec(docText)) !== null) {
		const tagName = match[1].toLowerCase();
		if (!PAIRED_BLOCK_TAG_NAMES.has(tagName)) continue;

		const startPos = match.index;
		if (isCode(startPos)) continue;

		// Self-closing tags (e.g. <iframe ... />)
		if (match[0].endsWith("/>")) {
			const endPos = startPos + match[0].length;
			blocks.push({
				from: startPos,
				to: endPos,
				rawHtml: match[0],
			});
			continue;
		}

		// Track nesting depth for matching closing tags of the same name
		let depth = 1;
		const tagSearchRegex = new RegExp(
			`<(?:${tagName}(\\s[^>]*)?|\\/${tagName}\\s*)>`,
			"gi",
		);
		tagSearchRegex.lastIndex = startPos + match[0].length;

		let subMatch: RegExpExecArray | null;
		let matchedEnd = -1;

		while ((subMatch = tagSearchRegex.exec(docText)) !== null) {
			const subPos = subMatch.index;
			if (isCode(subPos)) continue;

			if (subMatch[0].startsWith("</")) {
				depth--;
				if (depth === 0) {
					matchedEnd = subPos + subMatch[0].length;
					break;
				}
			} else if (!subMatch[0].endsWith("/>")) {
				depth++;
			}
		}

		if (matchedEnd !== -1) {
			blocks.push({
				from: startPos,
				to: matchedEnd,
				rawHtml: docText.slice(startPos, matchedEnd),
			});
			openTagRegex.lastIndex = matchedEnd;
		}
	}

	return blocks;
}

interface InlineTagRule {
	tag: string;
	className?: string;
	extractStyle?: boolean;
	asBlockWidget?: boolean;
}

const INLINE_TAG_RULES: InlineTagRule[] = [
	{ tag: "u", className: "cm-html-u" },
	{ tag: "sub", className: "cm-html-sub" },
	{ tag: "sup", className: "cm-html-sup" },
	{ tag: "s", className: "cm-html-s" },
	{ tag: "del", className: "cm-html-s" },
	{ tag: "strike", className: "cm-html-s" },
	{ tag: "ins", className: "cm-html-ins" },
	{ tag: "mark", className: "cm-html-mark" },
	{ tag: "kbd", className: "cm-html-kbd" },
	{ tag: "small", className: "cm-html-small" },
	{ tag: "b", className: "cm-html-strong" },
	{ tag: "strong", className: "cm-html-strong" },
	{ tag: "i", className: "cm-html-em" },
	{ tag: "em", className: "cm-html-em" },
	{ tag: "span", extractStyle: true },
	{ tag: "p", extractStyle: true },
];

interface DecoItem {
	from: number;
	to: number;
	deco: Decoration;
	isLine?: boolean;
	isReplace?: boolean;
}

class HTMLPassthroughPlugin {
	decorations: DecorationSet;
	codeRanges: { from: number; to: number }[] = [];
	pairedBlocks: PairedBlock[] = [];

	constructor(view: EditorView) {
		this.recomputeDoc(view);
		this.decorations = this.getDecorations(view);
	}

	recomputeDoc(view: EditorView) {
		const doc = view.state.doc;
		const fullDocText = doc.toString();
		const codeRanges: { from: number; to: number }[] = [];

		// 1. AST traversal for Code blocks
		syntaxTree(view.state).iterate({
			from: 0,
			to: doc.length,
			enter: (node) => {
				const type = node.name;
				if (
					type === "CodeBlock" ||
					type === "FencedCode" ||
					type === "InlineCode" ||
					type === "CodeText"
				) {
					codeRanges.push({ from: node.from, to: node.to });
				}
			},
		});

		this.codeRanges = codeRanges;
		this.pairedBlocks = findPairedHtmlBlocks(fullDocText, codeRanges);
	}

	update(update: ViewUpdate) {
		if (update.docChanged) {
			this.recomputeDoc(update.view);
			this.decorations = this.getDecorations(update.view);
		} else if (
			update.selectionSet ||
			update.viewportChanged ||
			update.focusChanged
		) {
			this.decorations = this.getDecorations(update.view);
		}
	}

	getDecorations(view: EditorView) {
		const doc = view.state.doc;
		const selection = view.state.selection.main;
		const hasFocus = view.hasFocus;
		const items: DecoItem[] = [];

		const excludedRanges: { from: number; to: number }[] = [
			...this.codeRanges,
			...this.pairedBlocks,
		];

		const isExcluded = (start: number, end: number) => {
			return excludedRanges.some(
				(range) => start < range.to && end > range.from,
			);
		};

		// 2. Scan paired HTML blocks (div, table, details, iframe, etc. including across blank lines)
		for (const block of this.pairedBlocks) {
			const isFocused =
				hasFocus &&
				selection.from <= block.to &&
				selection.to >= block.from;

			if (!isFocused) {
				const startLine = doc.lineAt(block.from);
				const endLine = doc.lineAt(block.to);

				if (startLine.number === endLine.number) {
					items.push({
						from: block.from,
						to: block.to,
						deco: Decoration.replace({
							widget: new HTMLBlockWidget(
								block.rawHtml,
								block.from,
								block.to,
							),
						}),
						isReplace: true,
					});
				} else {
					items.push({
						from: block.from,
						to: startLine.to,
						deco: Decoration.replace({
							widget: new HTMLBlockWidget(
								block.rawHtml,
								block.from,
								block.to,
							),
						}),
						isReplace: true,
					});

					for (
						let l = startLine.number + 1;
						l <= endLine.number;
						l++
					) {
						const line = doc.line(l);
						const lineFrom = Math.max(block.from, line.from);
						const lineTo = Math.min(block.to, line.to);

						items.push({
							from: line.from,
							to: line.from,
							deco: Decoration.line({
								class: "cm-html-block-hidden-line",
							}),
							isLine: true,
						});

						if (lineFrom < lineTo) {
							items.push({
								from: lineFrom,
								to: lineTo,
								deco: Decoration.replace({}),
								isReplace: true,
							});
						}
					}
				}
			}
		}

		for (let { from, to } of view.visibleRanges) {
			// 3. AST traversal for remaining fallback HTML blocks and comments
			syntaxTree(view.state).iterate({
				from,
				to,
				enter: (node) => {
					const type = node.name;

					if (isExcluded(node.from, node.to)) {
						return;
					}

					if (type === "HTMLBlock") {
						excludedRanges.push({ from: node.from, to: node.to });
						const isFocused =
							hasFocus &&
							selection.from <= node.to &&
							selection.to >= node.from;

						if (!isFocused) {
							const rawHtml = doc.sliceString(node.from, node.to);
							const startLine = doc.lineAt(node.from);
							const endLine = doc.lineAt(node.to);

							if (startLine.number === endLine.number) {
								items.push({
									from: node.from,
									to: node.to,
									deco: Decoration.replace({
										widget: new HTMLBlockWidget(
											rawHtml,
											node.from,
											node.to,
										),
									}),
									isReplace: true,
								});
							} else {
								items.push({
									from: node.from,
									to: startLine.to,
									deco: Decoration.replace({
										widget: new HTMLBlockWidget(
											rawHtml,
											node.from,
											node.to,
										),
									}),
									isReplace: true,
								});

								for (
									let l = startLine.number + 1;
									l <= endLine.number;
									l++
								) {
									const line = doc.line(l);
									const lineFrom = Math.max(node.from, line.from);
									const lineTo = Math.min(node.to, line.to);

									items.push({
										from: line.from,
										to: line.from,
										deco: Decoration.line({
											class: "cm-html-block-hidden-line",
										}),
										isLine: true,
									});

									if (lineFrom < lineTo) {
										items.push({
											from: lineFrom,
											to: lineTo,
											deco: Decoration.replace({}),
											isReplace: true,
										});
									}
								}
							}
						}
						return false;
					}

					if (type === "CommentBlock" || type === "Comment") {
						excludedRanges.push({ from: node.from, to: node.to });
						const isFocused =
							hasFocus &&
							selection.from <= node.to &&
							selection.to >= node.from;

						if (!isFocused) {
							const startLine = doc.lineAt(node.from);
							const endLine = doc.lineAt(node.to);

							if (startLine.number === endLine.number) {
								items.push({
									from: node.from,
									to: node.to,
									deco: Decoration.replace({}),
									isReplace: true,
								});
							} else {
								for (
									let l = startLine.number;
									l <= endLine.number;
									l++
								) {
									const line = doc.line(l);
									const lineFrom = Math.max(node.from, line.from);
									const lineTo = Math.min(node.to, line.to);
									if (lineFrom < lineTo) {
										items.push({
											from: lineFrom,
											to: lineTo,
											deco: Decoration.replace({}),
											isReplace: true,
										});
									}
								}
							}
						}
						return false;
					}
				},
			});

			// 4. Scan text for inline HTML tags in the visible range
			const rangeText = doc.sliceString(from, to);

			// Match self-closing <br> tags: <br>, <br/>, <br />
			const brRegex = /<br\s*\/?>/gi;
			let brMatch: RegExpExecArray | null;
			while ((brMatch = brRegex.exec(rangeText)) !== null) {
				const tagFrom = from + brMatch.index;
				const tagTo = tagFrom + brMatch[0].length;

				if (isExcluded(tagFrom, tagTo)) {
					continue;
				}

				// Never replace across line breaks
				if (doc.lineAt(tagFrom).number !== doc.lineAt(tagTo).number) {
					continue;
				}

				const isFocused =
					hasFocus &&
					selection.from <= tagTo &&
					selection.to >= tagFrom;

				if (!isFocused) {
					items.push({
						from: tagFrom,
						to: tagTo,
						deco: Decoration.replace({
							widget: new HTMLBreakWidget(),
						}),
						isReplace: true,
					});
				}
			}

			// Match inline tag pairs
			for (const rule of INLINE_TAG_RULES) {
				const tagRegex = new RegExp(
					`<${rule.tag}(\\s+[^>]*)?>([\\s\\S]*?)<\\/${rule.tag}>`,
					"gi",
				);
				let match: RegExpExecArray | null;
				while ((match = tagRegex.exec(rangeText)) !== null) {
					const openTagStr = match[0].slice(
						0,
						match[0].indexOf(">") + 1,
					);
					const rawAttrs = match[1] || "";
					const innerContent = match[2];
					const closeTagStr = `</${rule.tag}>`;

					const wholeFrom = from + match.index;
					const openTagTo = wholeFrom + openTagStr.length;
					const contentTo = openTagTo + innerContent.length;
					const wholeTo = contentTo + closeTagStr.length;

					if (isExcluded(wholeFrom, wholeTo)) {
						continue;
					}

					// Do not hide empty inline marks so user can place cursor and type
					if (innerContent.length === 0) {
						continue;
					}

					const isTagFocused =
						hasFocus &&
						selection.from <= wholeTo &&
						selection.to >= wholeFrom;

					let decoMark: Decoration | null = null;
					let markClass = rule.className;
					let markStyle: string | undefined;

					if (rawAttrs) {
						const classMatch =
							/class=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(
								rawAttrs,
							);
						const classVal =
							classMatch?.[1] ??
							classMatch?.[2] ??
							classMatch?.[3];
						if (classVal) {
							markClass = classVal;
						}

						if (rule.extractStyle) {
							const styleMatch =
								/style=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(
									rawAttrs,
								);
							const styleVal =
								styleMatch?.[1] ??
								styleMatch?.[2] ??
								styleMatch?.[3];
							if (styleVal && isSafeStyle(styleVal)) {
								markStyle = styleVal;
							}
						}
					}

					if (markClass || markStyle) {
						decoMark = Decoration.mark({
							class: markClass,
							attributes: markStyle
								? { style: markStyle }
								: undefined,
						});
					}

					// Hide opening tag (only if within a single line)
					if (
						!isTagFocused &&
						doc.lineAt(wholeFrom).number ===
							doc.lineAt(openTagTo).number
					) {
						items.push({
							from: wholeFrom,
							to: openTagTo,
							deco: Decoration.replace({}),
							isReplace: true,
						});
					}

					// Apply mark to content
					if (decoMark && contentTo > openTagTo) {
						items.push({
							from: openTagTo,
							to: contentTo,
							deco: decoMark,
							isReplace: false,
						});
					}

					// Hide closing tag (only if within a single line)
					if (
						!isTagFocused &&
						doc.lineAt(contentTo).number ===
							doc.lineAt(wholeTo).number
					) {
						items.push({
							from: contentTo,
							to: wholeTo,
							deco: Decoration.replace({}),
							isReplace: true,
						});
					}
				}
			}
		}

		// Sort decorations strictly: from ascending, line decos before point decos, then to ascending
		items.sort((a, b) => {
			if (a.from !== b.from) return a.from - b.from;
			if (a.isLine && !b.isLine) return -1;
			if (!a.isLine && b.isLine) return 1;
			return a.to - b.to;
		});

		// Build RangeSet avoiding overlapping replacement decorations
		const builder = new RangeSetBuilder<Decoration>();
		let lastReplaceEnd = -1;

		for (const item of items) {
			if (item.isLine) {
				builder.add(item.from, item.from, item.deco);
			} else if (item.isReplace) {
				if (item.from < lastReplaceEnd) {
					continue; // Overlaps an existing replacement
				}
				builder.add(item.from, item.to, item.deco);
				lastReplaceEnd = item.to;
			} else {
				// Mark decoration
				if (item.from >= item.to) continue;
				if (item.from < lastReplaceEnd) continue;
				builder.add(item.from, item.to, item.deco);
			}
		}

		return builder.finish();
	}
}

export const htmlPassthroughPlugin = ViewPlugin.fromClass(
	HTMLPassthroughPlugin,
	{
		decorations: (v) => v.decorations,
	},
);
