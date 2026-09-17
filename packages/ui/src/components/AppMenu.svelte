<script lang="ts">
	import { flushSync, onMount, tick } from 'svelte';
	import { ListIcon } from 'phosphor-svelte';
	import { useAppState } from '@np/core/state.svelte';
	import * as Menubar from './ui/menubar/index';

	let { open = $bindable(false) }: { open?: boolean } = $props();
	const appState = useAppState();
	let category = $state('File');
	let hamburger = $state<HTMLButtonElement>();

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

<div class="flex h-9 min-w-0 items-center">
	<button
		{@attach (node) => { hamburger = node; }}
		type="button"
		hidden={open}
		aria-label="Application menu"
		aria-haspopup="menu"
		aria-expanded={open}
		aria-keyshortcuts={appState.keymaps.getShortcutForCommand('applicationMenu.toggle')}
		class="size-8 shrink-0 rounded-md hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1"
		onpointerdown={(event) => event.preventDefault()}
		onclick={toggle}
	>
		<ListIcon class="mx-auto size-4" />
	</button>
	<Menubar.Root
		hidden={!open}
		aria-label="Application menu"
		class="border-none bg-transparent p-0"
		value={open ? category : ''}
		onValueChange={changeValue}
		loop
	>
		{#each ['File', 'Edit', 'Format', 'View'] as name (name)}
			<Menubar.Menu value={name}>
				<Menubar.Trigger
					class="focus-visible:outline-2 focus-visible:outline-ring"
					onfocus={() => { if (open) category = name; }}
					onkeydown={handleTriggerKeydown}
				>{name}</Menubar.Trigger>
				<Menubar.Content
					class="max-w-[calc(100vw-1rem)] max-h-[var(--bits-menubar-content-available-height)] overflow-y-auto"
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
								class="max-w-[calc(100vw-1rem)]"
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
						<Menubar.CheckboxItem bind:checked={appState.prefs.wordWrap}>
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
								class="max-w-[calc(100vw-1rem)]"
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
