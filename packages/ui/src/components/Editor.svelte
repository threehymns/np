<script lang="ts">
	import { untrack } from "svelte";
	import { EditorView } from "codemirror";
	import { EditorState, Compartment, Annotation } from "@codemirror/state";
	import { createEditorExtensions, getLanguageExtensions, selectionState } from '../editor';

	import '../editor/styles/editor.css';
	import '../editor/styles/markdown.css';
	import '../editor/styles/tables.css';

	import { DocumentSession } from '@np/core';

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

	let editorEl = $state<HTMLDivElement>();
	let altPressed = $state(false);
	const wrapCompartment = new Compartment();
	const languageCompartment = new Compartment();
	const syncAnnotation = Annotation.define<boolean>();

	$effect(() => {
		if (!editorEl) return;

		let isDestroyed = false;

		getLanguageExtensions(untrack(() => doc.language)).then((initialExtensions) => {
			if (isDestroyed || !editorEl) return;

			const startState = EditorState.create({
				doc: untrack(() => doc.content),
				extensions: [
					...createEditorExtensions({
						wrapCompartment,
						languageCompartment,
						wrap,
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
							const state = update.state;
							const selection = state.selection.main;
							const line = state.doc.lineAt(selection.head);

							const lineNum = line.number;
							const colNum = selection.head - line.from + 1;

							if (selection.empty) {
								selectionState.update(lineNum, colNum, 0, 0);
							} else {
								const selectedText = state.doc.sliceString(
									selection.from,
									selection.to,
								);
								const charCount = selectedText.length;
								const wordCount = selectedText
									.trim()
									.split(/\s+/)
									.filter(Boolean).length;
								selectionState.update(lineNum, colNum, charCount, wordCount);
							}
						}
					}),
				],
			});

			view = new EditorView({
				state: startState,
				parent: editorEl,
			});
		});

		return () => {
			isDestroyed = true;
			view?.destroy();
			view = undefined;
		};
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

	// Sync content from outside (e.g. file open)
	$effect(() => {
		const c = doc.content; // Track content
		if (!active) return;

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
