<script lang="ts">
	import { XIcon, ColumnsIcon, RowsIcon, InfoIcon, CaretRightIcon, CaretDownIcon, CaretUpDownIcon, ArrowUpIcon, ArrowDownIcon } from 'phosphor-svelte';
	import type { GitChange } from '@np/core';
	import { useAppState } from '@np/core/state.svelte';
	import { Checkbox } from './ui/checkbox';
	import { EditorView, lineNumbers, keymap } from "@codemirror/view";
	import { EditorState, Compartment, Text } from "@codemirror/state";
	import { syntaxHighlighting, foldedRanges } from "@codemirror/language";
	import { MergeView, unifiedMergeView, Chunk } from "@codemirror/merge";
	import { getLanguageExtensions, editorTheme, diffTheme, markdownHighlight, LanguageSupport } from '../editor/index';
	import Button from './ui/button/button.svelte';

	// Map to track active EditorView or MergeView per filepath
	let editorViews = new Map<string, { inline?: EditorView; split?: MergeView }>();
	let editorResolvers = new Map<string, Array<(views: { inline?: EditorView; split?: MergeView }) => void>>();

	function isAtBufferBoundary(view: EditorView, direction: 'down' | 'up'): boolean {
		const sel = view.state.selection.main;
		const doc = view.state.doc;
		const curLine = doc.lineAt(sel.head).number;

		const ranges = view.visibleRanges;
		if (!ranges || ranges.length === 0) {
			return direction === 'up' ? curLine <= 1 : curLine >= doc.lines;
		}

		if (direction === 'up') {
			const firstPos = ranges[0].from;
			const samplePos = Math.min(firstPos + 1, doc.length);
			const firstLine = doc.lineAt(samplePos).number;
			return curLine <= firstLine;
		} else {
			const lastPos = ranges[ranges.length - 1].to;
			const samplePos = Math.max(0, lastPos > 0 ? lastPos - 1 : 0);
			const lastLine = doc.lineAt(samplePos).number;
			return curLine >= lastLine;
		}
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

	async function navigateFromFileEditor(filepath: string, direction: 'down' | 'up', side: 'a' | 'b' = 'b') {
		const idx = activeChanges.findIndex((c) => c.filepath === filepath);
		if (idx === -1) return;

		const activeFile = repo?.activeDiffFile?.filepath;

		if (direction === 'down') {
			const nextFile = activeChanges[idx + 1];
			if (!nextFile) return;

			const isNextCollapsed = collapsedFiles[nextFile.filepath] ?? (activeFile ? (nextFile.filepath !== activeFile) : true);

			if (isNextCollapsed) {
				const header = document.getElementById(`diff-header-${nextFile.filepath}`);
				if (header) {
					header.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
					if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
					setTimeout(() => header.focus(), 0);
				}
			} else {
				const editor = await getOrWaitEditor(nextFile.filepath, viewMode, side);
				if (editor) {
					const firstPos = editor.visibleRanges[0]?.from ?? 0;
					const line1 = editor.state.doc.lineAt(Math.min(firstPos, editor.state.doc.length));
					editor.dispatch({
						selection: { anchor: line1.from, head: line1.from },
						effects: EditorView.scrollIntoView(line1.from, { y: 'center' })
					});
					if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
					setTimeout(() => editor.focus(), 0);
				}
			}
		} else {
			const prevFile = activeChanges[idx - 1];
			if (prevFile) {
				const isPrevCollapsed = collapsedFiles[prevFile.filepath] ?? (activeFile ? (prevFile.filepath !== activeFile) : true);

				if (isPrevCollapsed) {
					const header = document.getElementById(`diff-header-${prevFile.filepath}`);
					if (header) {
						header.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
						if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
						setTimeout(() => header.focus(), 0);
					}
				} else {
					const editor = await getOrWaitEditor(prevFile.filepath, viewMode, side);
					if (editor) {
						const lastRanges = editor.visibleRanges;
						const lastPos = lastRanges[lastRanges.length - 1]?.to ?? editor.state.doc.length;
						const samplePos = Math.max(0, lastPos > 0 ? lastPos - 1 : 0);
						const lastLine = editor.state.doc.lineAt(samplePos);
						editor.dispatch({
							selection: { anchor: lastLine.from, head: lastLine.from },
							effects: EditorView.scrollIntoView(lastLine.from, { y: 'center' })
						});
						if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
						setTimeout(() => editor.focus(), 0);
					}
				}
			} else {
				const currentHeader = document.getElementById(`diff-header-${filepath}`);
				if (currentHeader) {
					currentHeader.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
					if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
					setTimeout(() => currentHeader.focus(), 0);
				}
			}
		}
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
			wrap: boolean;
		}
	) {
		let view: EditorView | undefined;
		let currentOptions = options;
		const wrapCompartment = new Compartment();

		const langDesc = LanguageSupport.getLanguageForFile(options.filepath);
		getLanguageExtensions(langDesc).then((langExtensions) => {
			const state = EditorState.create({
				doc: currentOptions.content,
				extensions: [
					EditorState.readOnly.of(currentOptions.readOnly),
					unifiedMergeView({
						original: currentOptions.originalContent,
						collapseUnchanged: { margin: 3, minSize: 4 }
					}),
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

		const clickHandler = (event: MouseEvent) => {
			const target = event.target as HTMLElement;
			const gutterElement = target.closest('.cm-gutterElement');
			if (gutterElement && gutterElement.closest('.cm-lineNumbers')) {
				const lineNumText = gutterElement.textContent?.trim();
				if (lineNumText) {
					const lineNum = parseInt(lineNumText, 10);
					if (!isNaN(lineNum)) {
						openFileInRegularTab(currentOptions.filepath, lineNum);
					}
				}
			}
		};
		node.addEventListener('click', clickHandler);

		return {
			update(newOptions: typeof options) {
				const oldOptions = currentOptions;
				currentOptions = newOptions;
				if (view) {
					const currentDoc = view.state.doc.toString();
					if (currentOptions.content !== currentDoc) {
						view.dispatch({
							changes: {
								from: 0,
								to: view.state.doc.length,
								insert: currentOptions.content
							}
						});
					}
					if (currentOptions.wrap !== oldOptions.wrap) {
						view.dispatch({
							effects: wrapCompartment.reconfigure(
								currentOptions.wrap ? EditorView.lineWrapping : []
							)
						});
					}
				}
			},
			destroy() {
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
			wrap: boolean;
			onDocChange?: (newVal: string) => void;
		}
	) {
		let view: MergeView | undefined;
		let currentOptions = options;
		let cleanupSync: (() => void) | undefined;
		const wrapCompartmentA = new Compartment();
		const wrapCompartmentB = new Compartment();

		const langDesc = LanguageSupport.getLanguageForFile(options.filepath);
		getLanguageExtensions(langDesc).then((langExtensions) => {
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
				parent: node,
				orientation: "a-b",
				collapseUnchanged: { margin: 3, minSize: 4 }
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

		const clickHandler = (event: MouseEvent) => {
			const target = event.target as HTMLElement;
			const gutterElement = target.closest('.cm-gutterElement');
			if (gutterElement && gutterElement.closest('.cm-lineNumbers')) {
				const lineNumText = gutterElement.textContent?.trim();
				if (lineNumText) {
					const lineNum = parseInt(lineNumText, 10);
					if (!isNaN(lineNum)) {
						openFileInRegularTab(currentOptions.filepath, lineNum);
					}
				}
			}
		};
		node.addEventListener('click', clickHandler);

		return {
			update(newOptions: typeof options) {
				const oldOptions = currentOptions;
				currentOptions = newOptions;
				if (view) {
					const leftDoc = view.a.state.doc.toString();
					if (currentOptions.leftContent !== leftDoc) {
						view.a.dispatch({
							changes: {
								from: 0,
								to: view.a.state.doc.length,
								insert: currentOptions.leftContent
							}
						});
					}
					const rightDoc = view.b.state.doc.toString();
					if (currentOptions.rightContent !== rightDoc) {
						view.b.dispatch({
							changes: {
								from: 0,
								to: view.b.state.doc.length,
								insert: currentOptions.rightContent
							}
						});
					}
					if (currentOptions.wrap !== oldOptions.wrap) {
						view.a.dispatch({
							effects: wrapCompartmentA.reconfigure(
								currentOptions.wrap ? EditorView.lineWrapping : []
							)
						});
						view.b.dispatch({
							effects: wrapCompartmentB.reconfigure(
								currentOptions.wrap ? EditorView.lineWrapping : []
							)
						});
					}
				}
			},
			destroy() {
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

	function toggleCollapse(filepath: string) {
		const activeFile = repo?.activeDiffFile?.filepath;
		const current = collapsedFiles[filepath] ?? (activeFile ? (filepath !== activeFile) : true);
		collapsedFiles[filepath] = !current;
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

	// Active changes to render (single file or array of all files)
	let activeChanges = $derived(change ? [change] : changes);

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
		const activeFile = repo?.activeDiffFile?.filepath;
		activeChanges.forEach((change, fileIndex) => {
			const isCollapsed = collapsedFiles[change.filepath] ?? (activeFile ? (change.filepath !== activeFile) : true);
			if (isCollapsed) return; // Skip collapsed files from hunk navigation

			const origContent = change.originalContent || '';
			const modContent = change.modifiedContent || '';
			const origText = Text.of(origContent.split(/\r?\n/));
			const modText = Text.of(modContent.split(/\r?\n/));
			const chunks = Chunk.build(origText, modText);
			chunks.forEach((chunk, chunkIndex) => {
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

		const activeFile = repo?.activeDiffFile?.filepath;
		const isCollapsed = collapsedFiles[filepath] ?? (activeFile ? (filepath !== activeFile) : true);

		if (event.key === 'ArrowDown') {
			event.preventDefault();
			if (!isCollapsed) {
				const editor = await getOrWaitEditor(filepath, viewMode);
				if (editor) {
					const firstPos = editor.visibleRanges[0]?.from ?? 0;
					const line1 = editor.state.doc.lineAt(Math.min(firstPos, editor.state.doc.length));
					editor.dispatch({
						selection: { anchor: line1.from, head: line1.from },
						effects: EditorView.scrollIntoView(line1.from, { y: 'center' })
					});
					if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
					setTimeout(() => editor.focus(), 0);
				}
			} else {
				const nextFile = activeChanges[idx + 1];
				if (nextFile) {
					const nextHeader = document.getElementById(`diff-header-${nextFile.filepath}`);
					if (nextHeader) {
						nextHeader.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
						if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
						setTimeout(() => nextHeader.focus(), 0);
					}
				}
			}
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			const prevFile = activeChanges[idx - 1];
			if (prevFile) {
				const isPrevCollapsed = collapsedFiles[prevFile.filepath] ?? (activeFile ? (prevFile.filepath !== activeFile) : true);
				if (!isPrevCollapsed) {
					const editor = await getOrWaitEditor(prevFile.filepath, viewMode);
					if (editor) {
						const lastRanges = editor.visibleRanges;
						const lastPos = lastRanges[lastRanges.length - 1]?.to ?? editor.state.doc.length;
						const samplePos = Math.max(0, lastPos > 0 ? lastPos - 1 : 0);
						const lastLine = editor.state.doc.lineAt(samplePos);
						editor.dispatch({
							selection: { anchor: lastLine.from, head: lastLine.from },
							effects: EditorView.scrollIntoView(lastLine.from, { y: 'center' })
						});
						if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
						setTimeout(() => editor.focus(), 0);
					}
				} else {
					const prevHeader = document.getElementById(`diff-header-${prevFile.filepath}`);
					if (prevHeader) {
						prevHeader.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
						if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
						setTimeout(() => prevHeader.focus(), 0);
					}
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
			<Button
				variant=ghost
				size=icon-sm
				aria-label="Expand All Files"
				onclick={() => {
					for (const file of activeChanges) {
						collapsedFiles[file.filepath] = false;
					}
				}}
			>
				{#if Object.values(collapsedFiles).every((v) => v)}
					<CaretDownIcon class="h-4 w-4" />
				{:else}
					<CaretUpDownIcon class="h-4 w-4" />
				{/if}
			</Button>
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
				{@const activeFile = repo?.activeDiffFile?.filepath}
				{@const isCollapsed = collapsedFiles[fileChange.filepath] ?? (activeFile ? (fileChange.filepath !== activeFile) : true)}
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
						<div class="bg-muted/5 relative group">
							{#if viewMode === 'inline'}
								<!-- Inline View: Single Editor showing unified diff of the whole file -->
								<div class="flex-1 overflow-hidden bg-background">
									<div use:setupEditor={{
										content: fileChange.modifiedContent || '',
										originalContent: fileChange.originalContent || '',
										readOnly: false,
										filepath: fileChange.filepath,
										wrap: appState.prefs.wordWrap
									}}></div>
								</div>
							{:else}
								<!-- Split View: Side-by-side MergeView of the whole file -->
								<div class="flex-1 overflow-hidden bg-background min-w-[800px]">
									<div use:setupMergeView={{
										leftContent: fileChange.originalContent || '',
										rightContent: fileChange.modifiedContent || '',
										filepath: fileChange.filepath,
										wrap: appState.prefs.wordWrap
									}}></div>
								</div>
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		{/if}
	</div>
</div>
