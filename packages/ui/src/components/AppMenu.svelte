<script lang="ts">
	import { flushSync, onMount, tick } from 'svelte';
	import { ListIcon } from 'phosphor-svelte';
	import { useAppState } from '@np/core/state.svelte';
	import { cn } from '@np/core';
	import * as Menubar from './ui/menubar/index';
	import Button, { type ButtonSize } from './ui/button/button.svelte';

	let { open = $bindable(false), size = 'default' }: { open?: boolean; size?: ButtonSize } = $props();
	const appState = useAppState();
	let category = $state('File');
	let hamburger = $state<HTMLButtonElement | null>(null);

	function changeValue(value: string) {
		if (value) category = value;
		open = !!value;
	}

	async function dismiss() {
		open = false;
		await tick();
		hamburger?.focus();
	}

	function toggle() {
		if (open) {
			void dismiss();
		} else {
			category = 'File';
			open = true;
		}
	}

	function execute(action: () => unknown) {
		flushSync(() => { open = false; });
		return action();
	}

	function interactOutside(event: PointerEvent) {
		const target = event.target;
		if (target instanceof Element && target.closest('[role="menubar"], [role="menu"]')) return;
		if (open) flushSync(() => { open = false; });
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Tab') {
			event.preventDefault();
			void dismiss();
		}
	}

	function handleTriggerKeydown(event: KeyboardEvent) {
		handleKeydown(event);
		if (['Escape', 'Enter', ' '].includes(event.key)) {
			event.preventDefault();
			void dismiss();
		}
	}

	const CATEGORIES = ['File', 'Edit', 'Format', 'View'];

	function handleSubmenuKeydown(event: KeyboardEvent) {
		handleKeydown(event);
		if (event.key !== 'ArrowRight') return;
		event.preventDefault();
		event.stopPropagation();
		category = CATEGORIES[(CATEGORIES.indexOf(category) + 1) % CATEGORIES.length];
	}

	onMount(() => {
		const controller = { toggle };
		appState.applicationMenu = controller;
		return () => {
			if (appState.applicationMenu === controller) appState.applicationMenu = undefined;
		};
	});
</script>

<svelte:window onpointerdowncapture={interactOutside} />

