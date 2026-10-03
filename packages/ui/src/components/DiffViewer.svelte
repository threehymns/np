<script lang="ts">
	import { tick } from 'svelte';
	import { XIcon, ColumnsIcon, RowsIcon, InfoIcon, CaretRightIcon, CaretDownIcon, CaretUpDownIcon, ArrowUpIcon, ArrowDownIcon } from 'phosphor-svelte';
	import type { GitChange, FileDiffDetail, DocumentSession } from '@np/core';
	import { fileDiffFromChange, diffCacheKey, DEFAULT_DIFF_CONFIG } from '@np/core';
	import { useAppState, type AppState } from '@np/core/state.svelte';
	import { Checkbox } from './ui/checkbox';
	import { EditorView, lineNumbers, keymap, WidgetType, Decoration, type DecorationSet, ViewPlugin, ViewUpdate, highlightSpecialChars, drawSelection, highlightActiveLine } from "@codemirror/view";
	import { EditorState, Annotation, Compartment, EditorSelection, Text, Transaction, RangeSetBuilder } from "@codemirror/state";
	import { syntaxHighlighting, foldedRanges, indentOnInput, bracketMatching, type LanguageDescription } from "@codemirror/language";
	import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
	import { autocompletion, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
	import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
	import { vim, getCM } from "@replit/codemirror-vim";
	import { MergeView, unifiedMergeView, Chunk, getChunks } from "@codemirror/merge";
	import { getLanguageExtensions, editorTheme, diffTheme, markdownHighlight, LanguageSupport, workspaceFacet, currentDocFacet, setupVimClipboardSync, syncVimRegistersFromClipboard, smartIndent, minimalTextChange } from '../editor/index';
	import Button from './ui/button/button.svelte';
	import {
		findBoundDocument,
		ensureSplitDocument,
		isSplitWorkingCopyEditable,
		isOriginalOnly,
		computeLiveHunks,
		resolveSplitRightContent,
		isDiffHeaderDirty
	} from './diff-split-binding.js';

	class HunkWidget extends WidgetType {
		hunkIndex: number;
		hunkRange: Chunk;
		staged: boolean;
		change: GitChange;
		appState: AppState;

		constructor(
			hunkIndex: number,
			hunkRange: Chunk,
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
			wrap.className = 'cm-floating-hunk-control inline-flex items-center gap-1 bg-popover text-popover-foreground border-x border-b border-border rounded-b-md px-0.5 py-0.5 text-[10px] font-mono shadow-sm z-20 opacity-50 hover:opacity-100 transition-opacity select-none font-sans';
			wrap.style.cssText = 'float: right; margin-top: -2px; margin-bottom: -2px; position: relative; z-index: 20;';

			const preventEvent = (e: Event) => {
				e.stopPropagation();
				e.preventDefault();
			};
			wrap.addEventListener('mousedown', preventEvent);
			wrap.addEventListener('pointerdown', preventEvent);
			wrap.addEventListener('mouseup', preventEvent);
			wrap.addEventListener('click', preventEvent);

			const makeBtn = (label: string, command: string, className: string) => {
				const btn = document.createElement('button');
				btn.type = 'button';
				btn.className = `py-0.5 px-1 rounded flex items-center justify-center cursor-pointer ${className}`;
				btn.title = `${label} Hunk`;
				btn.setAttribute('aria-label', `${label} Hunk`);
				btn.textContent = label;
				btn.onclick = (e) => {
					e.stopPropagation();
					e.preventDefault();
					this.appState.commands.execute(command, this.change, this.hunkRange);
				};
				wrap.appendChild(btn);
			};

			if (this.staged) {
				makeBtn('Unstage', 'git.unstageHunk', 'hover:bg-muted text-muted-foreground hover:text-foreground');
				makeBtn('Discard', 'git.discardHunk', 'hover:bg-muted text-muted-foreground hover:text-destructive');
			} else {
				makeBtn('Stage', 'git.stageHunk', 'hover:bg-muted text-muted-foreground hover:text-foreground');
				makeBtn('Discard', 'git.discardHunk', 'hover:bg-destructive/10 text-muted-foreground hover:text-destructive');
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
		precomputedHunks?: readonly Chunk[],
		precomputedUnstagedChunks?: readonly Chunk[]
	) {
		return ViewPlugin.fromClass(
			class {
				decorations: DecorationSet;
				cachedHunks: readonly Chunk[] = [];
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

					this.cachedHunks = Chunk.build(origText, modText, DEFAULT_DIFF_CONFIG);
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

	type ViewEntry = { inline?: EditorView; split?: MergeView | EditorView };

	// A split slot holds either the MergeView (ordinary files) or the single
	// read-only Original pane view (deleted files, #272). Unwrap to the
	// focusable EditorViews in b-then-a order.
	function splitPanes(split: MergeView | EditorView | undefined): EditorView[] {
		if (!split) return [];
		if ('a' in split && 'b' in split) {
			const merge = split as MergeView;
			return [merge.b, merge.a].filter(Boolean) as EditorView[];
		}
		return [split as EditorView];
	}

	// Map to track active EditorView or MergeView per filepath
	let editorViews = new Map<string, ViewEntry>();
	// Pending getOrWaitEditor waiters, keyed to the requested mode so a
	// registration for one mode never resolves a waiter for the other mode
	// during rapid inline<->split switches (issue #81).
	type ViewWaiter = {
		mode: 'inline' | 'split';
		preferSide: 'a' | 'b';
		resolve: (view: EditorView | undefined) => void;
	};
	let editorResolvers = new Map<string, Array<ViewWaiter>>();

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

	function pickView(views: ViewEntry | undefined, mode: 'inline' | 'split', preferSide: 'a' | 'b'): EditorView | undefined {
		if (mode === 'split') {
			const split = views?.split;
			if (split && 'a' in split && 'b' in split) {
				const merge = split as MergeView;
				return preferSide === 'a' ? (merge.a || merge.b) : (merge.b || merge.a);
			}
			// Deleted files register their single Original pane here (#272).
			return split as EditorView | undefined;
		}
		return views?.inline;
	}

	async function getOrWaitEditor(filepath: string, mode: 'inline' | 'split', preferSide: 'a' | 'b' = 'b'): Promise<EditorView | undefined> {
		const targetView = pickView(editorViews.get(filepath), mode, preferSide);
		if (targetView) return targetView;

		return new Promise<EditorView | undefined>((resolve) => {
			// Last-resort backstop for genuinely slow registrations (view setup
			// awaits async language extensions). Mode-aware paths below settle
			// first in every normal flow.
			const timer = setTimeout(() => {
				removeWaiter(filepath, waiter);
				resolve(pickView(editorViews.get(filepath), mode, preferSide));
			}, 500);

			const waiter: ViewWaiter = {
				mode,
				preferSide,
				resolve: (view) => {
					clearTimeout(timer);
					resolve(view);
				}
			};
			const list = editorResolvers.get(filepath) || [];
			list.push(waiter);
			editorResolvers.set(filepath, list);
		});
	}

	function removeWaiter(filepath: string, waiter: ViewWaiter) {
		const list = editorResolvers.get(filepath);
		if (!list) return;
		const idx = list.indexOf(waiter);
		if (idx !== -1) list.splice(idx, 1);
		if (list.length === 0) editorResolvers.delete(filepath);
	}

	// Resolve only waiters whose requested mode now has a matching view.
	// Waiters for other modes stay queued for their own registration.
	function fireReadyResolvers(filepath: string) {
		const list = editorResolvers.get(filepath);
		if (!list || list.length === 0) return;
		const views = editorViews.get(filepath);
		for (const waiter of [...list]) {
			const view = pickView(views, waiter.mode, waiter.preferSide);
			if (view !== undefined) {
				removeWaiter(filepath, waiter);
				waiter.resolve(view);
			}
		}
	}

	// Settle waiters for a view that is being torn down (mode switch or file
	// removal) with undefined so callers skip instead of hanging on the
	// backstop or being resolved by a stale registration. When mode is
	// omitted, all waiters for the filepath are aborted.
	function abortResolvers(filepath: string, mode?: 'inline' | 'split') {
		const list = editorResolvers.get(filepath);
		if (!list || list.length === 0) return;
		for (const waiter of [...list]) {
			if (mode === undefined || waiter.mode === mode) {
				removeWaiter(filepath, waiter);
				waiter.resolve(undefined);
			}
		}
	}

	function splitSideOf(views: ViewEntry | undefined, v: EditorView): 'a' | 'b' {
		const split = views?.split;
		if (split && 'a' in split && (split as MergeView).a === v) return 'a';
		return 'b';
	}

	function createFileNavKeymap(filepath: string) {
		return keymap.of([
			{
				key: "ArrowDown",
				run: (v) => {
					if (isAtBufferBoundary(v, 'down')) {
						const views = editorViews.get(filepath);
						navigateFromFileEditor(filepath, 'down', splitSideOf(views, v));
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
						navigateFromFileEditor(filepath, 'up', splitSideOf(views, v));
						return true;
					}
					return false;
				}
			}
		]);
	}

	async function focusHeader(filepath: string) {
		const header = document.getElementById(`diff-header-${filepath}`);
		if (header) {
			header.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
			if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
			await tick();
			header.focus();
		}
	}

	async function focusEditorAtLine(editor: EditorView, targetLineNum: number) {
		const clampedLine = Math.min(Math.max(1, targetLineNum), editor.state.doc.lines);
		const line = editor.state.doc.line(clampedLine);
		editor.dispatch({
			selection: { anchor: line.from, head: line.from },
			effects: EditorView.scrollIntoView(line.from, { y: 'center' })
		});
		if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
		await tick();
		editor.focus();
	}

	function focusEditorFirstLine(editor: EditorView) {
		const { firstLine } = getBufferBoundaries(editor.state);
		void focusEditorAtLine(editor, firstLine);
	}

	function focusEditorLastLine(editor: EditorView) {
		const { lastLine } = getBufferBoundaries(editor.state);
		void focusEditorAtLine(editor, lastLine);
	}

	async function navigateFromFileEditor(filepath: string, direction: 'down' | 'up', side: 'a' | 'b' = 'b') {
		const idx = activeChanges.findIndex((c) => c.filepath === filepath);
		if (idx === -1) return;

		if (direction === 'down') {
			const nextFile = activeChanges[idx + 1];
			if (!nextFile) return;

			const isNextCollapsed = isFileCollapsed(nextFile.filepath);
			if (isNextCollapsed) {
				void focusHeader(nextFile.filepath);
			} else {
				const editor = await getOrWaitEditor(nextFile.filepath, viewMode, side);
				if (editor) focusEditorFirstLine(editor);
			}
		} else {
			const prevFile = activeChanges[idx - 1];
			if (prevFile) {
				const isPrevCollapsed = isFileCollapsed(prevFile.filepath);
				if (isPrevCollapsed) {
					void focusHeader(prevFile.filepath);
				} else {
					const editor = await getOrWaitEditor(prevFile.filepath, viewMode, side);
					if (editor) focusEditorLastLine(editor);
				}
			} else {
				void focusHeader(filepath);
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

	function registerEditorView(filepath: string, entry: ViewEntry) {
		const current = editorViews.get(filepath) || {};
		const updated = { ...current, ...entry };
		editorViews.set(filepath, updated);

		fireReadyResolvers(filepath);
	}

	// Shared-Document binding for the Working-copy pane (#269 split, #270
	// inline). Both modes edit the same Document an Editor tab shows; rules
	// live in diff-split-binding.ts, this component only wires workspace
	// state. The `split*` names predate inline support and cover both modes.
	const splitBoundDocIds = new Map<string, string>();
	let lastFocusedDiffFilepath = $state<string | null>(null);
	// Tags working-copy pane dispatches that replay external Document state
	// (tab keystrokes) so the updateListeners below never route them back as
	// new edits. Mirrors Editor.svelte's syncAnnotation.
	const splitSyncAnnotation = Annotation.define<boolean>();

	function findSplitDoc(filepath: string) {
		return findBoundDocument(
			appState.workspace.documents,
			splitBoundDocIds,
			appState.workspace.project.rootOrigin,
			filepath
		);
	}

	// Pane -> Document: keystrokes become ordinary in-memory edits on the
	// shared Document via the canonical keystroke path.
	function handleSplitDocChange(filepath: string, text: string) {
		const doc = findSplitDoc(filepath);
		if (doc && text !== doc.content) {
			appState.workspace.updateDocumentContent(doc, text);
		}
	}

	// Ensure a shared Document exists for every visible diff file, reusing
	// the open one when present. Creation reads the already-loaded git
	// snapshot (content == baseline, so clean) and opens no tab; files
	// whose diff has not loaded yet bind on the refresh that delivers it.
	$effect(() => {
		const files = activeChanges;
		const root = appState.workspace.project.rootOrigin;
		if (!root) return;
		const workspace = appState.workspace;
		const scope = {
			documents: workspace.documents,
			storage: workspace.project.storage,
			rootOrigin: root,
			coversOrigin: (origin: Parameters<typeof workspace.project.coversOrigin>[0]) =>
				workspace.project.coversOrigin(origin)
		};
		for (const file of files) {
			const detail = resolveFileDiff(file);
			ensureSplitDocument(scope, splitBoundDocIds, file, detail?.modifiedContent ?? file.modifiedContent);
		}
	});

	// Publish the save target for the focused diff file so file.save /
	// file.saveAs with focus in the diff pane (shortcut or command) route
	// through the standard save path for that Document. Falls back to the
	// panel-selected file when nothing was focused yet. Cleared on unmount;
	// the diff tab unmounts when inactive, so this never hijacks tab saves.
	$effect(() => {
		const focused = lastFocusedDiffFilepath;
		const activeFile = repo?.activeDiffFile?.filepath;
		const target = focused ?? activeFile ?? null;
		appState.activeDiffDocument = target ? findSplitDoc(target) : undefined;
		return () => {
			appState.activeDiffDocument = undefined;
		};
	});

	// Silent sync for scroll-past / cursor-focus / header-focus paths.
	// These must update the Git panel highlight WITHOUT triggering the
	// activeDiffFile reveal effect (expand + snap-to-top). Only explicit
	// reveals (git.openDiff from the Git panel) should expand/scroll.
	// Plain (non-reactive) so the $effect below reads it as an untracked
	// snapshot alongside the tracked activeDiffFile value.
	let silentSyncFor: string | null = null;

	function syncActiveFileSilent(filepath: string) {
		const repository = appState.workspace.project.repository;
		if (!repository) return;
		if (repository.activeDiffFile?.filepath === filepath) return;
		silentSyncFor = filepath;
		repository.setActiveDiffFileByPath(filepath);
	}

	// Push diff-editor cursor activity back to the Git panel (issue #79),
	// mirroring Zed's SelectionsChanged -> select_entry_by_path with its
	// contains_focused guard: only the focused editor drives
	// repo.activeDiffFile, so panel clicks and background updates never
	// fight the user's panel selection.
	function syncActiveFileFromCursor(filepath: string, view: EditorView) {
		if (!view.hasFocus) return;
		syncActiveFileSilent(filepath);
	}

	function cursorSyncExtension(getFilepath: () => string) {
		return EditorView.updateListener.of((update) => {
			if (update.docChanged || update.selectionSet) {
				syncActiveFileFromCursor(getFilepath(), update.view);
			}
		});
	}

	// Focus without a selection change (e.g. jumpToChunk focuses the editor
	// after dispatching the new selection) still counts as cursor activity.
	function trackCursorFocus(view: EditorView, getFilepath: () => string) {
		const onFocusIn = () => syncActiveFileFromCursor(getFilepath(), view);
		view.dom.addEventListener('focusin', onFocusIn);
		return () => view.dom.removeEventListener('focusin', onFocusIn);
	}

	// Svelte action to initialize CodeMirror editor for inline unified diff.
	// The unified editor is the Working-copy pane in inline mode (#270): it
	// edits the same shared Document as the split b-pane. Removed
	// (original-only) lines render as uneditable CodeMirror widgets above the
	// working-copy text, so they hold no doc positions and can never receive
	// keystrokes; the editable doc holds working-copy text only, and the
	// Original side (originalDoc) is never dispatched to from here.
	// Deleted files in split mode reuse this as their single read-only
	// Original pane (#272) via `registerAs: 'split'`; inline mode always
	// registers as inline.
	function setupEditor(
		node: HTMLDivElement,
		options: {
			content: string; // Document-driven working-copy content
			originalContent: string;
			editable: boolean;
			onDocChange?: (newVal: string) => void;
			filepath: string;
			fileChange: GitChange;
			wrap: boolean;
			hunks?: readonly Chunk[];
			unstagedChunks?: readonly Chunk[];
			registerAs?: 'inline' | 'split';
		}
	) {
		let view: EditorView | undefined;
		let currentOptions = options;
		let disposed = false;
		let untrackCursorFocus: (() => void) | undefined;
		const wrapCompartment = new Compartment();
		const diffCompartment = new Compartment();
		const hunkCompartment = new Compartment();
		const readOnlyCompartment = new Compartment();
		let inlineEditable = options.editable;

		const langDesc = LanguageSupport.getLanguageForFile(options.filepath);
		getLanguageExtensions(langDesc).then((langExtensions) => {
			if (disposed) return;
			const state = EditorState.create({
				doc: currentOptions.content,
				extensions: [
					// Working-copy pane: editable when bound to the shared
					// Document (#270). Removed lines stay non-editable as
					// widgets regardless of this toggle.
					readOnlyCompartment.of(EditorState.readOnly.of(!currentOptions.editable)),
					diffCompartment.of(
						unifiedMergeView({
							original: currentOptions.originalContent,
							collapseUnchanged: DIFF_COLLAPSE_CONFIG,
							diffConfig: DEFAULT_DIFF_CONFIG,
							mergeControls: false,
						})
					),
					hunkCompartment.of(
						createHunkWidgetExtension(currentOptions.fileChange, appState, currentOptions.hunks, currentOptions.unstagedChunks)
					),
					...langExtensions,
					syntaxHighlighting(markdownHighlight),
					editorTheme,
					diffTheme,
					EditorView.updateListener.of((update) => {
						// Pane -> Document: keystrokes become ordinary
						// in-memory edits on the shared Document via the
						// canonical keystroke path. Sync-tagged transactions
						// (Document -> pane replays below) never echo back.
						if (
							update.docChanged &&
							!update.transactions.some((tr) => tr.annotation(splitSyncAnnotation)) &&
							currentOptions.onDocChange
						) {
							currentOptions.onDocChange(update.state.doc.toString());
						}
					}),
					createFileNavKeymap(options.filepath),
					cursorSyncExtension(() => currentOptions.filepath),
					wrapCompartment.of(currentOptions.wrap ? EditorView.lineWrapping : [])
				]
			});

			view = new EditorView({
				state,
				parent: node
			});
			untrackCursorFocus = trackCursorFocus(view, () => currentOptions.filepath);
			if (currentOptions.registerAs === 'split') {
				registerEditorView(currentOptions.filepath, { split: view });
			} else {
				registerEditorView(currentOptions.filepath, { inline: view });
			}
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
					if (currentOptions.editable !== inlineEditable) {
						inlineEditable = currentOptions.editable;
						effects.push(
							readOnlyCompartment.reconfigure(
								EditorState.readOnly.of(!inlineEditable)
							)
						);
					}
					if (currentOptions.originalContent !== oldOptions.originalContent) {
						effects.push(
							diffCompartment.reconfigure(
								unifiedMergeView({
									original: currentOptions.originalContent,
									collapseUnchanged: DIFF_COLLAPSE_CONFIG,
									diffConfig: DEFAULT_DIFF_CONFIG,
									mergeControls: false,
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
						// Document -> pane sync (e.g. tab keystrokes): tagged
						// so the updateListener above never routes it back,
						// kept out of the pane's undo history, with selection
						// and scroll preserved. Snapshot refreshes never reach
						// this branch: content is driven by Document content,
						// not the git snapshot.
						const insert = currentOptions.content;
						const sel = view.state.selection;
						const clamped = EditorSelection.create(
							sel.ranges.map((r) =>
								EditorSelection.range(Math.min(r.anchor, insert.length), Math.min(r.head, insert.length))
							),
							sel.mainIndex
						);
						const prevTop = view.scrollDOM.scrollTop;
						const prevLeft = view.scrollDOM.scrollLeft;
						view.dispatch({
							changes: hasDocChange
								? {
										from: 0,
										to: view.state.doc.length,
										insert
								  }
								: undefined,
							selection: hasDocChange ? clamped : undefined,
							effects: effects.length > 0 ? effects : undefined,
							annotations: hasDocChange
								? [splitSyncAnnotation.of(true), Transaction.addToHistory.of(false)]
								: undefined
						});
						if (hasDocChange) {
							view.scrollDOM.scrollTop = prevTop;
							view.scrollDOM.scrollLeft = prevLeft;
						}
					}
				}
			},
			destroy() {
				disposed = true;
				node.removeEventListener('click', clickHandler);
				untrackCursorFocus?.();
				const slot = currentOptions.registerAs === 'split' ? 'split' : 'inline';
				const existing = editorViews.get(currentOptions.filepath);
				if (existing) {
					delete existing[slot];
					if (!existing.inline && !existing.split) editorViews.delete(currentOptions.filepath);
				}
				// The view is gone: settle its slot's waiters now instead of
				// leaving them for the backstop or a stale registration.
				abortResolvers(currentOptions.filepath, slot);
				view?.destroy();
			}
		};
	}

	// Identity key for the Working-copy pane language (#271): the bound
	// Document's detected language (honors user override) plus the registry
	// revision, so enabling a language refreshes the pane even when the
	// resolved description reference is unchanged.
	function paneLanguageKey(
		docLanguage: LanguageDescription | null,
		languageRevision: number | undefined
	): string {
		return `${docLanguage?.name ?? '∅'}::${languageRevision ?? 0}`;
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
			hunks?: readonly Chunk[];
			unstagedChunks?: readonly Chunk[];
			editable: boolean;
			vimEnabled: boolean;
			docLanguage: LanguageDescription | null;
			languageRevision: number | undefined;
			boundDoc: DocumentSession | undefined;
			onDocChange?: (newVal: string) => void;
		}
	) {
		let view: MergeView | undefined;
		let currentOptions = options;
		let cleanupSync: (() => void) | undefined;
		let untrackCursorFocus: (() => void) | undefined;
		let untrackPaneFocus: (() => void) | undefined;
		let detachVimMode: (() => void) | undefined;
		let disposed = false;
		let bEditable = options.editable;
		let bVimEnabled = options.vimEnabled;
		let bLangKey = paneLanguageKey(options.docLanguage, options.languageRevision);
		let bBoundDoc = options.boundDoc;
		const wrapCompartmentA = new Compartment();
		const wrapCompartmentB = new Compartment();
		const hunkCompartmentB = new Compartment();
		const readOnlyCompartmentB = new Compartment();
		// Working-copy pane parity compartments (#271). Each pane owns its
		// instances so per-file languages never fight: the Original (a) pane
		// stays bare and read-only, only the b-pane gets editor behavior.
		const vimCompartmentB = new Compartment();
		const languageCompartmentB = new Compartment();
		const facetCompartmentB = new Compartment();

		// (Re)attach the vim-mode-change bridge for the focused b-pane so
		// app-level vim bindings track normal/insert/visual like a tab.
		function syncPaneVimModeListener() {
			detachVimMode?.();
			detachVimMode = undefined;
			if (!currentOptions.vimEnabled || !view || disposed) return;
			const cm = getCM(view.b) as any;
			if (!cm) return;
			const handler = (args: any) => {
				if (view?.b.hasFocus) appState.keymaps.setContext('vim_mode', args.mode);
			};
			cm.on('vim-mode-change', handler);
			detachVimMode = () => cm.off('vim-mode-change', handler);
		}

		function readPaneVimMode(v: EditorView): 'normal' | 'insert' | 'visual' {
			const state: any = (getCM(v) as any)?.state?.vim;
			if (state?.insertMode) return 'insert';
			if (state?.visualMode) return 'visual';
			return 'normal';
		}

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
						cursorSyncExtension(() => currentOptions.filepath),
						wrapCompartmentA.of(currentOptions.wrap ? EditorView.lineWrapping : [])
					]
				},
				b: {
					doc: currentOptions.rightContent,
					extensions: [
						// Working-copy pane: editable when bound to the shared
						// Document (#269). The a-pane above stays read-only.
						readOnlyCompartmentB.of(EditorState.readOnly.of(!currentOptions.editable)),
						hunkCompartmentB.of(
							createHunkWidgetExtension(currentOptions.fileChange, appState, currentOptions.hunks, currentOptions.unstagedChunks)
						),
						// Editor parity for the Working-copy pane only (#271):
						// independent undo history, vim bindings, completions
						// with workspace context, detected language, and tab
						// keybindings. Each MergeView b-pane is its own
						// EditorView, so history() is inherently per-view.
						vimCompartmentB.of(currentOptions.vimEnabled ? vim() : []),
						languageCompartmentB.of(langExtensions),
						facetCompartmentB.of([
							workspaceFacet.of(appState.workspace),
							currentDocFacet.of(currentOptions.boundDoc ?? null)
						]),
						history(),
						autocompletion(),
						indentOnInput(),
						bracketMatching(),
						closeBrackets(),
						highlightSpecialChars(),
						drawSelection(),
						highlightActiveLine(),
						highlightSelectionMatches(),
						EditorState.allowMultipleSelections.of(true),
						keymap.of([
							...closeBracketsKeymap,
							...defaultKeymap,
							...searchKeymap,
							...historyKeymap,
							{ key: "Tab", run: smartIndent("more") },
							{ key: "Shift-Tab", run: smartIndent("less") }
						]),
						syntaxHighlighting(markdownHighlight),
						editorTheme,
						EditorView.updateListener.of((update) => {
							if (
								update.docChanged &&
								!update.transactions.some((tr) => tr.annotation(splitSyncAnnotation)) &&
								currentOptions.onDocChange
							) {
								currentOptions.onDocChange(update.state.doc.toString());
							}
						}),
						diffTheme,
						createFileNavKeymap(options.filepath),
						cursorSyncExtension(() => currentOptions.filepath),
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
			const untrackA = trackCursorFocus(view.a, () => currentOptions.filepath);
			const untrackB = trackCursorFocus(view.b, () => currentOptions.filepath);
			untrackCursorFocus = () => {
				untrackA();
				untrackB();
			};
			// Focused Working-copy pane publishes itself as the active editor
			// (#271) so edit.* commands (undo/redo/cut/copy/paste/find/...)
			// target it; the read-only a-pane never publishes. Identity
			// checks mirror the activeDiffNavigator cleanup.
			const paneDom = view.b.dom;
			const onPaneFocusIn = () => {
				if (disposed || !currentOptions.editable) return;
				appState.activeEditorView = view!.b;
				if (currentOptions.vimEnabled) {
					appState.keymaps.setContext('vim_mode', readPaneVimMode(view!.b));
					if (appState.prefs.vimSyncClipboard) {
						void syncVimRegistersFromClipboard();
					}
				}
			};
			const onPaneFocusOut = () => {
				if (appState.activeEditorView === view?.b) {
					appState.activeEditorView = undefined;
				}
				if (currentOptions.vimEnabled) {
					appState.keymaps.setContext('vim_mode', 'normal');
				}
			};
			paneDom.addEventListener('focusin', onPaneFocusIn);
			paneDom.addEventListener('focusout', onPaneFocusOut);
			untrackPaneFocus = () => {
				paneDom.removeEventListener('focusin', onPaneFocusIn);
				paneDom.removeEventListener('focusout', onPaneFocusOut);
			};
			syncPaneVimModeListener();
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
					if (currentOptions.editable !== bEditable) {
						bEditable = currentOptions.editable;
						effectsB.push(
							readOnlyCompartmentB.reconfigure(
								EditorState.readOnly.of(!bEditable)
							)
						);
						// A pane that just went read-only stops being an edit
						// target for the shared edit.* commands.
						if (!bEditable && appState.activeEditorView === view.b) {
							appState.activeEditorView = undefined;
						}
					}
					let vimToggled = false;
					if (currentOptions.vimEnabled !== bVimEnabled) {
						bVimEnabled = currentOptions.vimEnabled;
						effectsB.push(
							vimCompartmentB.reconfigure(bVimEnabled ? vim() : [])
						);
						vimToggled = true;
					}
					if (currentOptions.boundDoc !== bBoundDoc) {
						bBoundDoc = currentOptions.boundDoc;
						effectsB.push(
							facetCompartmentB.reconfigure([
								workspaceFacet.of(appState.workspace),
								currentDocFacet.of(bBoundDoc ?? null)
							])
						);
					}
					const langKey = paneLanguageKey(currentOptions.docLanguage, currentOptions.languageRevision);
					if (langKey !== bLangKey) {
						bLangKey = langKey;
						const nextDesc = currentOptions.docLanguage;
						const requestedKey = langKey;
						void getLanguageExtensions(nextDesc).then((langExtensions) => {
							if (disposed || !view) return;
							// Only apply when no newer language request has
							// superseded this one while the load was in flight.
							if (bLangKey !== requestedKey) return;
							view.b.dispatch({
								effects: languageCompartmentB.reconfigure(langExtensions)
							});
						});
					}
					if (hasGitChangeChanged(oldOptions.fileChange, currentOptions.fileChange)) {
						effectsB.push(
							hunkCompartmentB.reconfigure(
								createHunkWidgetExtension(currentOptions.fileChange, appState, currentOptions.hunks, currentOptions.unstagedChunks)
							)
						);
					}
					if (hasRightDocChange || effectsB.length > 0) {
						// Document -> pane sync (e.g. tab keystrokes): the
						// pane already holds pane-side keystrokes (rightContent
						// is Document-driven, so those are no-ops here), and
						// external syncs stay out of the pane's undo history
						// with selection and scroll preserved. Snapshot
						// refreshes never reach this branch: rightContent is
						// driven by Document content, not the git snapshot.
						// The sync is a minimal hunk (not a full replacement)
						// so tab keystrokes map through — rather than wipe —
						// the pane's independent undo history (#271).
						const insert = currentOptions.rightContent;
						const sel = view.b.state.selection;
						const clamped = EditorSelection.create(
							sel.ranges.map((r) =>
								EditorSelection.range(Math.min(r.anchor, insert.length), Math.min(r.head, insert.length))
							),
							sel.mainIndex
						);
						const prevTop = view.b.scrollDOM.scrollTop;
						const prevLeft = view.b.scrollDOM.scrollLeft;
						const syncChange = hasRightDocChange
							? (minimalTextChange(rightDoc, insert) ?? {
									from: 0,
									to: view.b.state.doc.length,
									insert
								})
							: undefined;
						view.b.dispatch({
							changes: syncChange,
							selection: hasRightDocChange ? clamped : undefined,
							effects: effectsB.length > 0 ? effectsB : undefined,
							annotations: hasRightDocChange
								? [splitSyncAnnotation.of(true), Transaction.addToHistory.of(false)]
								: undefined
						});
						if (hasRightDocChange) {
							view.b.scrollDOM.scrollTop = prevTop;
							view.b.scrollDOM.scrollLeft = prevLeft;
						}
						// Re-bridge vim-mode changes after the new vim
						// configuration above has applied (getCM reads the
						// post-dispatch state).
						if (vimToggled) syncPaneVimModeListener();
					}
				}
			},
			destroy() {
				disposed = true;
				node.removeEventListener('click', clickHandler);
				cleanupSync?.();
				untrackCursorFocus?.();
				untrackPaneFocus?.();
				detachVimMode?.();
				detachVimMode = undefined;
				if (view && appState.activeEditorView === view.b) {
					appState.activeEditorView = undefined;
				}
				const existing = editorViews.get(currentOptions.filepath);
				if (existing) {
					delete existing.split;
					if (!existing.inline) editorViews.delete(currentOptions.filepath);
				}
				// The split view is gone: settle its waiters now instead of
				// leaving them for the backstop or a stale registration.
				abortResolvers(currentOptions.filepath, 'split');
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
		if (appState.workspace.project.rootOrigin) {
			const origin = {
				scheme: appState.workspace.project.rootOrigin.scheme,
				path: appState.workspace.project.rootOrigin.path + '/' + filepath,
				name: filepath.split('/').pop() || filepath
			};
			const doc = await appState.workspace.openFile(origin);
			if (doc && lineNumber !== undefined) {
				doc.pendingLineToScroll = lineNumber;
			}
		}
	}

	let repo = $derived(appState.workspace.project.repository);

	// Sync keymap context for DiffViewer so vim-mode and editor shortcuts function
	$effect(() => {
		appState.keymaps.setContext('editor', true);
		if (appState.prefs.vimMode) {
			appState.keymaps.setContext('vim_mode', 'normal');
		} else {
			appState.keymaps.setContext('vim_mode', undefined);
		}
		return () => {
			appState.keymaps.setContext('editor', undefined);
			appState.keymaps.setContext('vim_mode', undefined);
		};
	});

	// Keep global vim clipboard sync armed while the diff is mounted, so
	// vim yanks in the Working-copy pane sync even when no tab Editor is
	// mounted to run its own effect (idempotent with Editor.svelte's).
	$effect(() => {
		const vimEnabled = appState.prefs.vimMode;
		const syncClipboard = appState.prefs.vimSyncClipboard;
		setupVimClipboardSync(vimEnabled && syncClipboard);
	});

	// Publish hunk navigation for the core diff.nextHunk / diff.prevHunk
	// commands (issue #80). Cleared on unmount so the commands disable
	// outside the diff view; identity-checked in case another instance
	// mounted after us.
	$effect(() => {
		const navigator = {
			nextHunk: () => jumpToChunk('next'),
			prevHunk: () => jumpToChunk('prev')
		};
		appState.activeDiffNavigator = navigator;
		return () => {
			if (appState.activeDiffNavigator === navigator) {
				appState.activeDiffNavigator = undefined;
			}
		};
	});

	// Scroll target into view effect — explicit reveals only.
	// Silent syncs (container scroll-past, cursor focus, header focus) update
	// repo.activeDiffFile for the Git panel highlight but must NOT expand or
	// snap-scroll; otherwise manual wheel-scroll with focus in an editor
	// yanks to the top of each entering file and uncollapses it.
	let lastScrolledFilepath = '';
	$effect(() => {
		const targetFile = repo?.activeDiffFile?.filepath;
		if (!targetFile || targetFile === lastScrolledFilepath) {
			if (silentSyncFor === targetFile) silentSyncFor = null;
			return;
		}
		if (silentSyncFor === targetFile) {
			lastScrolledFilepath = targetFile;
			silentSyncFor = null;
			return;
		}
		// An explicit reveal overtook a pending silent sync; drop the stale flag.
		silentSyncFor = null;
		lastScrolledFilepath = targetFile;
		// Make sure it is expanded first if it was collapsed
		collapsedFiles[targetFile] = false;

		// Wait a tick for rendering
		void tick().then(() => {
			const element = document.getElementById(`diff-file-${targetFile}`);
			if (element) {
				element.scrollIntoView({ behavior: 'smooth', block: 'start' });
			}
		});
	});

	function combineChangesByFilepath(changeList: GitChange[]): GitChange[] {
		const result: GitChange[] = [];
		for (const [filepath, group] of Map.groupBy(changeList, (c) => c.filepath)) {
			if (group.length === 1) {
				result.push(group[0]);
				continue;
			}
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

		return result;
	}

	interface CachedDiffDetail extends FileDiffDetail {
		hunks?: readonly Chunk[];
		unstagedChunks?: readonly Chunk[];
	}

	let loadedDiffs = $state<Record<string, CachedDiffDetail>>({});
	let loadingDiffs = $state<Record<string, boolean>>({});

	function getOrComputeDiffHunks(diff: FileDiffDetail, isStaged: boolean = false): { hunks: readonly Chunk[]; unstagedChunks: readonly Chunk[] } {
		const cached = diff as CachedDiffDetail;
		if (cached.hunks && cached.unstagedChunks) {
			return { hunks: cached.hunks, unstagedChunks: cached.unstagedChunks };
		}
		const origText = Text.of((diff.originalContent || '').split(/\r?\n/));
		const modText = Text.of((diff.modifiedContent || '').split(/\r?\n/));
		const stagedContent = diff.stagedContent ?? (isStaged ? (diff.modifiedContent || '') : (diff.originalContent || ''));
		const stagedText = Text.of(stagedContent.split(/\r?\n/));

		const hunks = Chunk.build(origText, modText, DEFAULT_DIFF_CONFIG);
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

	// Materialize collapse defaults once per filepath so later (silent) active
	// changes don't flip untouched files via the activeFile fallback in
	// isFileCollapsed. Without this, scrolling past files would
	// expand/collapse them just by changing repo.activeDiffFile, even with
	// the reveal effect suppressed.
	let collapseInitialized = new Set<string>();
	$effect(() => {
		const files = activeChanges;
		const activeFile = repo?.activeDiffFile?.filepath;
		if (activeFile === undefined) return;
		for (const f of files) {
			if (!collapseInitialized.has(f.filepath)) {
				collapseInitialized.add(f.filepath);
				if (!(f.filepath in collapsedFiles)) {
					collapsedFiles[f.filepath] = f.filepath !== activeFile;
				}
			}
		}
	});
	interface HunkTarget {
		fileIndex: number;
		filepath: string;
		chunkIndex: number;
		posB: number;
	}

	// Compute all hunks across expanded active changes as a $derived signal (skipping collapsed files).
	// Hunks derive from the live working-copy text — the bound Document when
	// one exists, so unsaved pane edits move navigation with the typing —
	// against the freshly loaded base snapshot (#272). A version-control
	// refresh replaces the snapshot (new original/staged sides) while the
	// Document keeps the edits, and this re-derives around them.
	let allHunks = $derived.by(() => {
		const list: HunkTarget[] = [];
		activeChanges.forEach((change, fileIndex) => {
			if (isFileCollapsed(change.filepath)) return; // Skip collapsed files from hunk navigation

			const diff = resolveFileDiff(change);
			if (!diff) return;
			const bound = findSplitDoc(change.filepath);
			const effectiveModified = bound ? bound.content : diff.modifiedContent;
			if (!diff.originalContent && !effectiveModified) return;

			const hunks = computeLiveHunks(diff.originalContent, effectiveModified);
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
		// Check focused editor first (both split panes, or the single
		// Original pane of a deleted file).
		for (const [filepath, views] of editorViews.entries()) {
			if (viewMode === 'split' && views.split) {
				for (const pane of splitPanes(views.split)) {
					if (pane.hasFocus) {
						return { filepath, pos: pane.state.selection.main.head };
					}
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
				const panes = splitPanes(views.split);
				const ed = panes.find((p) => p.hasFocus) ?? panes[0];
				if (ed) return { filepath: activeFile, pos: ed.state.selection.main.head };
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
				if (nextFile) void focusHeader(nextFile.filepath);
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
					void focusHeader(prevFile.filepath);
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

	let diffContainerEl = $state<HTMLDivElement | null>(null);

	function handleContainerScroll() {
		if (!diffContainerEl) return;
		// Guard: only drive activeDiffFile if diff container holds focus (mirroring Zed contains_focused)
		if (!diffContainerEl.contains(document.activeElement)) return;

		const containerRect = diffContainerEl.getBoundingClientRect();
		for (const fileChange of activeChanges) {
			const el = document.getElementById(`diff-file-${fileChange.filepath}`);
			if (el) {
				const rect = el.getBoundingClientRect();
				if (rect.bottom > containerRect.top + 40 && rect.top <= containerRect.top + 80) {
					syncActiveFileSilent(fileChange.filepath);
					break;
				}
			}
		}
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
				onclick={() => jumpToChunk('prev')}
				class="p-1 text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors cursor-pointer"
				title="Previous Hunk"
			>
				<ArrowUpIcon class="size-3.5" />
			</button>

			<!-- Next Hunk Button -->
			<button
				type="button"
				onmousedown={(e) => e.preventDefault()}
				onclick={() => jumpToChunk('next')}
				class="p-1 text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors cursor-pointer"
				title="Next Hunk"
			>
				<ArrowDownIcon class="size-3.5" />
			</button>
		</div>
	</div>

	<!-- Scrollable stacked Multibuffer Diffs -->
	<div
		bind:this={diffContainerEl}
		onscroll={handleContainerScroll}
		class="flex flex-col gap-2 flex-1 overflow-y-auto select-text bg-background"
	>
		{#if activeChanges.length === 0}
			<div class="flex flex-col items-center justify-center p-12 text-center text-muted-foreground h-full">
				<InfoIcon class="size-6 text-primary mb-2 opacity-80" />
				<p class="font-bold text-xs">No active diffs</p>
				<p class="text-[9px] opacity-75 mt-0.5">All modified changes committed.</p>
			</div>
		{:else}
			{#each activeChanges as fileChange (fileChange.filepath + '-' + fileChange.staged)}
				{@const isCollapsed = isFileCollapsed(fileChange.filepath)}
				{@const headerDoc = findSplitDoc(fileChange.filepath)}
				<div
					class="flex flex-col bg-background"
					id="diff-file-{fileChange.filepath}"
					onfocusin={() => { lastFocusedDiffFilepath = fileChange.filepath; }}
				>
					<!-- File Header inside multibuffer -->
					<div class="sticky top-0 z-10 bg-background pt-2 pb-1 px-2">
						<div
							role="button"
							tabindex="0"
							id="diff-header-{fileChange.filepath}"
							class="flex items-center rounded-lg justify-between px-3 py-1 bg-muted/40 hover:bg-muted/70 border border-border/80 hover:border-border select-none shrink-0 font-mono text-[10.5px] h-9 transition-all outline-none focus-visible:ring-2 focus-visible:ring-primary/80 focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:bg-muted/80 focus-visible:border-primary/60 cursor-pointer"
							onfocusin={() => syncActiveFileSilent(fileChange.filepath)}
							onclick={(e) => {
								syncActiveFileSilent(fileChange.filepath);
								if ((e.target as HTMLElement).closest('button, input, [role="checkbox"]')) return;
								toggleCollapse(fileChange.filepath);
							}}
							onkeydown={(e) => {
								if ((e.target as HTMLElement).closest('button, input, [role="checkbox"]')) return;
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
								{#if isDiffHeaderDirty(headerDoc)}
									<span
										class="inline-block size-1.5 rounded-full bg-foreground/60"
										title="Unsaved changes"
										aria-label="Unsaved changes"
									></span>
								{/if}
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
									<!-- Inline View: unified Working-copy editor over the shared Document -->
									{@const inlineDoc = findSplitDoc(fileChange.filepath)}
									<div class="flex-1 overflow-hidden bg-background">
										<div use:setupEditor={{
											content: resolveSplitRightContent(inlineDoc, diff.modifiedContent),
											originalContent: diff.originalContent,
											editable: isSplitWorkingCopyEditable(fileChange.status, inlineDoc),
											onDocChange: (text) => handleSplitDocChange(fileChange.filepath, text),
											filepath: fileChange.filepath,
											fileChange: effectiveChange,
											wrap: appState.prefs.wordWrap,
											hunks: diff.hunks,
											unstagedChunks: diff.unstagedChunks
										}}></div>
									</div>
								{:else}
									<!-- Split View: Side-by-side MergeView of the whole file.
									     Deleted files render the Original pane only (#272):
									     no working-copy surface, nothing to type into. -->
									{@const splitDoc = findSplitDoc(fileChange.filepath)}
									{#if isOriginalOnly(fileChange.status)}
										<div class="flex-1 overflow-hidden bg-background min-w-[800px]">
											<div use:setupEditor={{
											content: diff.originalContent,
											originalContent: diff.originalContent,
											editable: false,
											filepath: fileChange.filepath,
												fileChange: effectiveChange,
												wrap: appState.prefs.wordWrap,
												hunks: diff.hunks,
												unstagedChunks: diff.unstagedChunks,
												registerAs: 'split'
											}}></div>
										</div>
									{:else}
									<div class="flex-1 overflow-hidden bg-background min-w-[800px]">
										<div use:setupMergeView={{
											leftContent: diff.originalContent,
											rightContent: resolveSplitRightContent(splitDoc, diff.modifiedContent),
											filepath: fileChange.filepath,
											fileChange: effectiveChange,
											wrap: appState.prefs.wordWrap,
											hunks: diff.hunks,
											unstagedChunks: diff.unstagedChunks,
											editable: isSplitWorkingCopyEditable(fileChange.status, splitDoc),
											vimEnabled: appState.prefs.vimMode,
											docLanguage: splitDoc?.language ?? LanguageSupport.getLanguageForFile(fileChange.filepath),
											languageRevision: appState.plugins?.languageRevision,
											boundDoc: splitDoc,
											onDocChange: (text) => handleSplitDocChange(fileChange.filepath, text)
										}}></div>
									</div>
									{/if}
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
