<script lang="ts">
	import { untrack } from "svelte";
	import { EditorView } from "codemirror";
	import { EditorState, Compartment, Annotation } from "@codemirror/state";
	import { appState } from "$lib/state.svelte.js";
	import { createEditorExtensions } from "$lib/editor";

	import "$lib/editor/styles/editor.css";
	import "$lib/editor/styles/markdown.css";
	import "$lib/editor/styles/tables.css";

	import { DocumentSession } from "$lib/document.svelte";

	let {
		doc,
		style = "",
		wrap = true,
		view = $bindable(),
	} = $props<{
		doc: DocumentSession;
		style?: string;
		wrap?: boolean;
		view?: EditorView;
	}>();

	let editorEl = $state<HTMLDivElement>();
	let altPressed = $state(false);
	const wrapCompartment = new Compartment();
	const syncAnnotation = Annotation.define<boolean>();

	$effect(() => {
		if (!editorEl) return;

		const startState = EditorState.create({
			doc: untrack(() => doc.content),
			extensions: [
				...createEditorExtensions({ wrapCompartment, wrap }),
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

						appState.line = line.number;
						appState.column = selection.head - line.from + 1;

						if (selection.empty) {
							appState.selectionCharCount = 0;
							appState.selectionWordCount = 0;
						} else {
							const selectedText = state.doc.sliceString(
								selection.from,
								selection.to,
							);
							appState.selectionCharCount = selectedText.length;
							appState.selectionWordCount = selectedText
								.trim()
								.split(/\s+/)
								.filter(Boolean).length;
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
		const c = doc.content; // Track content
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
