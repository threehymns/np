<script lang="ts">
	import { untrack } from "svelte";
	import { EditorView } from "@codemirror/view";
	import { EditorState, Compartment, Annotation, EditorSelection, Transaction, type SelectionRange } from "@codemirror/state";
	import { historyField } from "@codemirror/commands";
	import { createEditorExtensions, getLanguageExtensions, selectionState, setupVimClipboardSync, syncVimRegistersFromClipboard } from '../editor/index.js';
	import { vim } from "@replit/codemirror-vim";

	import '../editor/styles/editor.css';
	import '../editor/styles/markdown.css';
	import '../editor/styles/tables.css';

	import { DocumentSession, useAppState } from '@np/core';
	import { Vim, CodeMirror, getCM } from "@replit/codemirror-vim";

	let {
		doc,
		active = true,
		style = "",
		wrap = true,
		view = $bindable(),
	} = $props<{
		doc: DocumentSession;
		active?: boolean;
		style?: string;
		wrap?: boolean;
		view?: EditorView;
	}>();

	const appState = useAppState();
	let editorEl = $state<HTMLDivElement>();
	let altPressed = $state(false);
	const wrapCompartment = new Compartment();
	const languageCompartment = new Compartment();
	const vimCompartment = new Compartment();
	const syncAnnotation = Annotation.define<boolean>();

	function clampSelection(sel: EditorSelection, len: number): EditorSelection {
		return EditorSelection.create(
			sel.ranges.map((r: SelectionRange) =>
				EditorSelection.range(Math.min(r.anchor, len), Math.min(r.head, len)),
			),
			sel.mainIndex,
		);
	}

	function syncSelectionStats(state: EditorState): void {
		const selection = state.selection.main;
		const line = state.doc.lineAt(selection.head);
		const lineNum = line.number;
		const colNum = selection.head - line.from + 1;
		if (selection.empty) {
			selectionState.update(lineNum, colNum, 0, 0);
		} else {
			const selectedText = state.doc.sliceString(selection.from, selection.to);
			selectionState.update(
				lineNum,
				colNum,
				selectedText.length,
				selectedText.trim().split(/\s+/).filter(Boolean).length,
			);
		}
	}

	$effect(() => {
		if (!editorEl) return;

		let isDestroyed = false;

		getLanguageExtensions(untrack(() => doc.language)).then((initialExtensions) => {
			if (isDestroyed || !editorEl) return;

			const extensions = [
				...createEditorExtensions({
					wrapCompartment,
					languageCompartment,
					vimCompartment,
					wrap,
					vimEnabled: untrack(() => appState.prefs.vimMode),
					initialLanguageExtensions: initialExtensions,
				}),
				EditorView.updateListener.of((update) => {
					if (
						update.docChanged &&
						!update.transactions.some((tr) =>
							tr.annotation(syncAnnotation),
						)
					) {
						const newContent = update.state.doc.toString();
						if (newContent !== doc.content) {
							doc.content = newContent;
						}
					}

					if (update.selectionSet || update.docChanged) {
						syncSelectionStats(update.state);
					}
				}),
			];

			let startState: EditorState | undefined;
			const savedState = untrack(() => doc.editorState);
			const currentContent = untrack(() => doc.content);
			if (savedState) {
				try {
					let restored = EditorState.fromJSON(
						savedState,
						{ extensions },
						{ history: historyField },
					);
					if (restored.doc.toString() !== currentContent) {
						restored = restored.update({
							changes: { from: 0, to: restored.doc.length, insert: currentContent },
							selection: clampSelection(restored.selection, currentContent.length),
							annotations: Transaction.addToHistory.of(false),
						}).state;
					}
					startState = restored;
				} catch {
					// Corrupt serialized state falls through to a fresh editor below.
				}
			}
			startState ??= EditorState.create({
				doc: currentContent,
				extensions,
			});

			view = new EditorView({
				state: startState,
				parent: editorEl,
			});

			if (doc.scrollPosition) {
				view.scrollDOM.scrollTop = doc.scrollPosition.top;
				view.scrollDOM.scrollLeft = doc.scrollPosition.left;
				requestAnimationFrame(() => {
					if (view && doc.scrollPosition) {
						view.scrollDOM.scrollTop = doc.scrollPosition.top;
						view.scrollDOM.scrollLeft = doc.scrollPosition.left;
					}
				});
			}
		});

		return () => {
			isDestroyed = true;
			if (view) {
				doc.editorState = view.state.toJSON({ history: historyField });
				doc.scrollPosition = {
					top: view.scrollDOM.scrollTop,
					left: view.scrollDOM.scrollLeft,
				};
				view.destroy();
				view = undefined;
			}
		};
	});

	// Sync active state and layout (status bar isn't refreshed by the
	// updateListener on remount, since creating a view fires no update event)
	$effect(() => {
		if (view && active) {
			view.requestMeasure();
			syncSelectionStats(view.state);
		}
	});

	// Sync wrap setting
	$effect(() => {
		if (view && active) {
			view.dispatch({
				effects: wrapCompartment.reconfigure(
					wrap ? EditorView.lineWrapping : [],
				),
			});
		}
	});

	// Sync vim setting
	$effect(() => {
		const vimEnabled = appState.prefs.vimMode;
		if (view && active) {
			view.dispatch({
				effects: vimCompartment.reconfigure(
					vimEnabled ? vim() : [],
				),
			});
		}
	});

	// Sync keymap context
	$effect(() => {
		if (!active) return;

		appState.keymaps.setContext("editor", true);
		
		if (!appState.prefs.vimMode) {
			appState.keymaps.setContext("vim_mode", undefined);
			return;
		}

		// Initial set
		appState.keymaps.setContext("vim_mode", "normal");
		
		if (!view) return;

		const cm = getCM(view);
		if (!cm) return;

		const updateMode = (args: any) => {
			appState.keymaps.setContext("vim_mode", args.mode);
		};

		cm.on("vim-mode-change", updateMode);
		
		return () => {
			cm.off("vim-mode-change", updateMode);
		};
	});

	// Also sync mode when view changes or vim is toggled
	$effect(() => {
		if (view && active && appState.prefs.vimMode) {
			const cm = getCM(view);
			if (cm) {
				appState.keymaps.setContext("vim_mode", (cm as any).state.vim?.insertMode ? "insert" : (cm as any).state.vim?.visualMode ? "visual" : "normal");
			}
		}
	});

	// Sync vim clipboard setting
	$effect(() => {
		const vimEnabled = appState.prefs.vimMode;
		const syncClipboard = appState.prefs.vimSyncClipboard;
		setupVimClipboardSync(vimEnabled && syncClipboard);
	});

	function handleFocusOrKey() {
		if (appState.prefs.vimMode && appState.prefs.vimSyncClipboard) {
			void syncVimRegistersFromClipboard();
		}
	}

	// Sync language
	$effect(() => {
		const lang = doc.language;
		if (view && active) {
			getLanguageExtensions(lang).then((extensions) => {
				if (view) {
					view.dispatch({
						effects: languageCompartment.reconfigure(extensions),
					});
				}
			});
		}
	});

	// Sync content from outside (e.g. file open or disk reload)
	$effect(() => {
		const c = doc.content; // Track content
		if (!active) return;

		untrack(() => {
			if (view) {
				const currentDoc = view.state.doc.toString();
				if (c !== currentDoc) {
					const clampedSelection = clampSelection(view.state.selection, c.length);
					const prevScrollTop = view.scrollDOM.scrollTop;
					const prevScrollLeft = view.scrollDOM.scrollLeft;

					view.dispatch({
						changes: {
							from: 0,
							to: view.state.doc.length,
							insert: c,
						},
						selection: clampedSelection,
						annotations: [syncAnnotation.of(true), Transaction.addToHistory.of(false)],
					});

					view.scrollDOM.scrollTop = prevScrollTop;
					view.scrollDOM.scrollLeft = prevScrollLeft;
				}
			}
		});
	});

	// Handle pending line scroll
	$effect(() => {
		const lineNum = doc.pendingLineToScroll;
		if (view && active && lineNum !== null) {
			untrack(() => {
				doc.pendingLineToScroll = null;
			});
			// Wait a tick for editor rendering to ensure DOM and dimensions are correct
			const timer = setTimeout(() => {
				if (!view) return;
				try {
					const lineCount = view.state.doc.lines;
					const targetLine = Math.max(1, Math.min(lineNum, lineCount));
					const line = view.state.doc.line(targetLine);
					view.dispatch({
						selection: { anchor: line.from },
						scrollIntoView: true,
					});
					view.focus();
				} catch (e) {
					console.error("Failed to scroll/select line", e);
				}
			}, 50);
			return () => {
				clearTimeout(timer);
			};
		}
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
	role="region"
	aria-label="Code Editor"
	class="editor-wrapper {style}"
	class:alt-pressed={altPressed}
	data-testid="editor-input"
	onfocusin={handleFocusOrKey}
	onkeydown={handleFocusOrKey}
>
	{#if doc.permissionState !== 'granted'}
		<div class="permission-overlay">
			<div class="permission-card">
				<p class="text-sm font-medium mb-4">Restore access to this file to start editing.</p>
				<button 
					class="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 transition-colors"
					onclick={() => doc.requestPermission()}
				>
					Grant Access
				</button>
			</div>
		</div>
	{/if}
</div>

<style>
	.editor-wrapper {
		position: relative;
		height: 100%;
		display: flex;
		flex-direction: column;
	}

	:global(.cm-scroller) {
		scrollbar-width: thin;
		scrollbar-color: var(--border) transparent;
	}

	:global(.cm-scroller::-webkit-scrollbar) {
		width: 10px;
	}

	:global(.cm-scroller::-webkit-scrollbar-track) {
		background: transparent;
	}

	:global(.cm-scroller::-webkit-scrollbar-thumb) {
		background-color: var(--border);
		border-radius: 5px;
		border: 2px solid transparent;
		background-clip: content-box;
		transition: background-color 0.2s;
	}

	:global(.cm-scroller::-webkit-scrollbar-thumb:hover) {
		background-color: var(--muted-foreground);
	}

	.permission-overlay {
		position: absolute;
		inset: 0;
		background: hsl(var(--background) / 0.8);
		backdrop-filter: blur(4px);
		z-index: 50;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.permission-card {
		background: hsl(var(--background));
		padding: 2rem;
		border-radius: 0.75rem;
		border: 1px solid hsl(var(--border));
		box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
		text-align: center;
		max-width: 320px;
	}
</style>