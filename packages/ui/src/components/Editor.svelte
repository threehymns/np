<script lang="ts">
	import { untrack, tick } from "svelte";
	import { EditorView } from "@codemirror/view";
	import { EditorState, Compartment, Annotation, EditorSelection, Transaction, type SelectionRange } from "@codemirror/state";
	import { historyField } from "@codemirror/commands";
	import { createEditorExtensions, getLanguageExtensions, resolveActiveLanguage, selectionState, setupVimClipboardSync, syncVimRegistersFromClipboard, workspaceFacet, currentDocFacet, minimalTextChange, completionCompartmentExtensions, readAutomaticCompletions, readBufferWordSettings, readServerCompletionSettings, readServerHoverSettings } from '../editor/index.js';
	import { vim } from "@replit/codemirror-vim";
	import '../editor/styles/editor.css';
	import '../editor/styles/markdown.css';
	import '../editor/styles/tables.css';

	import { DocumentSession, useAppState, reconfigureEditorContributions } from '@np/core';
	import { COMPLETION_COORDINATOR_SERVICE_KEY, COMPLETION_RESOLVE_SERVICE_KEY, HOVER_COORDINATOR_SERVICE_KEY, type CompletionCoordinator, type CompletionQuery, type CompletionResolveCoordinator, type HoverCoordinator } from '@np/core';
	import { Vim, CodeMirror, getCM } from "@replit/codemirror-vim";
	import { applyEditorWrap, claimEditorFocusedContext, claimEditorKeymapContexts } from "./editor-focus";

	let {
		doc,
		active = true,
		focused = true,
		style = "",
		wrap = true,
		view = $bindable(),
		paneId,
	} = $props<{
		doc: DocumentSession;
		/**
		 * Whether this editor is live: mounted, visible, and kept in sync with
		 * its document. Every rendered editor is live, so a cloned view in
		 * another pane shows the edits made in the pane that has focus.
		 */
		active?: boolean;
		/**
		 * Whether this editor is the one the user is typing in. The
		 * focus-sensitive state (word wrap, vim mode, and the global keymap
		 * contexts) belongs to the focused editor alone, because the keymap
		 * contexts are global and a second owner would take the focused
		 * editor's keybindings with it.
		 */
		focused?: boolean;
		style?: string;
		wrap?: boolean;
		view?: EditorView;
		paneId?: string;
	}>();

	const appState = useAppState();
	let editorEl = $state<HTMLDivElement>();
	let altPressed = $state(false);
	let pendingScrollGen = 0;
	let completionChainGen = 0;
	const wrapCompartment = new Compartment();
	const languageCompartment = new Compartment();
	// Sits after the language compartment so word completions append to the note
	// sources it registers, and so it can also carry `autocompletion()`: the
	// global popup toggle has to reach the language-provided sources, which are
	// not reachable per source.
	const completionCompartment = new Compartment();
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
				workspaceFacet.of(appState.workspace),
				currentDocFacet.of(doc),
				...createEditorExtensions({
					wrapCompartment,
					languageCompartment,
					completionCompartment,
					vimCompartment,
					editorCompartments: appState.plugins?.editorCompartments,
					pluginContributions: appState.plugins?.getEditorContributions?.() ?? [],
					language: untrack(() => doc.language?.name),
					gutterCompartment: appState.plugins?.editorCompartments?.gutterCompartment,
					decorationsCompartment: appState.plugins?.editorCompartments?.decorationsCompartment,
					keybindingsCompartment: appState.plugins?.editorCompartments?.keybindingsCompartment,
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
							appState.workspace.updateDocumentContent(doc, newContent);
						}
					}

					// The selection stats are global (the status bar reads
					// them), so only the focused editor reports them. A
					// clone in another pane syncs its content on every
					// keystroke, and its cursor would otherwise take the
					// status bar over from the editor the user is typing
					// in.
					if (focused && (update.selectionSet || update.docChanged)) {
						syncSelectionStats(update.state);
					}
				}),
			];

			let startState: EditorState | undefined;
			const savedState = untrack(() => (paneId ? doc.getViewState(paneId).editorState : doc.editorState));
			const currentContent = untrack(() => doc.content);
			if (savedState) {
				try {
					let restored = EditorState.fromJSON(
						savedState,
						{ extensions },
						{ history: historyField },
					);
					if (restored.doc.toString() !== currentContent) {
						// Minimal hunk so the restored undo history survives the
						// content catch-up instead of being mapped away (#271).
						const catchUp = minimalTextChange(restored.doc.toString(), currentContent);
						restored = restored.update({
							changes: catchUp ?? { from: 0, to: restored.doc.length, insert: currentContent },
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

			appState.plugins?.attachEditorInternal(doc.id, {
				getState: () => view!.state,
				dispatch: (spec) => view!.dispatch(spec as any)
			}, untrack(() => doc.language?.name), paneId);

			const initialScroll = paneId ? doc.getViewState(paneId).scrollPosition : doc.scrollPosition;
			if (initialScroll) {
				view.scrollDOM.scrollTop = initialScroll.top;
				view.scrollDOM.scrollLeft = initialScroll.left;
				requestAnimationFrame(() => {
					if (view && initialScroll) {
						view.scrollDOM.scrollTop = initialScroll.top;
						view.scrollDOM.scrollLeft = initialScroll.left;
					}
				});
			}
		});

		return () => {
			isDestroyed = true;
			appState.plugins?.detachEditorInternal(doc.id, paneId);
			if (view) {
				const serialized = view.state.toJSON({ history: historyField });
				const scroll = {
					top: view.scrollDOM.scrollTop,
					left: view.scrollDOM.scrollLeft,
				};
				if (paneId) {
					doc.setViewState(paneId, {
						editorState: serialized,
						scrollPosition: scroll,
					});
				} else {
					doc.editorState = serialized;
					doc.scrollPosition = scroll;
				}
				view.destroy();
				view = undefined;
			}
		};
	});

	// Sync the focused editor's layout and selection stats (the status bar
	// isn't refreshed by the updateListener on remount, since creating a view
	// fires no update event). Only the focused editor owns the stats: they
	// describe the editor the user is in.
	$effect(() => {
		if (view && focused) {
			view.requestMeasure();
			syncSelectionStats(view.state);
		}
	});

	// Sync wrap setting
	$effect(() => {
		applyEditorWrap(view, { focused, wrap, compartment: wrapCompartment });
	});

	// Sync vim setting. Only the focused editor runs vim mode: the vim
	// extension keeps its own state (the mode, the registers), so it is
	// installed as the focus moves rather than left running in a pane the
	// user is not typing in.
	$effect(() => {
		const vimEnabled = appState.prefs.vimMode;
		if (view && focused) {
			view.dispatch({
				effects: vimCompartment.reconfigure(
					vimEnabled ? vim() : [],
				),
			});
		}
	});

	// Sync plugin editor contributions when contributions or language change
	$effect(() => {
		const plugins = appState.plugins;
		if (!view || !plugins?.editorCompartments) return;

		// Reactively observe editor revision
		const _rev = plugins.editorRevision;
		const language = doc.language?.name;

		const effects = reconfigureEditorContributions(
			plugins.getEditorContributions?.() ?? [],
			plugins.editorCompartments,
			language,
		);
		view.dispatch({ effects });
	});

	// Sync keymap context. The contexts are global, so only the focused
	// editor claims them: an editor in another pane of a split claims
	// nothing, because it would clear the focused editor's contexts when it
	// let go.
	$effect(() => {
		return claimEditorKeymapContexts(appState.keymaps, {
			focused,
			vimEnabled: appState.prefs.vimMode,
			cm: view ? getCM(view) : null,
		});
	});

	// Sync the editorFocused context: the editor truly has focus. A hover
	// tooltip never takes focus, so a tooltip text selection reads here as
	// "unfocused" and falls through to native copy instead of being hijacked
	// into edit.copy of a collapsed editor selection. Movement within the
	// editor (content to search panel) keeps the context: only leaving the
	// editor root clears it.
	//
	// Only the focused editor owns this context, the same way it owns the
	// "editor" and "vim_mode" contexts. In a split, every pane renders a live
	// editor, and a second owner would clear the focused editor's context the
	// moment it let go.
	$effect(() => {
		return claimEditorFocusedContext(appState.keymaps, {
			focused,
			root: view?.dom,
			activeElement: () =>
				typeof document === "undefined" ? null : document.activeElement,
		});
	});

	// Also sync mode when view changes or vim is toggled
	$effect(() => {
		if (view && focused && appState.prefs.vimMode) {
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

	// Sync language. Reads the language revision alongside doc.language so
	// registry changes rebuild the compartment even when the resolved
	// description reference is unchanged (e.g. enabling Svelte while a
	// Markdown doc is open must refresh its fenced-language list).
	$effect(() => {
		const _langRev = appState.plugins?.languageRevision;
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

	// Sync the completion chain. It lives in its own compartment after the
	// language one because a source registered there appends to the language's
	// own autocomplete chain rather than replacing it (`override` would drop
	// the table and wikilink sources). Reads the language revision with
	// doc.language for the same reason the language compartment above does, the
	// settings revision because the global popup toggle lives in
	// `autocompletion({ activateOnTyping })` — the only lever that reaches the
	// language-provided sources — and `prefs.vimMode` because the modal
	// keymap (`Ctrl-y` instead of Enter) lives in the same compartment. The
	// snippet revision so enabling, disabling or refreshing a plugin pack
	// rebuilds the chain instead of leaving the previous triggers behind. The
	// word and server sources read their own settings per query, so a
	// per-language override needs no reconfiguration of its own.
	$effect(() => {
		const _langRev = appState.plugins?.languageRevision;
		const _settingsRev = appState.prefs.settingsVersion;
		const _snippetRev = appState.plugins?.snippetRevision;
		const vimEnabled = appState.prefs.vimMode;
		const lang = doc.language;
		const languageName = lang?.name ?? null;
		// The source filters the whole registry itself, so handing it every
		// registered snippet is one read rather than a read plus a filter that
		// says the same thing.
		const snippets = appState.plugins?.getSnippets() ?? [];
		// Whoever can answer a completion query publishes itself under one generic
		// key (ADR 0008); a language server is the first such provider. Absent —
		// on web, or while the providing plugin is disabled — is the same "nothing
		// can answer here" answer a language nothing serves gives, so the chain
		// carries no provider source and words behave exactly as they did before.
		// The shell names no provider, because it does not need to know which one is
		// answering.
		const completionCoordinator = appState.plugins?.getService<CompletionCoordinator>(
			COMPLETION_COORDINATOR_SERVICE_KEY
		);
		const hoverCoordinator = appState.plugins?.getService<HoverCoordinator>(
			HOVER_COORDINATOR_SERVICE_KEY
		);
		const resolveCoordinator = appState.plugins?.getService<CompletionResolveCoordinator>(
			COMPLETION_RESOLVE_SERVICE_KEY
		);
		if (view && active) {
			const readSetting = (namespace: string, key: string) =>
				appState.prefs.get(namespace, key);
			// Language loading is async, so two runs can be in flight at once.
			// The generation makes the loser a no-op instead of letting it land
			// last and hand the editor back the previous language's chain.
			const gen = ++completionChainGen;
			const targetView = view;
			resolveActiveLanguage(lang).then((language) => {
				if (gen !== completionChainGen || targetView !== view) return;
				targetView.dispatch({
					effects: completionCompartment.reconfigure(
						completionCompartmentExtensions({
							language,
							languageName,
							snippets,
							vimEnabled,
							automaticCompletions: readAutomaticCompletions(readSetting),
							readSettings: () =>
								readBufferWordSettings(readSetting, languageName),
							server: completionCoordinator
								? {
										fetch: (query: CompletionQuery) => completionCoordinator.fetch(query),
										resolve: resolveCoordinator
											? (item, document) => resolveCoordinator.resolveItem(item, document)
											: undefined,
										runCommand: resolveCoordinator
											? (command, args, document) =>
													resolveCoordinator.runCommand(command, args, document)
											: undefined,
										readSettings: () =>
											readServerCompletionSettings(readSetting, languageName),
										readTriggerCharacters: () =>
											completionCoordinator.triggerCharacters?.() ?? [],
									}
								: null,
								hover: hoverCoordinator
									? {
											fetchHover: (query) => hoverCoordinator.fetchHover(query),
											readSettings: () =>
												readServerHoverSettings(readSetting, languageName),
											fetchTimeoutMs:
												readServerCompletionSettings(readSetting, languageName).fetchTimeoutMs ||
												undefined,
										}
									: null,
						}),
					),
				});
			});
		}
	});

	// Sync content from outside (e.g. file open or disk reload).
	// Runs for inactive panes too so cloned views stay live.
	$effect(() => {
		const c = doc.content; // Track content

		untrack(() => {
			if (view) {
				const currentDoc = view.state.doc.toString();
				if (c !== currentDoc) {
					const clampedSelection = clampSelection(view.state.selection, c.length);
					const prevScrollTop = view.scrollDOM.scrollTop;
					const prevScrollLeft = view.scrollDOM.scrollLeft;

					// Minimal hunk so diff-pane keystrokes echoed here map
					// through (rather than wipe) this view's undo history:
					// independent stacks over the shared text (#271).
					const syncChange = minimalTextChange(currentDoc, c);
					view.dispatch({
						changes: syncChange ?? {
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

	// Handle pending line scroll. Only the focused editor follows it: the
	// jump is the user's, and it lands in the editor they are looking at.
	$effect(() => {
		const lineNum = (paneId ? doc.peekViewState(paneId)?.pendingLineToScroll : null) ?? doc.pendingLineToScroll;
		if (view && focused && lineNum !== null) {
			const targetView = view;
			const colNum = doc.pendingColumn ?? 1;
			const matchLen = doc.pendingMatchLength ?? 0;
			untrack(() => {
				if (paneId) {
					doc.setViewState(paneId, { pendingLineToScroll: null });
				}
				doc.pendingLineToScroll = null;
				doc.pendingColumn = null;
				doc.pendingMatchLength = null;
			});
			const gen = ++pendingScrollGen;
			// Wait a tick for editor rendering to ensure DOM and dimensions are correct
			void tick().then(() => {
				if (gen !== pendingScrollGen) return;
				if (!targetView || targetView !== view) return;
				try {
					const lineCount = targetView.state.doc.lines;
					const targetLine = Math.max(1, Math.min(lineNum, lineCount));
					const line = targetView.state.doc.line(targetLine);
					const anchor = Math.min(line.to, line.from + Math.max(0, colNum - 1));
					const head = matchLen > 0 ? Math.min(line.to, anchor + matchLen) : anchor;
					targetView.dispatch({
						selection: { anchor, head },
						scrollIntoView: true,
					});
					targetView.focus();
				} catch (e) {
					console.error("Failed to scroll/select line", e);
				}
			});
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

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (CodeMirror parent container delegates focus and key handling for clipboard sync) -->
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
					onclick={() => appState.workspace.requestFilePermission(doc)}
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
