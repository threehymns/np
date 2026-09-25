<script lang="ts">
	import { useAppState } from "@np/core/state.svelte";

	const appState = useAppState();

	import * as Menubar from "./components/ui/menubar/index";
	import * as AlertDialog from "./components/ui/alert-dialog/index";
	import favicon from "./assets/favicon.png";
	import { SidebarIcon, FolderOpenIcon } from "phosphor-svelte";
	import { Button } from "./components/ui/button";
	import * as Tooltip from "./components/ui/tooltip/index";
	import { ModeWatcher } from "mode-watcher";
	import { onMount, type Snippet } from "svelte";
	import { registerBundledPlugins, registerPluginUiLoader } from "./plugins/index";

	import type SettingsModalComponent from "./components/SettingsModal.svelte";
	import type CommandPaletteComponent from "./components/CommandPalette.svelte";
	import type WhichKeyComponent from "./components/WhichKey.svelte";

	let SettingsModal = $state<typeof SettingsModalComponent | null>(null);
	let CommandPalette = $state<typeof CommandPaletteComponent | null>(null);
	let WhichKey = $state<typeof WhichKeyComponent | null>(null);

	let { children } = $props<{ children: Snippet }>();

	let pendingDoc = $derived(appState.documents.find(d => d.id === appState.workspace.pendingCloseId));

	onMount(() => {
		const handleCaptureKeydown = (e: KeyboardEvent) => {
			if (appState.keymaps.handleKeydown(e)) {
				e.stopPropagation();
				e.preventDefault();
			}
		};
		const handleFocus = () => {
			if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
			if (appState.workspace.repository) {
				appState.workspace.repository.refresh().catch(e => console.error('[AppShell] Auto-refresh failed', e));
			}
			// Surface externally deleted open files (#175) with the same
			// deleted-on-disk tab state as in-app deletes, edits preserved.
			appState.workspace.reconcileExternalDeletions().catch(e => console.error('[AppShell] External-delete reconciliation failed', e));
		};
		window.addEventListener('keydown', handleCaptureKeydown, true);
		window.addEventListener('focus', handleFocus);

		// Persistence backends are async (IndexedDB, Electron IPC), so a flush
		// started in `beforeunload` may not finish before teardown. `pagehide`
		// and `visibilitychange` → hidden fire earlier and more reliably,
		// giving the save a head start; `beforeunload` stays as the last try.
		// On desktop the main-process before-quit handshake (see
		// apps/desktop) awaits the IPC save before flushing to disk, so this
		// remains a best-effort head start rather than the final guarantee.
		const flushSession = () => {
			appState.flushSaveOpenFiles().catch((e) => console.error('[AppShell] flushSaveOpenFiles failed', e));
		};
		const handleVisibilityChange = () => {
			if (typeof document === 'undefined') return;
			if (document.visibilityState === 'hidden') {
				flushSession();
			} else if (document.visibilityState === 'visible') {
				handleFocus();
			}
		};
		window.addEventListener('pagehide', flushSession);
		document.addEventListener('visibilitychange', handleVisibilityChange);
		window.addEventListener('beforeunload', flushSession);

		return () => {
			window.removeEventListener('keydown', handleCaptureKeydown, true);
			window.removeEventListener('focus', handleFocus);
			window.removeEventListener('pagehide', flushSession);
			document.removeEventListener('visibilitychange', handleVisibilityChange);
			window.removeEventListener('beforeunload', flushSession);
		};
	});

	onMount(async () => {
		try {
			registerBundledPlugins(appState.plugins);
			registerPluginUiLoader(appState.plugins);
			await appState.init();
		} catch (err) {
			console.error("[AppShell] Failed to initialize app state:", err);
		}

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
	});

	$effect(() => {
		const theme = appState.prefs.theme;
		const accent = appState.prefs.accentColor;
		const body = document.body;

		// Set theme data attribute
		if (theme === 'default') {
			delete body.dataset.theme;
		} else {
			body.dataset.theme = theme;
		}

		// Set accent data attribute
		if (accent === 'default') {
			delete body.dataset.accent;
		} else {
			body.dataset.accent = accent;
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
							{#each appState.commands.getByCategory('Format').filter(c => c.id !== 'format.toggleWordWrap') as command (command.id)}
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
							<Menubar.Item onclick={() => appState.commands.execute('settings.openConfigJson')}>
								Open Settings (JSON)
								{#if appState.keymaps.getShortcutForCommand('settings.openConfigJson')}
									<Menubar.Shortcut>{appState.keymaps.getShortcutForCommand('settings.openConfigJson')}</Menubar.Shortcut>
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
		{#snippet statusButton({ icon: Icon, class: btnClass, title, shortcut, onclick: onclickFn, badge }: {
			icon: typeof SidebarIcon;
			class: string;
			title: string;
			shortcut?: string | null;
			onclick: (e: MouseEvent) => void;
			badge?: number;
		})}
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Button
							variant="ghost"
							size="icon-xs"
							{...props}
							aria-label={title}
							onclick={(e) => {
								(props as any).onclick?.(e);
								onclickFn(e);
							}}
							class={btnClass}
						>
							<Icon class="size-3.5" />
							{#if badge}
								<span class="absolute -top-1 -right-1 min-w-3 h-3 bg-primary text-primary-foreground text-[7px] font-bold rounded-full flex items-center justify-center border border-background px-0.5 font-sans pointer-events-none">
									{badge}
								</span>
							{/if}
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content side="top" align="start" class="text-[10px] px-2 py-1">
					{title}{#if shortcut}<span class="text-[9px] opacity-60 ml-1">({shortcut})</span>{/if}
				</Tooltip.Content>
			</Tooltip.Root>
		{/snippet}
		<footer class="flex shrink-0 items-center justify-between border-t px-2 py-0.5 text-[11px] text-muted-foreground tabular-nums bg-background z-50">
			<div class="flex items-center gap-1">
				<Tooltip.Provider>
					{@render statusButton({
						icon: SidebarIcon,
						class: appState.prefs.sidebarVisible ? 'bg-accent text-accent-foreground' : '',
						title: 'Toggle Sidebar',
						shortcut: appState.keymaps.getShortcutForCommand('view.toggleSidebar') || '⌘\\',
						onclick: () => appState.prefs.sidebarVisible = !appState.prefs.sidebarVisible
					})}

					{@render statusButton({
						icon: FolderOpenIcon,
						class: `flex items-center justify-center hover:bg-accent/50 ${appState.prefs.sidebarVisible && appState.activeSidebarTab === 'explorer' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'}`,
						title: 'Project Explorer',
						shortcut: appState.keymaps.getShortcutForCommand('view.showExplorer'),
						onclick: () => {
							if (appState.activeSidebarTab === 'explorer' && appState.prefs.sidebarVisible) {
								appState.prefs.sidebarVisible = false;
							} else {
								appState.activeSidebarTab = 'explorer';
								appState.prefs.sidebarVisible = true;
							}
						}
					})}

					<!-- Contributed Sidebar Panels (including version-control panel when its plugin is active) -->
					{#each appState.plugins.getSidebarPanels() as panel (panel.id)}
						{@const PanelIcon = panel.icon}
						{@render statusButton({
							icon: PanelIcon ?? SidebarIcon,
							class: `flex items-center justify-center hover:bg-accent/50 ${appState.prefs.sidebarVisible && appState.activeSidebarTab === panel.id ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'}`,
							title: panel.title,
							shortcut: null,
							onclick: () => {
								if (appState.activeSidebarTab === panel.id && appState.prefs.sidebarVisible) {
									appState.prefs.sidebarVisible = false;
								} else {
									appState.activeSidebarTab = panel.id;
									appState.prefs.sidebarVisible = true;
								}
							}
						})}
					{/each}

					<!-- Contributed Left Status Bar Items -->
					{#each appState.plugins.getStatusBarItems('left') as item (item.id)}
						{@const ItemComponent = item.component}
						<ItemComponent {...(item.props ?? {})} />
					{/each}
				</Tooltip.Provider>
			</div>
			<div class="flex items-center gap-2">
				<!-- Contributed Right Status Bar Items -->
				{#each appState.plugins.getStatusBarItems('right') as item (item.id)}
					{@const ItemComponent = item.component}
					<ItemComponent {...(item.props ?? {})} />
				{/each}
				<span>
				  {appState.selection.line}:{appState.selection.column}
  				{#if appState.selection.charCount > 0}
    				({appState.selection.wordCount} words, {appState.selection.charCount} characters)
  				{/if}
				</span>
				<div class="h-3 w-px bg-border"></div>
				<div class="flex gap-4">
					<button
						type="button"
						class="font-medium text-foreground/80 hover:text-foreground cursor-pointer transition-colors"
						onclick={() => appState.commands.execute('edit.changeLanguageMode')}
					>
						{appState.activeDocument?.language?.name ?? 'Plain Text'}
					</button>
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
