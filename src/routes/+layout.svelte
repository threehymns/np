<script lang="ts">
	import "./layout.css";
	import * as Menubar from "$lib/components/ui/menubar/index.js";
	import * as AlertDialog from "$lib/components/ui/alert-dialog/index.js";
	import favicon from "$lib/assets/favicon.png";

	import { appState } from "$lib/state.svelte.js";
	import { undo, redo, selectAll } from "@codemirror/commands";
	import { openSearchPanel } from "@codemirror/search";

	let { children } = $props();

	let pendingDoc = $derived(appState.documents.find(d => d.id === appState.pendingCloseId));

	function handleKeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key === 's') {
			e.preventDefault();
			appState.saveFile();
		}
		if ((e.metaKey || e.ctrlKey) && e.key === 'o') {
			e.preventDefault();
			appState.openFile();
		}
		if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
			e.preventDefault();
			appState.newFile();
		}
	}

	function execKey(key: string, shift = false) {
		if (appState.activeEditorView) {
			appState.activeEditorView.focus();
		}
		const target = document.activeElement || document.body;
		target.dispatchEvent(new KeyboardEvent('keydown', {
			key,
			code: `Key${key.toUpperCase()}`,
			ctrlKey: true,
			metaKey: true,
			shiftKey: shift,
			bubbles: true,
			cancelable: true
		}));
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>{appState.activeDocument?.fileName || 'Untitled'}{appState.activeDocument?.isModified ? '*' : ''} - Notepad</title>
</svelte:head>

<div class="flex flex-col h-screen w-screen bg-background">
	<div class="relative z-50">
		<Menubar.Root>
			<Menubar.Menu>
				<Menubar.Trigger>File</Menubar.Trigger>
				<Menubar.Content>
					<Menubar.Item onclick={() => appState.newFile()}>
						New <Menubar.Shortcut>⌘N</Menubar.Shortcut>
					</Menubar.Item>
					<Menubar.Item onclick={() => appState.openFile()}>
						Open... <Menubar.Shortcut>⌘O</Menubar.Shortcut>
					</Menubar.Item>
					<Menubar.Item onclick={() => appState.saveFile()}>
						Save <Menubar.Shortcut>⌘S</Menubar.Shortcut>
					</Menubar.Item>
					<Menubar.Item onclick={() => appState.saveFileAs()}>Save As...</Menubar.Item>
				</Menubar.Content>
			</Menubar.Menu>
			<Menubar.Menu>
				<Menubar.Trigger>Edit</Menubar.Trigger>
				<Menubar.Content>
					<Menubar.Item onclick={() => appState.activeEditorView && undo(appState.activeEditorView)}>
						Undo <Menubar.Shortcut>⌘Z</Menubar.Shortcut>
					</Menubar.Item>
					<Menubar.Item onclick={() => appState.activeEditorView && redo(appState.activeEditorView)}>
						Redo <Menubar.Shortcut>⇧⌘Z</Menubar.Shortcut>
					</Menubar.Item>
					<Menubar.Separator />
					<Menubar.Item onclick={() => { appState.activeEditorView?.focus(); document.execCommand('cut'); }}>
						Cut <Menubar.Shortcut>⌘X</Menubar.Shortcut>
					</Menubar.Item>
					<Menubar.Item onclick={() => { appState.activeEditorView?.focus(); document.execCommand('copy'); }}>
						Copy <Menubar.Shortcut>⌘C</Menubar.Shortcut>
					</Menubar.Item>
					<Menubar.Item onclick={async () => { 
						appState.activeEditorView?.focus(); 
						try {
							const text = await navigator.clipboard.readText();
							if (appState.activeEditorView) {
								const view = appState.activeEditorView;
								view.dispatch(view.state.replaceSelection(text));
							}
						} catch (e) {
							document.execCommand('paste');
						}
					}}>
						Paste <Menubar.Shortcut>⌘V</Menubar.Shortcut>
					</Menubar.Item>
					<Menubar.Separator />
					<Menubar.Item onclick={() => appState.activeEditorView && openSearchPanel(appState.activeEditorView)}>
						Find... <Menubar.Shortcut>⌘F</Menubar.Shortcut>
					</Menubar.Item>
					<Menubar.Item onclick={() => appState.activeEditorView && selectAll(appState.activeEditorView)}>
						Select All <Menubar.Shortcut>⌘A</Menubar.Shortcut>
					</Menubar.Item>
				</Menubar.Content>
			</Menubar.Menu>
			<Menubar.Menu>
				<Menubar.Trigger>Format</Menubar.Trigger>
				<Menubar.Content>
					<Menubar.CheckboxItem bind:checked={appState.prefs.wordWrap}>Word Wrap</Menubar.CheckboxItem>
				</Menubar.Content>
			</Menubar.Menu>
			<Menubar.Menu>
				<Menubar.Trigger>View</Menubar.Trigger>
				<Menubar.Content>
					<Menubar.Sub>
						<Menubar.SubTrigger>Zoom</Menubar.SubTrigger>
						<Menubar.SubContent>
							<Menubar.Item onclick={() => appState.prefs.zoomIn()}>Zoom In <Menubar.Shortcut>⌘+</Menubar.Shortcut></Menubar.Item>
							<Menubar.Item onclick={() => appState.prefs.zoomOut()}>Zoom Out <Menubar.Shortcut>⌘-</Menubar.Shortcut></Menubar.Item>
							<Menubar.Item onclick={() => appState.prefs.resetZoom()}>Restore Default Zoom <Menubar.Shortcut>⌘0</Menubar.Shortcut></Menubar.Item>
						</Menubar.SubContent>
					</Menubar.Sub>
					<Menubar.CheckboxItem bind:checked={appState.prefs.statusBar}>Status Bar</Menubar.CheckboxItem>
				</Menubar.Content>
			</Menubar.Menu>
		</Menubar.Root>
	</div>
	<main class="flex-1 min-h-0 overflow-visible">{@render children()}</main>
	{#if appState.prefs.statusBar}
		<footer class="flex shrink-0 items-center justify-between border-t px-4 py-1 text-xs text-muted-foreground tabular-nums">
			<div>{appState.activeDocument?.isModified ? 'Modified' : 'Saved'}</div>
			<div class="flex gap-4">
				<span>Characters: {appState.charCount}</span>
				<span>Ln {appState.line}, Col {appState.column}</span>
				<span>{appState.prefs.zoom}%</span>
				<span>{appState.prefs.lineEnding}</span>
				<span>{appState.prefs.encoding}</span>
			</div>
		</footer>
	{/if}
</div>

<AlertDialog.Root open={!!appState.pendingCloseId} onOpenChange={(open) => { if (!open) appState.pendingCloseId = null; }}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Do you want to save changes to {pendingDoc?.fileName}?</AlertDialog.Title>
			<AlertDialog.Description>
				Your changes will be lost if you don't save them.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action onclick={() => appState.finalizeClose(appState.pendingCloseId!, false)} class="bg-destructive text-destructive-foreground hover:bg-destructive/90">
				Don't Save
			</AlertDialog.Action>
			<AlertDialog.Action onclick={() => appState.finalizeClose(appState.pendingCloseId!, true)}>
				Save
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
