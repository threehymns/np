<script lang="ts">
	import { XIcon, ColumnsIcon, RowsIcon, InfoIcon, CaretRightIcon, CaretDownIcon, CaretUpDownIcon, ArrowUpIcon, ArrowDownIcon } from 'phosphor-svelte';
	import type { GitChange, FileDiffDetail, HunkCoordinates } from '@np/core';
	import { fileDiffFromChange, diffCacheKey, getUnifiedHunks, DEFAULT_DIFF_CONFIG } from '@np/core';
	import { useAppState, type AppState } from '@np/core/state.svelte';
	import { Checkbox } from './ui/checkbox';
	import { EditorView, lineNumbers, keymap, WidgetType, Decoration, type DecorationSet, ViewPlugin, ViewUpdate } from "@codemirror/view";
	import { EditorState, Compartment, Text, RangeSetBuilder } from "@codemirror/state";
	import { syntaxHighlighting, foldedRanges } from "@codemirror/language";
	import { MergeView, unifiedMergeView, Chunk, getChunks } from "@codemirror/merge";
	import { getLanguageExtensions, editorTheme, diffTheme, markdownHighlight, LanguageSupport } from '../editor/index';
	import Button from './ui/button/button.svelte';

	const SVG_PLUS = '<svg xmlns="http://www.w3.org/2000/svg" role="img" width="10" height="10" fill="currentColor" viewBox="0 0 256 256"><rect width="256" height="256" fill="none" /><path d="M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z"/></svg>';
	const SVG_MINUS = '<svg xmlns="http://www.w3.org/2000/svg" role="img" width="10" height="10" fill="currentColor" viewBox="0 0 256 256"><rect width="256" height="256" fill="none" /><path d="M224,128a8,8,0,0,1-8,8H40a8,8,0,0,1,0-16H216A8,8,0,0,1,224,128Z"/></svg>';
	const SVG_TRASH = '<svg xmlns="http://www.w3.org/2000/svg" role="img" width="10" height="10" fill="currentColor" viewBox="0 0 256 256"><rect width="256" height="256" fill="none" /><path d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z"/></svg>';
	const SVG_UNDO = '<svg xmlns="http://www.w3.org/2000/svg" role="img" width="10" height="10" fill="currentColor" viewBox="0 0 256 256"><rect width="256" height="256" fill="none" /><path d="M224,128a96,96,0,0,1-94.71,96H128A95.38,95.38,0,0,1,62.1,197.8a8,8,0,0,1,11-11.63A80,80,0,1,0,71.43,71.39a3.07,3.07,0,0,1-.26.25L44.59,96H72a8,8,0,0,1,0,16H24a8,8,0,0,1-8-8V56a8,8,0,0,1,16,0V85.8L60.25,60A96,96,0,0,1,224,128Z"/></svg>';

	class HunkWidget extends WidgetType {
		hunkIndex: number;
		hunkRange: HunkCoordinates;
		staged: boolean;
		change: GitChange;
		appState: AppState;

		constructor(
			hunkIndex: number,
			hunkRange: HunkCoordinates,
			staged: boolean,
			change: GitChange,
			appState: AppState
		) {
			super();
			this.hunkIndex = hunkIndex;
			this.hunkRange = hunkRange;
			this.staged = staged;
			this.change = change;
			this.appState = appState;
		}

		eq(other: HunkWidget): boolean {
			return (
				this.hunkIndex === other.hunkIndex &&
				this.staged === other.staged &&
				this.change === other.change &&
				this.hunkRange.fromA === other.hunkRange.fromA &&
				this.hunkRange.toA === other.hunkRange.toA &&
				this.hunkRange.fromB === other.hunkRange.fromB &&
				this.hunkRange.toB === other.hunkRange.toB
			);
		}

		toDOM(): HTMLElement {
			const wrap = document.createElement('div');
			wrap.className = 'cm-floating-hunk-control inline-flex items-center gap-1 bg-popover/95 text-popover-foreground border border-border/80 rounded-md px-1.5 py-0.5 text-[10px] font-mono shadow-sm z-20 opacity-90 hover:opacity-100 transition-opacity select-none';
			wrap.style.cssText = 'float: right; margin-top: -2px; margin-bottom: -2px; position: relative; z-index: 20;';

			const preventEvent = (e: Event) => {
				e.stopPropagation();
				e.preventDefault();
			};
			wrap.addEventListener('mousedown', preventEvent);
			wrap.addEventListener('pointerdown', preventEvent);
			wrap.addEventListener('mouseup', preventEvent);
			wrap.addEventListener('click', preventEvent);

			const label = document.createElement('span');
			label.className = 'font-bold text-[9px] opacity-70 mr-0.5';
			label.textContent = `#${this.hunkIndex + 1}`;
			wrap.appendChild(label);

			if (this.staged) {
				const unstageBtn = document.createElement('button');
				unstageBtn.type = 'button';
				unstageBtn.className = 'p-0.5 hover:bg-muted rounded text-muted-foreground hover:text-foreground cursor-pointer flex items-center justify-center';
				unstageBtn.title = `Unstage Hunk #${this.hunkIndex + 1}`;
				unstageBtn.setAttribute('aria-label', `Unstage Hunk #${this.hunkIndex + 1}`);
				unstageBtn.innerHTML = SVG_MINUS;
				unstageBtn.onclick = (e) => {
					e.stopPropagation();
					e.preventDefault();
					this.appState.commands.execute('git.unstageHunk', this.change, this.hunkRange);
				};
				wrap.appendChild(unstageBtn);

				const discardBtn = document.createElement('button');
				discardBtn.type = 'button';
				discardBtn.className = 'p-0.5 hover:bg-muted rounded text-muted-foreground hover:text-destructive cursor-pointer flex items-center justify-center';
				discardBtn.title = `Discard Hunk #${this.hunkIndex + 1}`;
				discardBtn.setAttribute('aria-label', `Discard Hunk #${this.hunkIndex + 1}`);
				discardBtn.innerHTML = SVG_TRASH;
				discardBtn.onclick = (e) => {
					e.stopPropagation();
					e.preventDefault();
					this.appState.commands.execute('git.discardHunk', this.change, this.hunkRange);
				};
				wrap.appendChild(discardBtn);
			} else {
				const stageBtn = document.createElement('button');
				stageBtn.type = 'button';
				stageBtn.className = 'p-0.5 hover:bg-muted rounded text-muted-foreground hover:text-foreground cursor-pointer flex items-center justify-center';
				stageBtn.title = `Stage Hunk #${this.hunkIndex + 1}`;
				stageBtn.setAttribute('aria-label', `Stage Hunk #${this.hunkIndex + 1}`);
				stageBtn.innerHTML = SVG_PLUS;
				stageBtn.onclick = (e) => {
					e.stopPropagation();
					e.preventDefault();
					this.appState.commands.execute('git.stageHunk', this.change, this.hunkRange);
				};
				wrap.appendChild(stageBtn);

				const discardBtn = document.createElement('button');
				discardBtn.type = 'button';
				discardBtn.className = 'p-0.5 hover:bg-muted rounded text-muted-foreground hover:text-destructive cursor-pointer flex items-center justify-center';
				discardBtn.title = `Discard Hunk #${this.hunkIndex + 1}`;
				discardBtn.setAttribute('aria-label', `Discard Hunk #${this.hunkIndex + 1}`);
				discardBtn.innerHTML = SVG_UNDO;
				discardBtn.onclick = (e) => {
					e.stopPropagation();
					e.preventDefault();
					this.appState.commands.execute('git.discardHunk', this.change, this.hunkRange);
				};
				wrap.appendChild(discardBtn);
			}

			return wrap;
		}

		ignoreEvent() {
			return true;
		}
	}

	function createHunkWidgetExtension(
		change: GitChange,
		state: AppState,
		precomputedHunks?: HunkCoordinates[],
		precomputedUnstagedChunks?: readonly Chunk[]
	) {
		return ViewPlugin.fromClass(
			class {
				decorations: DecorationSet;
				cachedHunks: HunkCoordinates[] = [];
				cachedUnstagedChunks: readonly Chunk[] = [];
				cachedModText: Text = Text.empty;
				cachedOrigContent: string = '';
				cachedStagedContent: string = '';

				constructor(view: EditorView) {
					const origContent = change.originalContent || '';
					const modText = view.state.doc;
					const stagedContent = change.stagedContent ?? (change.staged ? modText.toString() : origContent);

					if (precomputedHunks && precomputedUnstagedChunks && modText.toString() === (change.modifiedContent || '')) {
						this.cachedHunks = precomputedHunks;
						this.cachedUnstagedChunks = precomputedUnstagedChunks;
						this.cachedModText = modText;
						this.cachedOrigContent = origContent;
						this.cachedStagedContent = stagedContent;
					} else {
						this.computeDiff(view);
					}
					this.decorations = this.buildDecorations(view);
				}

				computeDiff(view: EditorView) {
					const origContent = change.originalContent || '';
					const modText = view.state.doc;
					const stagedContent = change.stagedContent ?? (change.staged ? modText.toString() : origContent);

					const origText = Text.of(origContent.split(/\r?\n/));
					const stagedText = Text.of(stagedContent.split(/\r?\n/));

					this.cachedHunks = getUnifiedHunks(origText, modText, DEFAULT_DIFF_CONFIG);
					this.cachedUnstagedChunks = Chunk.build(stagedText, modText, DEFAULT_DIFF_CONFIG);
					this.cachedModText = modText;
					this.cachedOrigContent = origContent;
					this.cachedStagedContent = stagedContent;
				}

				update(update: ViewUpdate) {
					if (update.docChanged) {
						this.computeDiff(update.view);
						this.decorations = this.buildDecorations(update.view);
					} else if (update.viewportChanged) {
						this.decorations = this.buildDecorations(update.view);
					}
				}

				buildDecorations(view: EditorView): DecorationSet {
					const builder = new RangeSetBuilder<Decoration>();
					const modText = this.cachedModText;

					this.cachedHunks.forEach((hunk, hunkIdx) => {
						let isHunkStaged = change.staged;
						if (change.stagedContent !== undefined || (!change.staged && this.cachedOrigContent !== this.cachedStagedContent)) {
							const lineStartB = modText.lineAt(Math.min(hunk.fromB, modText.length)).number;
							const lineEndB = modText.lineAt(Math.min(hunk.toB, modText.length)).number;

							const overlapsUnstaged = this.cachedUnstagedChunks.some(uc => {
								const ucStartB = modText.lineAt(Math.min(uc.fromB, modText.length)).number;
								const ucEndB = modText.lineAt(Math.min(uc.toB, modText.length)).number;
								if (hunk.fromB === hunk.toB && uc.fromB === uc.toB) {
									return Math.abs(uc.fromB - hunk.fromB) <= 1 || (lineStartB === ucStartB);
								}
								return (lineStartB <= ucEndB && lineEndB >= ucStartB);
							});

							isHunkStaged = !overlapsUnstaged;
						}

						const pos = Math.min(hunk.fromB, view.state.doc.length);
						const line = view.state.doc.lineAt(pos);
						const widget = Decoration.widget({
							widget: new HunkWidget(hunkIdx, hunk, isHunkStaged, change, state),
							side: 1
						});
						builder.add(line.from, line.from, widget);
					});

					return builder.finish();
				}
			},
			{
				decorations: (v) => v.decorations
			}
		);
	}

	// Map to track active EditorView or MergeView per filepath
	let editorViews = new Map<string, { inline?: EditorView; split?: MergeView }>();
	let editorResolvers = new Map<string, Array<(views: { inline?: EditorView; split?: MergeView }) => void>>();

	function makeGutterClickHandler(getView: () => EditorView | undefined, getFilepath: () => string) {
		return (event: MouseEvent) => {
			const target = event.target as HTMLElement;
			const gutterElement = target.closest('.cm-gutterElement');
			if (gutterElement && gutterElement.closest('.cm-lineNumbers')) {
				const view = getView();
				if (view) {
					const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
					if (pos !== null) {
						const lineNum = view.state.doc.lineAt(pos).number;
						openFileInRegularTab(getFilepath(), lineNum);
					}
				}
			}
		};
	}

	const DIFF_COLLAPSE_CONFIG = { margin: 3, minSize: 4 } as const;

	function getBufferBoundaries(state: EditorState): { firstLine: number; lastLine: number } {
		const doc = state.doc;
		const chunkInfo = getChunks(state);
		if (!chunkInfo || chunkInfo.chunks.length === 0) {
			return { firstLine: 1, lastLine: doc.lines };
		}

		const { chunks, side } = chunkInfo;
		const isA = side === 'a';

		// Calculate top boundary (first visible line considering collapsed unchanged lines)
		let firstLine = 1;
		const firstChunk = chunks[0];
		const firstChunkFrom = isA ? firstChunk.fromA : firstChunk.fromB;
		const firstChunkLine = doc.lineAt(Math.min(firstChunkFrom, doc.length)).number;
		const topCollapseTo = firstChunkLine - 1 - DIFF_COLLAPSE_CONFIG.margin;
		if (topCollapseTo >= DIFF_COLLAPSE_CONFIG.minSize) {
			firstLine = topCollapseTo + 1;
		}

		// Calculate bottom boundary (last visible line considering collapsed unchanged lines)
		let lastLine = doc.lines;
		const lastChunk = chunks[chunks.length - 1];
		const lastChunkTo = Math.min(doc.length, isA ? lastChunk.toA : lastChunk.toB);
		const lastChunkLine = doc.lineAt(lastChunkTo).number;
		const bottomCollapseFrom = lastChunkLine + DIFF_COLLAPSE_CONFIG.margin;
		const bottomCollapsedLines = doc.lines - bottomCollapseFrom + 1;
		if (bottomCollapsedLines >= DIFF_COLLAPSE_CONFIG.minSize) {
			lastLine = bottomCollapseFrom - 1;
		}

		return { firstLine, lastLine };
	}

	function isAtBufferBoundary(view: EditorView, direction: 'down' | 'up'): boolean {
		const sel = view.state.selection.main;
		const doc = view.state.doc;
		const curLine = doc.lineAt(sel.head).number;
		const { firstLine, lastLine } = getBufferBoundaries(view.state);
		return direction === 'up' ? curLine <= firstLine : curLine >= lastLine;
	}

	async function getOrWaitEditor(filepath: string, mode: 'inline' | 'split', preferSide: 'a' | 'b' = 'b'): Promise<EditorView | undefined> {
		const existing = editorViews.get(filepath);
		const targetView = mode === 'split'
			? (preferSide === 'a' ? (existing?.split?.a || existing?.split?.b) : (existing?.split?.b || existing?.split?.a))
			: existing?.inline;
		if (targetView) return targetView;

		return new Promise<EditorView | undefined>((resolve) => {
			const timer = setTimeout(() => {
				const current = editorViews.get(filepath);
				resolve(mode === 'split' ? (preferSide === 'a' ? (current?.split?.a || current?.split?.b) : (current?.split?.b || current?.split?.a)) : current?.inline);
			}, 500);

			const list = editorResolvers.get(filepath) || [];
			list.push((views) => {
				clearTimeout(timer);
				resolve(mode === 'split' ? (preferSide === 'a' ? (views.split?.a || views.split?.b) : (views.split?.b || views.split?.a)) : views.inline);
			});
			editorResolvers.set(filepath, list);
		});
	}

	function createFileNavKeymap(filepath: string) {
		return keymap.of([
			{
				key: "ArrowDown",
				run: (v) => {
					if (isAtBufferBoundary(v, 'down')) {
						const views = editorViews.get(filepath);
						const side = (views?.split?.a === v) ? 'a' : 'b';
						navigateFromFileEditor(filepath, 'down', side);
						return true;
					}
					return false;
				}
			},
			{
				key: "ArrowUp",
				run: (v) => {
					if (isAtBufferBoundary(v, 'up')) {
						const views = editorViews.get(filepath);
						const side = (views?.split?.a === v) ? 'a' : 'b';
						navigateFromFileEditor(filepath, 'up', side);
						return true;
					}
					return false;
				}
			}
		]);
	}

	function focusHeader(filepath: string) {
		const header = document.getElementById(`diff-header-${filepath}`);
		if (header) {
			header.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
			if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
			setTimeout(() => header.focus(), 0);
		}
	}

	function focusEditorAtLine(editor: EditorView, targetLineNum: number) {
		const clampedLine = Math.min(Math.max(1, targetLineNum), editor.state.doc.lines);
		const line = editor.state.doc.line(clampedLine);
		editor.dispatch({
			selection: { anchor: line.from, head: line.from },
			effects: EditorView.scrollIntoView(line.from, { y: 'center' })
		});
		if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
		setTimeout(() => editor.focus(), 0);
	}

	function focusEditorFirstLine(editor: EditorView) {
		const { firstLine } = getBufferBoundaries(editor.state);
		focusEditorAtLine(editor, firstLine);
	}

	function focusEditorLastLine(editor: EditorView) {
		const { lastLine } = getBufferBoundaries(editor.state);
		focusEditorAtLine(editor, lastLine);
	}

	async function navigateFromFileEditor(filepath: string, direction: 'down' | 'up', side: 'a' | 'b' = 'b') {
		const idx = activeChanges.findIndex((c) => c.filepath === filepath);
		if (idx === -1) return;

		if (direction === 'down') {
			const nextFile = activeChanges[idx + 1];
			if (!nextFile) return;

			const isNextCollapsed = isFileCollapsed(nextFile.filepath);
			if (isNextCollapsed) {
				focusHeader(nextFile.filepath);
			} else {
				const editor = await getOrWaitEditor(nextFile.filepath, viewMode, side);
				if (editor) focusEditorFirstLine(editor);
			}
		} else {
			const prevFile = activeChanges[idx - 1];
			if (prevFile) {
				const isPrevCollapsed = isFileCollapsed(prevFile.filepath);
				if (isPrevCollapsed) {
					focusHeader(prevFile.filepath);
				} else {
					const editor = await getOrWaitEditor(prevFile.filepath, viewMode, side);
					if (editor) focusEditorLastLine(editor);
				}
			} else {
				focusHeader(filepath);
			}
		}
	}

	function hasGitChangeChanged(prev: GitChange, next: GitChange): boolean {
		return (
			prev !== next ||
			prev.staged !== next.staged ||
			prev.stagedContent !== next.stagedContent ||
			prev.originalContent !== next.originalContent ||
			prev.modifiedContent !== next.modifiedContent ||
			prev.diff !== next.diff
		);
	}

	function registerEditorView(filepath: string, entry: { inline?: EditorView; split?: MergeView }) {
		const current = editorViews.get(filepath) || {};
		const updated = { ...current, ...entry };
		editorViews.set(filepath, updated);

		const pending = editorResolvers.get(filepath);
		if (pending) {
			pending.forEach((resolve) => resolve(updated));
			editorResolvers.delete(filepath);
		}
	}

	// Svelte action to initialize CodeMirror editor for inline unified diff
	function setupEditor(
		node: HTMLDivElement,
		options: {
			content: string; // modified content
			originalContent: string;
			readOnly: boolean;
			filepath: string;
			fileChange: GitChange;
			wrap: boolean;
			hunks?: HunkCoordinates[];
			unstagedChunks?: readonly Chunk[];
		}
	) {
		let view: EditorView | undefined;
		let currentOptions = options;
		let disposed = false;
		const wrapCompartment = new Compartment();
		const diffCompartment = new Compartment();
		const hunkCompartment = new Compartment();

		const langDesc = LanguageSupport.getLanguageForFile(options.filepath);
		getLanguageExtensions(langDesc).then((langExtensions) => {
			if (disposed) return;
			const state = EditorState.create({
				doc: currentOptions.content,
				extensions: [
					EditorState.readOnly.of(currentOptions.readOnly),
					diffCompartment.of(
						unifiedMergeView({
							original: currentOptions.originalContent,
							collapseUnchanged: DIFF_COLLAPSE_CONFIG,
							diffConfig: DEFAULT_DIFF_CONFIG
						})
					),
					hunkCompartment.of(
						createHunkWidgetExtension(currentOptions.fileChange, appState, currentOptions.hunks, currentOptions.unstagedChunks)
					),
					...langExtensions,
					syntaxHighlighting(markdownHighlight),
					editorTheme,
					diffTheme,
					createFileNavKeymap(options.filepath),
					wrapCompartment.of(currentOptions.wrap ? EditorView.lineWrapping : [])
				]
			});

			view = new EditorView({
				state,
				parent: node
			});
			registerEditorView(currentOptions.filepath, { inline: view });
		});

		const clickHandler = makeGutterClickHandler(() => view, () => currentOptions.filepath);
		node.addEventListener('click', clickHandler);

		return {
			update(newOptions: typeof options) {
				const oldOptions = currentOptions;
				currentOptions = newOptions;
				if (view) {
					const currentDoc = view.state.doc.toString();
					const hasDocChange = currentOptions.content !== currentDoc;
					const effects = [];

					if (currentOptions.wrap !== oldOptions.wrap) {
						effects.push(
							wrapCompartment.reconfigure(
								currentOptions.wrap ? EditorView.lineWrapping : []
							)
						);
					}
					if (currentOptions.originalContent !== oldOptions.originalContent) {
						effects.push(
							diffCompartment.reconfigure(
								unifiedMergeView({
									original: currentOptions.originalContent,
									collapseUnchanged: DIFF_COLLAPSE_CONFIG,
									diffConfig: DEFAULT_DIFF_CONFIG
								})
							)
						);
					}
					if (hasGitChangeChanged(oldOptions.fileChange, currentOptions.fileChange)) {
						effects.push(
							hunkCompartment.reconfigure(
								createHunkWidgetExtension(currentOptions.fileChange, appState, currentOptions.hunks, currentOptions.unstagedChunks)
							)
						);
					}

					if (hasDocChange || effects.length > 0) {
						view.dispatch({
							changes: hasDocChange
								? {
										from: 0,
										to: view.state.doc.length,
										insert: currentOptions.content
								  }
								: undefined,
							effects: effects.length > 0 ? effects : undefined
						});
					}
				}
			},
			destroy() {
				disposed = true;
				node.removeEventListener('click', clickHandler);
				const existing = editorViews.get(currentOptions.filepath);
				if (existing) {
					delete existing.inline;
					if (!existing.split) editorViews.delete(currentOptions.filepath);
				}
				view?.destroy();
			}
		};
	}

	// Svelte action to initialize CodeMirror MergeView (Split View)
	function setupMergeView(
		node: HTMLDivElement,
		options: {
			leftContent: string;
			rightContent: string;
			filepath: string;
			fileChange: GitChange;
			wrap: boolean;
			hunks?: HunkCoordinates[];
			unstagedChunks?: readonly Chunk[];
			onDocChange?: (newVal: string) => void;
		}
	) {
		let view: MergeView | undefined;
		let currentOptions = options;
		let cleanupSync: (() => void) | undefined;
		let disposed = false;
		const wrapCompartmentA = new Compartment();
		const wrapCompartmentB = new Compartment();
		const hunkCompartmentB = new Compartment();

		const langDesc = LanguageSupport.getLanguageForFile(options.filepath);
		getLanguageExtensions(langDesc).then((langExtensions) => {
			if (disposed) return;
			view = new MergeView({
				a: {
					doc: currentOptions.leftContent,
					extensions: [
						EditorState.readOnly.of(true),
						...langExtensions,
						syntaxHighlighting(markdownHighlight),
						editorTheme,
						diffTheme,
						createFileNavKeymap(options.filepath),
						wrapCompartmentA.of(currentOptions.wrap ? EditorView.lineWrapping : [])
					]
				},
				b: {
					doc: currentOptions.rightContent,
					extensions: [
						EditorState.readOnly.of(true),
						hunkCompartmentB.of(
							createHunkWidgetExtension(currentOptions.fileChange, appState, currentOptions.hunks, currentOptions.unstagedChunks)
						),
						...langExtensions,
						syntaxHighlighting(markdownHighlight),
						editorTheme,
						EditorView.updateListener.of((update) => {
							if (update.docChanged && currentOptions.onDocChange) {
								currentOptions.onDocChange(update.state.doc.toString());
							}
						}),
						diffTheme,
						createFileNavKeymap(options.filepath),
						wrapCompartmentB.of(currentOptions.wrap ? EditorView.lineWrapping : [])
					]
				},
				diffConfig: DEFAULT_DIFF_CONFIG,
				parent: node,
				orientation: "a-b",
				collapseUnchanged: DIFF_COLLAPSE_CONFIG
			});

			const editors = node.querySelectorAll('.cm-mergeViewEditor');
			const scrollA = editors[0] as HTMLElement | undefined;
			const scrollB = editors[1] as HTMLElement | undefined;

			if (scrollA && scrollB) {
				let isSyncingA = false;
				let isSyncingB = false;

				const onScrollA = () => {
					if (isSyncingA) {
						isSyncingA = false;
						return;
					}
					if (scrollB.scrollLeft !== scrollA.scrollLeft) {
						isSyncingB = true;
						scrollB.scrollLeft = scrollA.scrollLeft;
					}
				};

				const onScrollB = () => {
					if (isSyncingB) {
						isSyncingB = false;
						return;
					}
					if (scrollA.scrollLeft !== scrollB.scrollLeft) {
						isSyncingA = true;
						scrollA.scrollLeft = scrollB.scrollLeft;
					}
				};

				scrollA.addEventListener('scroll', onScrollA, { passive: true });
				scrollB.addEventListener('scroll', onScrollB, { passive: true });

				cleanupSync = () => {
					scrollA.removeEventListener('scroll', onScrollA);
					scrollB.removeEventListener('scroll', onScrollB);
				};
			}

			registerEditorView(currentOptions.filepath, { split: view });
		});

		const clickHandler = makeGutterClickHandler(() => view ? view.b : undefined, () => currentOptions.filepath);
		node.addEventListener('click', clickHandler);

		return {
			update(newOptions: typeof options) {
				const oldOptions = currentOptions;
				currentOptions = newOptions;
				if (view) {
					const leftDoc = view.a.state.doc.toString();
					const hasLeftDocChange = currentOptions.leftContent !== leftDoc;
					const effectsA = [];
					if (currentOptions.wrap !== oldOptions.wrap) {
						effectsA.push(
							wrapCompartmentA.reconfigure(
								currentOptions.wrap ? EditorView.lineWrapping : []
							)
						);
					}
					if (hasLeftDocChange || effectsA.length > 0) {
						view.a.dispatch({
							changes: hasLeftDocChange
								? {
										from: 0,
										to: view.a.state.doc.length,
										insert: currentOptions.leftContent
								  }
								: undefined,
							effects: effectsA.length > 0 ? effectsA : undefined
						});
					}

					const rightDoc = view.b.state.doc.toString();
					const hasRightDocChange = currentOptions.rightContent !== rightDoc;
					const effectsB = [];
					if (currentOptions.wrap !== oldOptions.wrap) {
						effectsB.push(
							wrapCompartmentB.reconfigure(
								currentOptions.wrap ? EditorView.lineWrapping : []
							)
						);
					}
					if (hasGitChangeChanged(oldOptions.fileChange, currentOptions.fileChange)) {
						effectsB.push(
							hunkCompartmentB.reconfigure(
								createHunkWidgetExtension(currentOptions.fileChange, appState, currentOptions.hunks, currentOptions.unstagedChunks)
							)
						);
					}
					if (hasRightDocChange || effectsB.length > 0) {
						view.b.dispatch({
							changes: hasRightDocChange
								? {
										from: 0,
										to: view.b.state.doc.length,
										insert: currentOptions.rightContent
								  }
								: undefined,
							effects: effectsB.length > 0 ? effectsB : undefined
						});
					}
				}
			},
			destroy() {
				disposed = true;
				node.removeEventListener('click', clickHandler);
				cleanupSync?.();
				const existing = editorViews.get(currentOptions.filepath);
				if (existing) {
					delete existing.split;
					if (!existing.inline) editorViews.delete(currentOptions.filepath);
				}
				view?.destroy();
			}
		};
	}

	interface Props {
		change?: GitChange | null;
		changes?: GitChange[];
	}

	let { change = null, changes = [] }: Props = $props();
	let viewMode = $state<'split' | 'inline'>('split');
	const appState = useAppState();

	// Collapsible files mapping
	let collapsedFiles = $state<Record<string, boolean>>({});

	function isFileCollapsed(filepath: string): boolean {
		const activeFile = repo?.activeDiffFile?.filepath;
		return collapsedFiles[filepath] ?? (activeFile ? (filepath !== activeFile) : false);
	}

	function toggleCollapse(filepath: string) {
		collapsedFiles[filepath] = !isFileCollapsed(filepath);
	}

	async function openFileInRegularTab(filepath: string, lineNumber?: number) {
		if (appState.workspace.rootOrigin) {
			const origin = {
				scheme: appState.workspace.rootOrigin.scheme,
				path: appState.workspace.rootOrigin.path + '/' + filepath,
				name: filepath.split('/').pop() || filepath
			};
			const doc = await appState.workspace.openFile(origin);
			if (doc && lineNumber !== undefined) {
				doc.pendingLineToScroll = lineNumber;
			}
		}
	}

	let repo = $derived(appState.workspace.repository);

	// Scroll target into view effect
	let lastScrolledFilepath = '';
	$effect(() => {
		const targetFile = repo?.activeDiffFile?.filepath;
		if (targetFile && targetFile !== lastScrolledFilepath) {
			lastScrolledFilepath = targetFile;
			// Make sure it is expanded first if it was collapsed
			collapsedFiles[targetFile] = false;

			// Wait a tick for rendering
			setTimeout(() => {
				const element = document.getElementById(`diff-file-${targetFile}`);
				if (element) {
					element.scrollIntoView({ behavior: 'smooth', block: 'start' });
				}
			}, 50);
		}
	});

	function combineChangesByFilepath(changeList: GitChange[]): GitChange[] {
		const map = new Map<string, GitChange[]>();
		for (const c of changeList) {
			const existing = map.get(c.filepath);
			if (existing) {
				existing.push(c);
			} else {
				map.set(c.filepath, [c]);
			}
		}

		const result: GitChange[] = [];
		for (const [filepath, group] of map.entries()) {
			if (group.length === 1) {
				result.push(group[0]);
			} else {
				const stagedChange = group.find((c) => c.staged);
				const unstagedChange = group.find((c) => !c.staged);

				if (stagedChange && unstagedChange) {
					result.push({
						filepath,
						status: stagedChange.status !== 'U' ? stagedChange.status : unstagedChange.status,
						staged: false,
						combined: true,
						diff: `${stagedChange.diff || ''}\n${unstagedChange.diff || ''}`,
						originalContent: stagedChange.originalContent,
						modifiedContent: unstagedChange.modifiedContent,
						stagedContent: stagedChange.modifiedContent ?? unstagedChange.originalContent,
						additions: (stagedChange.additions || 0) + (unstagedChange.additions || 0),
						deletions: (stagedChange.deletions || 0) + (unstagedChange.deletions || 0)
					});
				} else {
					result.push(group[0]);
				}
			}
		}

		return result;
	}

	interface CachedDiffDetail extends FileDiffDetail {
		hunks?: HunkCoordinates[];
		unstagedChunks?: readonly Chunk[];
	}

	let loadedDiffs = $state<Record<string, CachedDiffDetail>>({});
	let loadingDiffs = $state<Record<string, boolean>>({});

	function getOrComputeDiffHunks(diff: FileDiffDetail, isStaged: boolean = false): { hunks: HunkCoordinates[]; unstagedChunks: readonly Chunk[] } {
		const cached = diff as CachedDiffDetail;
		if (cached.hunks && cached.unstagedChunks) {
			return { hunks: cached.hunks, unstagedChunks: cached.unstagedChunks };
		}
		const origText = Text.of((diff.originalContent || '').split(/\r?\n/));
		const modText = Text.of((diff.modifiedContent || '').split(/\r?\n/));
		const stagedContent = diff.stagedContent ?? (isStaged ? (diff.modifiedContent || '') : (diff.originalContent || ''));
		const stagedText = Text.of(stagedContent.split(/\r?\n/));

		const hunks = getUnifiedHunks(origText, modText, DEFAULT_DIFF_CONFIG);
		const unstagedChunks = Chunk.build(stagedText, modText, DEFAULT_DIFF_CONFIG);
		cached.hunks = hunks;
		cached.unstagedChunks = unstagedChunks;
		return { hunks, unstagedChunks };
	}

	function resolveFileDiff(fileChange: GitChange): CachedDiffDetail | null {
		const key = diffCacheKey(fileChange);
		if (loadedDiffs[key]) {
			return loadedDiffs[key];
		}
		const detail = fileDiffFromChange(fileChange);
		if (detail) {
			getOrComputeDiffHunks(detail, fileChange.staged);
			loadedDiffs[key] = detail;
			return detail;
		}
		return null;
	}

	async function fetchDiff(filepath: string, options?: { staged?: boolean; combined?: boolean; status?: 'M' | 'A' | 'D' | 'U' }) {
		const key = diffCacheKey({ filepath, staged: options?.staged, combined: options?.combined });
		if (loadingDiffs[key] || loadedDiffs[key]) return;
		loadingDiffs[key] = true;
		try {
			if (repo) {
				const diff = await repo.getFileDiff(filepath, options?.combined ? { status: options?.status } : { staged: options?.staged, status: options?.status });
				const detail: CachedDiffDetail = diff ?? { originalContent: '', modifiedContent: '', stagedContent: '' };
				getOrComputeDiffHunks(detail, options?.staged);
				loadedDiffs[key] = detail;
			}
		} catch (e) {
			console.error(`Failed to load diff for ${filepath}:`, e);
			const fallback: CachedDiffDetail = { originalContent: '', modifiedContent: '', stagedContent: '' };
			getOrComputeDiffHunks(fallback, options?.staged);
			loadedDiffs[key] = fallback;
		} finally {
			loadingDiffs[key] = false;
		}
	}

	let lastChangesRef: GitChange[] | null = null;
	$effect(() => {
		const currentChanges = repo?.changes ?? null;
		if (currentChanges !== lastChangesRef) {
			loadedDiffs = {};
			loadingDiffs = {};
			lastChangesRef = currentChanges;
		}
	});

	$effect(() => {
		for (const file of activeChanges) {
			if (!isFileCollapsed(file.filepath)) {
				const key = diffCacheKey(file);
				if (file.originalContent === undefined && file.modifiedContent === undefined && !loadedDiffs[key] && !loadingDiffs[key]) {
					fetchDiff(file.filepath, { staged: file.staged, combined: file.combined, status: file.status });
				}
			}
		}
	});

	let filterScope = $state<'all' | 'selected'>('all');

	// Active changes to render (defaults to all files, combined by filepath, filtered by selection if filterScope === 'selected')
	let activeChanges = $derived.by(() => {
		let rawList: GitChange[] = [];
		if (change) {
			rawList = [change];
		} else if (filterScope === 'selected') {
			const selected = repo?.selectedPaths ?? [];
			if (selected.length > 0) {
				const set = new Set(selected);
				const filtered = changes.filter((c) => set.has(c.filepath));
				if (filtered.length > 0) rawList = filtered;
			}
			if (rawList.length === 0) {
				const activeFile = repo?.activeDiffFile?.filepath;
				if (activeFile) {
					const filtered = changes.filter((c) => c.filepath === activeFile);
					if (filtered.length > 0) rawList = filtered;
				}
			}
			if (rawList.length === 0) rawList = changes;
		} else {
			rawList = changes;
		}

		return combineChangesByFilepath(rawList);
	});

	// Compute cumulative stats across all active changes
	let totalAdditions = $derived(activeChanges.reduce((sum, c) => sum + c.additions, 0));
	let totalDeletions = $derived(activeChanges.reduce((sum, c) => sum + c.deletions, 0));
	interface HunkTarget {
		fileIndex: number;
		filepath: string;
		chunkIndex: number;
		posB: number;
	}

	// Compute all hunks across expanded active changes as a $derived signal (skipping collapsed files)
	let allHunks = $derived.by(() => {
		const list: HunkTarget[] = [];
		activeChanges.forEach((change, fileIndex) => {
			if (isFileCollapsed(change.filepath)) return; // Skip collapsed files from hunk navigation

			const diff = resolveFileDiff(change);
			if (!diff || (!diff.originalContent && !diff.modifiedContent)) return;

			const { hunks } = getOrComputeDiffHunks(diff, change.staged);
			hunks.forEach((chunk, chunkIndex) => {
				list.push({
					fileIndex,
					filepath: change.filepath,
					chunkIndex,
					posB: chunk.fromB
				});
			});
		});
		return list;
	});

	let lastTargetHunkIndex = $state<number>(-1);

	function getActiveCursorLocation(): { filepath: string; pos: number } | null {
		// Check focused editor first (checking both split.a and split.b)
		for (const [filepath, views] of editorViews.entries()) {
			if (viewMode === 'split' && views.split) {
				if (views.split.b.hasFocus) {
					return { filepath, pos: views.split.b.state.selection.main.head };
				}
				if (views.split.a.hasFocus) {
					return { filepath, pos: views.split.a.state.selection.main.head };
				}
			} else if (views.inline && views.inline.hasFocus) {
				return { filepath, pos: views.inline.state.selection.main.head };
			}
		}
		// Fallback to active diff file from repo state
		const activeFile = repo?.activeDiffFile?.filepath;
		if (activeFile) {
			const views = editorViews.get(activeFile);
			if (viewMode === 'split' && views?.split) {
				const ed = views.split.b.hasFocus ? views.split.b : (views.split.a.hasFocus ? views.split.a : views.split.b);
				return { filepath: activeFile, pos: ed.state.selection.main.head };
			} else if (views?.inline) {
				return { filepath: activeFile, pos: views.inline.state.selection.main.head };
			}
		}
		return null;
	}

	async function jumpToChunk(direction: 'next' | 'prev') {
		const hunks = allHunks;
		if (hunks.length === 0) return;

		const cursorLoc = getActiveCursorLocation();
		let targetIndex = -1;

		if (cursorLoc) {
			const currentFileIdx = activeChanges.findIndex((c) => c.filepath === cursorLoc.filepath);
			if (currentFileIdx !== -1) {
				if (direction === 'next') {
					targetIndex = hunks.findIndex((h) => {
						if (h.fileIndex > currentFileIdx) return true;
						if (h.fileIndex === currentFileIdx && h.posB > cursorLoc.pos) return true;
						return false;
					});
					if (targetIndex === -1) targetIndex = 0; // Wrap to beginning
				} else {
					for (let i = hunks.length - 1; i >= 0; i--) {
						const h = hunks[i];
						if (h.fileIndex < currentFileIdx) {
							targetIndex = i;
							break;
						}
						if (h.fileIndex === currentFileIdx && h.posB < cursorLoc.pos) {
							targetIndex = i;
							break;
						}
					}
					if (targetIndex === -1) targetIndex = hunks.length - 1; // Wrap to end
				}
			}
		}

		if (targetIndex === -1) {
			if (lastTargetHunkIndex >= 0 && lastTargetHunkIndex < hunks.length) {
				targetIndex = direction === 'next'
					? (lastTargetHunkIndex + 1) % hunks.length
					: (lastTargetHunkIndex - 1 + hunks.length) % hunks.length;
			} else {
				targetIndex = direction === 'next' ? 0 : hunks.length - 1;
			}
		}

		const targetHunk = hunks[targetIndex];
		lastTargetHunkIndex = targetIndex;

		// Scroll file container into view
		const fileContainer = document.getElementById(`diff-file-${targetHunk.filepath}`);
		if (fileContainer) {
			fileContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
		}

		// Get editor instance
		const editor = await getOrWaitEditor(targetHunk.filepath, viewMode);

		if (editor) {
			const pos = Math.min(targetHunk.posB, editor.state.doc.length);
			const line = editor.state.doc.lineAt(pos);
			editor.dispatch({
				selection: { anchor: line.from, head: line.from },
				effects: EditorView.scrollIntoView(line.from, { y: 'center' })
			});
			editor.focus();
		}
	}

	async function handleHeaderKeydown(event: KeyboardEvent, filepath: string) {
		const idx = activeChanges.findIndex((c) => c.filepath === filepath);
		if (idx === -1) return;

		const isCollapsed = isFileCollapsed(filepath);

		if (event.key === 'ArrowDown') {
			event.preventDefault();
			if (!isCollapsed) {
				const editor = await getOrWaitEditor(filepath, viewMode);
				if (editor) focusEditorFirstLine(editor);
			} else {
				const nextFile = activeChanges[idx + 1];
				if (nextFile) focusHeader(nextFile.filepath);
			}
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			const prevFile = activeChanges[idx - 1];
			if (prevFile) {
				const isPrevCollapsed = isFileCollapsed(prevFile.filepath);
				if (!isPrevCollapsed) {
					const editor = await getOrWaitEditor(prevFile.filepath, viewMode);
					if (editor) focusEditorLastLine(editor);
				} else {
					focusHeader(prevFile.filepath);
				}
			}
		} else if (event.key === 'ArrowRight') {
			event.preventDefault();
			if (isCollapsed) {
				toggleCollapse(filepath);
			}
		} else if (event.key === 'ArrowLeft') {
			event.preventDefault();
			if (!isCollapsed) {
				toggleCollapse(filepath);
			}
		} else if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			toggleCollapse(filepath);
		}
	}

	function prevHunk() {
		jumpToChunk('prev');
	}

	function nextHunk() {
		jumpToChunk('next');
	}
