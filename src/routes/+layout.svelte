<script lang="ts">
	import "$lib/polyfills";
	import "./layout.css";
	import * as Menubar from "$lib/components/ui/menubar/index.js";
	import * as AlertDialog from "$lib/components/ui/alert-dialog/index.js";
	import favicon from "$lib/assets/favicon.png";
	import { X, Sidebar } from "phosphor-svelte";
	import { Button } from "$lib/components/ui/button";
	import * as Tooltip from "$lib/components/ui/tooltip/index.js";

	import { setContext } from "svelte";
	import { AppState } from "$lib/state.svelte.js";
	import { MultiSchemeStorage } from "$lib/storage";
	import { IsomorphicGitAdapter } from "$lib/project/isomorphic-git";
	import type { Theme, AppearanceMode } from "$lib/preferences.svelte";
	import SettingsModal from "$lib/components/SettingsModal.svelte";
	import CommandPalette from "$lib/components/CommandPalette.svelte";
	import { ModeWatcher } from "mode-watcher";
	import { onMount } from "svelte";

	const storage = new MultiSchemeStorage();
	const vcsFactory = (rootHandle: FileSystemDirectoryHandle) => new IsomorphicGitAdapter(rootHandle);
	const appState = new AppState({ storage, vcsFactory });
	setContext("appState", appState);

	if (typeof window !== "undefined") {
		(window as any).appState = appState;
	}

	let { children } = $props();
	let settingsOpen = $state(false);

	let pendingDoc = $derived(appState.documents.find(d => d.id === appState.workspace.pendingCloseId));

	onMount(async () => {
		await appState.init();
	});

	$effect(() => {
		const theme = appState.prefs.theme;
		const accent = appState.prefs.accentColor;
		const body = document.body;

		// Set theme data attribute
		if (theme === 'default') {
			body.removeAttribute('data-theme');
		} else {
			body.setAttribute('data-theme', theme);
		}

		// Set accent data attribute
		if (accent === 'default') {
			body.removeAttribute('data-accent');
		} else {
			body.setAttribute('data-accent', accent);
		}
	});

	function handleKeydown(e: KeyboardEvent) {
		if (appState.commands.handleKeydown(e)) return;

		if ((e.metaKey || e.ctrlKey) && e.key === ',') {
			e.preventDefault();
			settingsOpen = true;
		}
	}

	function formatShortcut(shortcut?: string) {
		if (!shortcut) return '';
		const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0;
		return shortcut
			.replace('cmd', isMac ? '⌘' : 'Ctrl')
			.replace('shift', '⇧')
			.replace('alt', '⌥')
			.toUpperCase();
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>{appState.activeDocument?.fileName || 'Untitled'}{appState.activeDocument?.isModified ? '*' : ''} - Notepad</title>
</svelte:head>

<ModeWatcher />

<div class="flex flex-col h-screen w-screen bg-background text-foreground transition-colors duration-300 overflow-hidden">
	<div class="relative z-50 shrink-0 bg-background flex items-center justify-between px-2 pr-4" class:border-b={appState.documents.length > 1}>
		<Menubar.Root class="border-none bg-transparent p-0">
			{#each ['File', 'Edit', 'Format', 'View'] as category (category)}
				<Menubar.Menu>
					<Menubar.Trigger>{category}</Menubar.Trigger>
					<Menubar.Content>
						{#if category === 'File'}
							{#each appState.commands.getByCategory('File') as command (command.id)}
								<Menubar.Item 
									onclick={() => command.action()}
									disabled={command.isEnabled && !command.isEnabled()}
								>
									{command.label}
									{#if command.shortcut}
										<Menubar.Shortcut>{formatShortcut(command.shortcut)}</Menubar.Shortcut>
									{/if}
								</Menubar.Item>
							{/each}
							<Menubar.Separator />
							<Menubar.Sub>
								<Menubar.SubTrigger>Export</Menubar.SubTrigger>
								<Menubar.SubContent>
									{#each appState.commands.getByCategory('Export') as command (command.id)}
										<Menubar.Item 
											onclick={() => command.action()}
											disabled={command.isEnabled && !command.isEnabled()}
										>
											{command.label}
											{#if command.shortcut}
												<Menubar.Shortcut>{formatShortcut(command.shortcut)}</Menubar.Shortcut>
											{/if}
										</Menubar.Item>
									{/each}
								</Menubar.SubContent>
							</Menubar.Sub>
						{:else if category === 'Format'}
							<Menubar.CheckboxItem bind:checked={appState.prefs.wordWrap}>Word Wrap</Menubar.CheckboxItem>
						{:else if category === 'View'}
							<Menubar.Sub>
								<Menubar.SubTrigger>Zoom</Menubar.SubTrigger>
								<Menubar.SubContent>
									<Menubar.Item onclick={() => appState.prefs.zoomIn()}>Zoom In <Menubar.Shortcut>⌘+</Menubar.Shortcut></Menubar.Item>
									<Menubar.Item onclick={() => appState.prefs.zoomOut()}>Zoom Out <Menubar.Shortcut>⌘-</Menubar.Shortcut></Menubar.Item>
									<Menubar.Item onclick={() => appState.prefs.resetZoom()}>Restore Default Zoom <Menubar.Shortcut>⌘0</Menubar.Shortcut></Menubar.Item>
								</Menubar.SubContent>
							</Menubar.Sub>
							<Menubar.CheckboxItem bind:checked={appState.prefs.statusBar}>Status Bar</Menubar.CheckboxItem>
							<Menubar.CheckboxItem bind:checked={appState.prefs.sidebarVisible}>
								Sidebar
								<Menubar.Shortcut>{formatShortcut('cmd+\\')}</Menubar.Shortcut>
							</Menubar.CheckboxItem>
						{:else}
							{#each appState.commands.getByCategory(category) as command (command.id)}
								<Menubar.Item 
									onclick={() => command.action()}
									disabled={command.isEnabled && !command.isEnabled()}
								>
									{command.label}
									{#if command.shortcut}
										<Menubar.Shortcut>{formatShortcut(command.shortcut)}</Menubar.Shortcut>
									{/if}
								</Menubar.Item>
							{/each}
						{/if}

						{#if category === 'Edit'}
							<Menubar.Separator />
							<Menubar.Item onclick={() => settingsOpen = true}>
								Settings... <Menubar.Shortcut>{formatShortcut('cmd+,')}</Menubar.Shortcut>
							</Menubar.Item>
						{/if}
					</Menubar.Content>
				</Menubar.Menu>
			{/each}
		</Menubar.Root>
	</div>
	
	<main class="flex-1 min-h-0 overflow-auto relative z-0">
		{@render children()}
	</main>

	{#if appState.prefs.statusBar}
		<footer class="flex shrink-0 items-center justify-between border-t px-2 py-0.5 text-[11px] text-muted-foreground tabular-nums bg-background/80 backdrop-blur-md z-50">
			<div class="flex items-center gap-3">
				<Tooltip.Provider delayDuration={400}>
					<Tooltip.Root>
						<Tooltip.Trigger>
							{#snippet child({ props })}
								<Button variant="ghost" size="icon-xs" {...props} onclick={() => appState.prefs.sidebarVisible = !appState.prefs.sidebarVisible} class={appState.prefs.sidebarVisible ? 'bg-accent text-accent-foreground' : ''}>
									<Sidebar class="size-3.5" />
								</Button>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content side="top" align="start" class="text-[10px] px-2 py-1">
							Toggle Sidebar <span class="text-[9px] opacity-60 ml-1">({formatShortcut('cmd+\\')})</span>
						</Tooltip.Content>
					</Tooltip.Root>
				</Tooltip.Provider>
				<div class="flex gap-3 opacity-80">
					<span>{appState.activeDocument?.wordCount ?? 0} words</span>
					<span>{appState.activeDocument?.charCount ?? 0} chars</span>
				</div>
				{#if appState.selection.charCount > 0}
					<div class="h-3 w-px bg-border/50"></div>
					<div class="flex gap-3 text-primary animate-in fade-in slide-in-from-left-2 duration-300">
						<span class="font-medium">{appState.selection.wordCount} selected words</span>
						<span class="font-medium">{appState.selection.charCount} selected chars</span>
					</div>
				{/if}
			</div>
			<div class="flex items-center gap-4 opacity-80">
				<div class="flex gap-4">
					<span>Ln {appState.selection.line}, Col {appState.selection.column}</span>
				</div>
				<div class="h-3 w-px bg-border/50"></div>
				<div class="flex gap-4">
					<span>{appState.prefs.zoom}%</span>
					<button 
						type="button"
						class="font-medium text-foreground/80 hover:text-foreground cursor-pointer transition-colors"
						onclick={() => appState.commands.execute('edit.changeLanguageMode')}
					>
						{appState.activeDocument?.language?.name ?? 'Plain Text'}
					</button>
					<span>{appState.prefs.lineEnding}</span>
					<span>{appState.prefs.encoding}</span>
				</div>
			</div>
		</footer>
	{/if}
</div>

<CommandPalette />
<SettingsModal bind:open={settingsOpen} />

<AlertDialog.Root open={!!appState.workspace.pendingCloseId} onOpenChange={(open) => { if (!open) appState.workspace.pendingCloseId = null; }}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Do you want to save changes to {pendingDoc?.fileName}?</AlertDialog.Title>
			<AlertDialog.Description>
				Your changes will be lost if you don't save them.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action onclick={() => appState.finalizeClose(appState.workspace.pendingCloseId!, false)} class="bg-destructive text-destructive-foreground hover:bg-destructive/90">
				Don't Save
			</AlertDialog.Action>
			<AlertDialog.Action onclick={() => appState.finalizeClose(appState.workspace.pendingCloseId!, true)}>
				Save
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
