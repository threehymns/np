<script lang="ts">
	import { useAppState } from "@np/core/state.svelte";

	const appState = useAppState();

	import * as Menubar from "./components/ui/menubar/index";
	import * as AlertDialog from "./components/ui/alert-dialog/index";
	import favicon from "./assets/favicon.png";
	import { SidebarIcon, FolderOpenIcon, GitMergeIcon } from "phosphor-svelte";
	import { Button } from "./components/ui/button";
	import * as Tooltip from "./components/ui/tooltip/index";
	import { ModeWatcher } from "mode-watcher";
	import { onMount, type Snippet } from "svelte";

	let SettingsModal = $state<any>(null);
	let CommandPalette = $state<any>(null);
	let WhichKey = $state<any>(null);

	let { children } = $props<{ children: Snippet }>();

	let pendingDoc = $derived(appState.documents.find(d => d.id === appState.workspace.pendingCloseId));

	onMount(() => {
		Promise.resolve(appState.init()).catch(err => {
			console.error("[AppShell] Failed to initialize app state:", err);
		});

		const handleCaptureKeydown = (e: KeyboardEvent) => {
			if (appState.keymaps.handleKeydown(e)) {
				e.stopPropagation();
				e.preventDefault();
			}
		};

		window.addEventListener('keydown', handleCaptureKeydown, true);

		// Lazy load secondary UI
		Promise.all([
			import("./components/SettingsModal.svelte"),
			import("./components/CommandPalette.svelte"),
			import("./components/WhichKey.svelte")
		]).then(([settingsMod, commandMod, whichKeyMod]) => {
			SettingsModal = settingsMod.default;
			CommandPalette = commandMod.default;
			WhichKey = whichKeyMod.default;
		}).catch(err => {
			console.error("[AppShell] Failed to load secondary UI components:", err);
		});

		return () => {
			window.removeEventListener('keydown', handleCaptureKeydown, true);
		};
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
</script>



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
									{#if appState.keymaps.getShortcutForCommand(command.id)}
										<Menubar.Shortcut>{appState.keymaps.getShortcutForCommand(command.id)}</Menubar.Shortcut>
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
											{#if appState.keymaps.getShortcutForCommand(command.id)}
												<Menubar.Shortcut>{appState.keymaps.getShortcutForCommand(command.id)}</Menubar.Shortcut>
											{/if}
										</Menubar.Item>
									{/each}
								</Menubar.SubContent>
							</Menubar.Sub>
						{:else if category === 'Format'}
							<Menubar.CheckboxItem bind:checked={appState.prefs.wordWrap}>
								Word Wrap
								{#if appState.keymaps.getShortcutForCommand('format.toggleWordWrap')}
									<Menubar.Shortcut>{appState.keymaps.getShortcutForCommand('format.toggleWordWrap')}</Menubar.Shortcut>
								{/if}
							</Menubar.CheckboxItem>
						{:else if category === 'View'}
							<Menubar.Sub>
								<Menubar.SubTrigger>Zoom</Menubar.SubTrigger>
								<Menubar.SubContent>
									{#each appState.commands.getByCategory('View').filter(c => c.id.startsWith('view.zoom')) as command (command.id)}
										<Menubar.Item onclick={() => command.action()}>
											{command.label}
											{#if appState.keymaps.getShortcutForCommand(command.id)}
												<Menubar.Shortcut>{appState.keymaps.getShortcutForCommand(command.id)}</Menubar.Shortcut>
											{/if}
										</Menubar.Item>
									{/each}
								</Menubar.SubContent>
							</Menubar.Sub>
							<Menubar.CheckboxItem bind:checked={appState.prefs.statusBar}>
								Status Bar
								{#if appState.keymaps.getShortcutForCommand('view.toggleStatusBar')}
									<Menubar.Shortcut>{appState.keymaps.getShortcutForCommand('view.toggleStatusBar')}</Menubar.Shortcut>
								{/if}
							</Menubar.CheckboxItem>
							<Menubar.CheckboxItem bind:checked={appState.prefs.sidebarVisible}>
								Sidebar
								{#if appState.keymaps.getShortcutForCommand('view.toggleSidebar')}
									<Menubar.Shortcut>{appState.keymaps.getShortcutForCommand('view.toggleSidebar')}</Menubar.Shortcut>
								{/if}
							</Menubar.CheckboxItem>
						{:else}
							{#each appState.commands.getByCategory(category) as command (command.id)}
								<Menubar.Item
									onclick={() => command.action()}
									disabled={command.isEnabled && !command.isEnabled()}
								>
									{command.label}
									{#if appState.keymaps.getShortcutForCommand(command.id)}
										<Menubar.Shortcut>{appState.keymaps.getShortcutForCommand(command.id)}</Menubar.Shortcut>
									{/if}
								</Menubar.Item>
							{/each}
						{/if}

						{#if category === 'Edit'}
							<Menubar.Separator />
							<Menubar.Item onclick={() => appState.settingsOpen = true}>
								Settings...
								{#if appState.keymaps.getShortcutForCommand('settings.open')}
									<Menubar.Shortcut>{appState.keymaps.getShortcutForCommand('settings.open')}</Menubar.Shortcut>
								{/if}
							</Menubar.Item>
						{/if}
					</Menubar.Content>
				</Menubar.Menu>
			{/each}
		</Menubar.Root>
	</div>

	<main class="flex-1 min-h-0 relative z-0 overflow-hidden">
		{@render children()}
	</main>

	{#if appState.prefs.statusBar}
		<footer class="flex shrink-0 items-center justify-between border-t px-2 py-0.5 text-[11px] text-muted-foreground tabular-nums bg-background/80 backdrop-blur-md z-50">
			<div class="flex items-center gap-1">
			<Tooltip.Provider>
					<Tooltip.Root>
						<Tooltip.Trigger>
							{#snippet child({ props })}
								<Button
									variant="ghost"
									size="icon-xs"
									{...props}
									onclick={(e) => {
										(props as any).onclick?.(e);
										appState.prefs.sidebarVisible = !appState.prefs.sidebarVisible;
									}}
									class={appState.prefs.sidebarVisible ? 'bg-accent text-accent-foreground' : ''}
								>
									<SidebarIcon class="size-3.5" />
								</Button>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content side="top" align="start" class="text-[10px] px-2 py-1">
							Toggle Sidebar <span class="text-[9px] opacity-60 ml-1">({appState.keymaps.getShortcutForCommand('view.toggleSidebar') || '⌘\\'})</span>
						</Tooltip.Content>
					</Tooltip.Root>

					<Tooltip.Root>
						<Tooltip.Trigger>
							{#snippet child({ props })}
								<Button
									variant="ghost"
									size="icon-xs"
									{...props}
									onclick={(e) => {
										(props as any).onclick?.(e);
										if (appState.activeSidebarTab === 'explorer' && appState.prefs.sidebarVisible) {
											appState.prefs.sidebarVisible = false;
										} else {
											appState.activeSidebarTab = 'explorer';
											appState.prefs.sidebarVisible = true;
										}
									}}
									class="flex items-center justify-center hover:bg-accent/50 {appState.prefs.sidebarVisible && appState.activeSidebarTab === 'explorer' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'}"
								>
									<FolderOpenIcon class="size-3.5" />
								</Button>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content side="top" align="start" class="text-[10px] px-2 py-1">
							Project Explorer{#if appState.keymaps.getShortcutForCommand('view.showExplorer')}<span class="text-[9px] opacity-60 ml-1">({appState.keymaps.getShortcutForCommand('view.showExplorer')})</span>{/if}
						</Tooltip.Content>
					</Tooltip.Root>

					<Tooltip.Root>
						<Tooltip.Trigger>
							{#snippet child({ props })}
								<Button
									variant="ghost"
									size="icon-xs"
									{...props}
									onclick={(e) => {
										(props as any).onclick?.(e);
										if (appState.activeSidebarTab === 'git' && appState.prefs.sidebarVisible) {
											appState.prefs.sidebarVisible = false;
										} else {
											appState.activeSidebarTab = 'git';
											appState.prefs.sidebarVisible = true;
										}
									}}
									class="flex items-center justify-center relative hover:bg-accent/50 {appState.prefs.sidebarVisible && appState.activeSidebarTab === 'git' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'}"
								>
									<GitMergeIcon class="size-3.5" />
									{#if (appState.workspace.repository?.changes?.length ?? 0) > 0}
										<span class="absolute -top-1 -right-1 min-w-3 h-3 bg-primary text-primary-foreground text-[7px] font-bold rounded-full flex items-center justify-center border border-background px-0.5 font-sans pointer-events-none">
											{appState.workspace.repository?.changes.length}
										</span>
									{/if}
								</Button>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content side="top" align="start" class="text-[10px] px-2 py-1">
							Source Control{#if appState.keymaps.getShortcutForCommand('view.showGit')}<span class="text-[9px] opacity-60 ml-1">({appState.keymaps.getShortcutForCommand('view.showGit')})</span>{/if}
						</Tooltip.Content>
					</Tooltip.Root>
				</Tooltip.Provider>

				<div class="flex gap-3 opacity-80 ml-2">
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

{#if CommandPalette}
	<CommandPalette />
{/if}

{#if WhichKey}
	<WhichKey />
{/if}

{#if SettingsModal}
	<SettingsModal bind:open={appState.settingsOpen} />
{/if}

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