<div class={cn("flex min-w-0 items-center")}>
	<Button
		type="button"
		hidden={open}
		aria-label="Application menu"
		aria-haspopup="menu"
		aria-expanded={open}
		aria-keyshortcuts={appState.keymaps.getShortcutForCommand('applicationMenu.toggle')}
		onpointerdown={(event) => event.preventDefault()}
		onclick={toggle}
		variant="ghost"
		size="icon-xs"
		bind:ref={hamburger}
	>
		<ListIcon />
	</Button>
	<Menubar.Root
		hidden={!open}
		aria-label="Application menu"
		class={cn("border-none! bg-transparent p-0 h-8 items-center")}
		value={open ? category : ''}
		onValueChange={changeValue}
		loop
	>
		{#each CATEGORIES as name (name)}
			<Menubar.Menu value={name}>
				<Menubar.Trigger
					class={cn("focus-visible:outline-2 focus-visible:outline-ring")}
					onfocus={() => { if (open) category = name; }}
					onkeydown={handleTriggerKeydown}
				>{name}</Menubar.Trigger>
				<Menubar.Content
					onpointerdown={(event) => event.preventDefault()}
					onEscapeKeydown={() => void dismiss()}
					onCloseAutoFocus={(event) => event.preventDefault()}
					onkeydown={handleKeydown}
				>
					{#if name === 'File'}
						{#each appState.commands.getByCategory('File') as command (command.id)}
							<Menubar.Item onclick={() => execute(command.action)} disabled={command.isEnabled && !command.isEnabled()}>
								{command.label}
								{#if appState.keymaps.getShortcutForCommand(command.id)}
									<Menubar.Shortcut>{appState.keymaps.getShortcutForCommand(command.id)}</Menubar.Shortcut>
								{/if}
							</Menubar.Item>
						{/each}
						<Menubar.Separator />
						<Menubar.Sub>
							<Menubar.SubTrigger>Export</Menubar.SubTrigger>
							<Menubar.Portal>
							<Menubar.SubContent
								escapeKeydownBehavior="close"
								onkeydown={handleSubmenuKeydown}
								onpointerdown={(event) => event.preventDefault()}
							>
								{#each appState.commands.getByCategory('Export') as command (command.id)}
									<Menubar.Item onclick={() => execute(command.action)} disabled={command.isEnabled && !command.isEnabled()}>
										{command.label}
										{#if appState.keymaps.getShortcutForCommand(command.id)}
											<Menubar.Shortcut>{appState.keymaps.getShortcutForCommand(command.id)}</Menubar.Shortcut>
										{/if}
									</Menubar.Item>
								{/each}
							</Menubar.SubContent>
							</Menubar.Portal>
						</Menubar.Sub>
					{:else if name === 'Format'}
						{#each appState.commands.getByCategory('Format').filter(c => c.id !== 'format.toggleWordWrap') as command (command.id)}
							<Menubar.Item onclick={() => execute(command.action)} disabled={command.isEnabled && !command.isEnabled()}>
								{command.label}
								{#if appState.keymaps.getShortcutForCommand(command.id)}
									<Menubar.Shortcut>{appState.keymaps.getShortcutForCommand(command.id)}</Menubar.Shortcut>
								{/if}
							</Menubar.Item>
						{/each}
						<Menubar.Separator />
						<Menubar.CheckboxItem bind:checked={appState.prefs.wordWrap} onclick={() => void dismiss()}>
							Word Wrap
							{#if appState.keymaps.getShortcutForCommand('format.toggleWordWrap')}
								<Menubar.Shortcut>{appState.keymaps.getShortcutForCommand('format.toggleWordWrap')}</Menubar.Shortcut>
							{/if}
						</Menubar.CheckboxItem>
					{:else if name === 'View'}
						<Menubar.Sub>
							<Menubar.SubTrigger>Zoom</Menubar.SubTrigger>
							<Menubar.Portal>
							<Menubar.SubContent
								escapeKeydownBehavior="close"
								onkeydown={handleSubmenuKeydown}
								onpointerdown={(event) => event.preventDefault()}
							>
								{#each appState.commands.getByCategory('View').filter(c => c.id.startsWith('view.zoom')) as command (command.id)}
									<Menubar.Item onclick={() => execute(command.action)}>
										{command.label}
										{#if appState.keymaps.getShortcutForCommand(command.id)}
											<Menubar.Shortcut>{appState.keymaps.getShortcutForCommand(command.id)}</Menubar.Shortcut>
										{/if}
									</Menubar.Item>
								{/each}
							</Menubar.SubContent>
							</Menubar.Portal>
						</Menubar.Sub>
						<Menubar.CheckboxItem bind:checked={appState.prefs.statusBar} onclick={() => void dismiss()}>
							Status Bar
							{#if appState.keymaps.getShortcutForCommand('view.toggleStatusBar')}
								<Menubar.Shortcut>{appState.keymaps.getShortcutForCommand('view.toggleStatusBar')}</Menubar.Shortcut>
							{/if}
						</Menubar.CheckboxItem>
						<Menubar.CheckboxItem bind:checked={appState.prefs.sidebarVisible} onclick={() => void dismiss()}>
							Sidebar
							{#if appState.keymaps.getShortcutForCommand('view.toggleSidebar')}
								<Menubar.Shortcut>{appState.keymaps.getShortcutForCommand('view.toggleSidebar')}</Menubar.Shortcut>
							{/if}
						</Menubar.CheckboxItem>
					{:else}
						{#each appState.commands.getByCategory(name) as command (command.id)}
							<Menubar.Item onclick={() => execute(command.action)} disabled={command.isEnabled && !command.isEnabled()}>
								{command.label}
								{#if appState.keymaps.getShortcutForCommand(command.id)}
									<Menubar.Shortcut>{appState.keymaps.getShortcutForCommand(command.id)}</Menubar.Shortcut>
								{/if}
							</Menubar.Item>
						{/each}
					{/if}
					{#if name === 'Edit'}
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