</script>

<div class="flex flex-col h-full w-full bg-background border-l border-border select-text">
	<!-- Pane Header -->
	<div class="flex items-center justify-between mb-2 border-b border-border shrink-0 h-11 px-4 select-none">
		<div class="flex items-center gap-2">
			{#if activeChanges.length > 0}
				{@const allCollapsed = activeChanges.every(f => isFileCollapsed(f.filepath))}
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={allCollapsed ? "Expand All Files" : "Collapse All Files"}
					title={allCollapsed ? "Expand All Files" : "Collapse All Files"}
					onclick={() => {
						const nextState = !allCollapsed;
						for (const file of activeChanges) {
							collapsedFiles[file.filepath] = nextState;
						}
					}}
				>
					{#if allCollapsed}
						<CaretDownIcon class="h-4 w-4" />
					{:else}
						<CaretUpDownIcon class="h-4 w-4" />
					{/if}
				</Button>
			{/if}
			<!-- Toggle Split/Inline modes -->
			<div class="flex items-center rounded-md border border-border bg-background p-0.5">
				<button
					type="button"
					onclick={() => viewMode = 'split'}
					class="p-1 rounded-sm hover:text-foreground hover:bg-muted transition-colors cursor-pointer {viewMode === 'split' ? 'bg-muted text-foreground' : 'text-muted-foreground'}"
					title="Split View"
				>
					<ColumnsIcon class="size-3.5" />
				</button>
				<button
					type="button"
					onclick={() => viewMode = 'inline'}
					class="p-1 rounded-sm hover:text-foreground hover:bg-muted transition-colors cursor-pointer {viewMode === 'inline' ? 'bg-muted text-foreground' : 'text-muted-foreground'}"
					title="Inline View"
				>
					<RowsIcon class="size-3.5" />
				</button>
			</div>

			<!-- Toggle Filter Scope: All vs Selected -->
			<div class="flex items-center rounded-md border border-border bg-background p-0.5 text-[10px] font-mono select-none">
				<button
					type="button"
					onclick={() => filterScope = 'all'}
					class="px-2 py-0.5 rounded-sm hover:text-foreground hover:bg-muted transition-colors cursor-pointer {filterScope === 'all' ? 'bg-muted text-foreground font-bold' : 'text-muted-foreground'}"
					title="Show all file diffs"
				>
					All
				</button>
				<button
					type="button"
					onclick={() => filterScope = 'selected'}
					class="px-2 py-0.5 rounded-sm hover:text-foreground hover:bg-muted transition-colors cursor-pointer {filterScope === 'selected' ? 'bg-muted text-foreground font-bold' : 'text-muted-foreground'}"
					title="Show diffs for selected files only"
				>
					Selected
				</button>
			</div>
		</div>

		<!-- Actions -->
		<div class="flex items-center gap-1.5 ml-2 shrink-0">
			<!-- Cumulative Stats inside header -->
			<span class="flex items-center gap-1 text-[10px] font-mono shrink-0 mr-2">
				{#if totalAdditions > 0}
					<span class="text-emerald-500 font-bold">+{totalAdditions}</span>
				{/if}
				{#if totalDeletions > 0}
					<span class="text-rose-500 font-bold">-{totalDeletions}</span>
				{/if}
			</span>

			<div class="h-4 w-px bg-border mx-1"></div>

			<!-- Previous Hunk Button -->
			<button
				type="button"
				onmousedown={(e) => e.preventDefault()}
				onclick={prevHunk}
				class="p-1 text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors cursor-pointer"
				title="Previous Hunk"
			>
				<ArrowUpIcon class="size-3.5" />
			</button>

			<!-- Next Hunk Button -->
			<button
				type="button"
				onmousedown={(e) => e.preventDefault()}
				onclick={nextHunk}
				class="p-1 text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors cursor-pointer"
				title="Next Hunk"
			>
				<ArrowDownIcon class="size-3.5" />
			</button>
		</div>
	</div>

	<!-- Scrollable stacked Multibuffer Diffs -->
	<div class="flex flex-col gap-2 flex-1 overflow-y-auto select-text bg-background">
		{#if activeChanges.length === 0}
			<div class="flex flex-col items-center justify-center p-12 text-center text-muted-foreground h-full">
				<InfoIcon class="size-6 text-primary mb-2 opacity-80" />
				<p class="font-bold text-xs">No active diffs</p>
				<p class="text-[9px] opacity-75 mt-0.5">All modified changes committed.</p>
			</div>
		{:else}
			{#each activeChanges as fileChange (fileChange.filepath + '-' + fileChange.staged)}
				{@const isCollapsed = isFileCollapsed(fileChange.filepath)}
				<div class="flex flex-col bg-background" id="diff-file-{fileChange.filepath}">
					<!-- File Header inside multibuffer -->
					<div class="sticky top-0 z-10 bg-background pt-2 pb-1 px-2">
						<div
							role="button"
							tabindex="0"
							id="diff-header-{fileChange.filepath}"
							class="flex items-center rounded-lg justify-between px-3 py-1 bg-muted/40 hover:bg-muted/70 border border-border/80 hover:border-border select-none shrink-0 font-mono text-[10.5px] h-9 transition-all outline-none focus-visible:ring-2 focus-visible:ring-primary/80 focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:bg-muted/80 focus-visible:border-primary/60 cursor-pointer"
							onclick={(e) => {
								if ((e.target as HTMLElement).closest('button, input, [role=\"checkbox\"]')) return;
								toggleCollapse(fileChange.filepath);
							}}
							onkeydown={(e) => {
								if ((e.target as HTMLElement).closest('button, input, [role=\"checkbox\"]')) return;
								handleHeaderKeydown(e, fileChange.filepath);
							}}
						>
							<div class="flex items-center gap-2">
								<!-- Caret expand/collapse -->
								<button
									type="button"
									onclick={() => toggleCollapse(fileChange.filepath)}
									class="p-0.5 hover:bg-muted rounded text-muted-foreground hover:text-foreground cursor-pointer flex items-center justify-center"
									title={isCollapsed ? "Expand" : "Collapse"}
								>
									{#if isCollapsed}
										<CaretRightIcon class="size-3.5" />
									{:else}
										<CaretDownIcon class="size-3.5" />
									{/if}
								</button>

								<!-- Checkbox to Stage/Unstage -->
								<Checkbox
									checked={fileChange.staged}
									onCheckedChange={(val) => {
										if (repo) {
											if (val) {
												appState.commands.execute('git.stage', fileChange.filepath);
											} else {
												appState.commands.execute('git.unstage', fileChange.filepath);
											}
										}
									}}
									class="size-3.5 shrink-0"
									title={fileChange.staged ? "Unstage entire file" : "Stage entire file"}
								/>

								<!-- Clickable filepath opens in regular tab -->
								<button
									type="button"
									onclick={() => openFileInRegularTab(fileChange.filepath)}
									class="font-bold text-foreground hover:text-primary hover:underline transition-colors font-mono cursor-pointer text-left text-xs"
									title="Open file in regular tab"
								>
									{fileChange.filepath.split('/').pop() || fileChange.filepath}
								</button>
								<span class="text-muted-foreground text-[10px] font-mono opacity-80 select-none">
									{fileChange.filepath.includes('/') ? fileChange.filepath.substring(0, fileChange.filepath.lastIndexOf('/') + 1) : ''}
								</span>
							</div>
							<div class="flex items-center gap-1.5 text-[9px] font-bold">
								{#if fileChange.additions > 0}
									<span class="text-emerald-500 font-bold">+{fileChange.additions}</span>
								{/if}
								{#if fileChange.deletions > 0}
									<span class="text-rose-500 font-bold">-{fileChange.deletions}</span>
								{/if}
							</div>
						</div>
					</div>

					<!-- Diff Content (collapsible) -->
					{#if !isCollapsed}
						{@const diff = resolveFileDiff(fileChange)}
						<div class="bg-muted/5 relative group border-t border-border/40">
							{#if diff}
								{@const effectiveChange = {
									...fileChange,
									originalContent: diff.originalContent,
									modifiedContent: diff.modifiedContent,
									stagedContent: diff.stagedContent
								}}
								{#if viewMode === 'inline'}
									<!-- Inline View: Single Editor showing unified diff of the whole file -->
									<div class="flex-1 overflow-hidden bg-background">
										<div use:setupEditor={{
											content: diff.modifiedContent,
											originalContent: diff.originalContent,
											readOnly: true,
											filepath: fileChange.filepath,
											fileChange: effectiveChange,
											wrap: appState.prefs.wordWrap,
											hunks: diff.hunks,
											unstagedChunks: diff.unstagedChunks
										}}></div>
									</div>
								{:else}
									<!-- Split View: Side-by-side MergeView of the whole file -->
									<div class="flex-1 overflow-hidden bg-background min-w-[800px]">
										<div use:setupMergeView={{
											leftContent: diff.originalContent,
											rightContent: diff.modifiedContent,
											filepath: fileChange.filepath,
											fileChange: effectiveChange,
											wrap: appState.prefs.wordWrap,
											hunks: diff.hunks,
											unstagedChunks: diff.unstagedChunks
										}}></div>
									</div>
								{/if}
							{:else}
								<div class="flex items-center justify-center p-6 text-muted-foreground text-xs font-mono">
									<span class="animate-pulse">Loading diff...</span>
								</div>
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		{/if}
	</div>
</div>
