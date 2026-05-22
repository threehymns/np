<script lang="ts">
	import * as Command from "$lib/components/ui/command";
	import { useAppState } from "$lib/state.svelte";
	import { ArrowLeft } from "phosphor-svelte";
	import Icon from "$lib/components/Icon.svelte";

	const appState = useAppState();

	let inputValue = $state("");

	$effect(() => {
		function handleKeydown(e: KeyboardEvent) {
			if ((e.metaKey || e.ctrlKey) && e.key === "p") {
				e.preventDefault();
				appState.commandPalette.open = !appState.commandPalette.open;
			}
		}

		window.addEventListener("keydown", handleKeydown);
		return () => window.removeEventListener("keydown", handleKeydown);
	});

	$effect(() => {
		if (!appState.commandPalette.open) {
			appState.commandPalette.reset();
			inputValue = "";
		}
	});

	function executeCommand(id: string) {
		appState.commands.execute(id);
		if (!appState.commandPalette.items) {
			appState.commandPalette.open = false;
		}
		inputValue = "";
	}

	function handleInputKeydown(e: KeyboardEvent) {
		if (e.key === "Backspace" && inputValue === "") {
			e.preventDefault();
			appState.commandPalette.goBack();
		}
	}

	function formatShortcut(shortcut?: string) {
		if (!shortcut) return "";
		const isMac = typeof navigator !== "undefined" && navigator.platform.toUpperCase().indexOf("MAC") >= 0;
		return shortcut
			.replace("cmd", isMac ? "⌘" : "Ctrl")
			.replace("shift", "⇧")
			.replace("alt", "⌥")
			.toUpperCase();
	}
</script>

<Command.Dialog bind:open={appState.commandPalette.open}>
	<div class="relative flex items-center w-full">
		{#if appState.commandPalette.items && appState.commandPalette.items.length > 0}
			<button 
				type="button"
				class="absolute left-3 flex items-center justify-center h-5 w-5 rounded-sm hover:bg-accent text-muted-foreground transition-colors cursor-pointer"
				onclick={() => {
					appState.commandPalette.goBack();
					inputValue = "";
				}}
				aria-label="Go back"
			>
				<ArrowLeft class="h-3.5 w-3.5" />
			</button>
		{/if}
		<div class="w-full" class:pl-8={appState.commandPalette.items && appState.commandPalette.items.length > 0}>
			<Command.Input 
				placeholder={appState.commandPalette.placeholder} 
				bind:value={inputValue}
				onkeydown={handleInputKeydown}
			/>
		</div>
	</div>
	<Command.List>
		<Command.Empty>No results found.</Command.Empty>
		{#if appState.commandPalette.items}
			{#if appState.commandPalette.title}
				<div class="px-2 py-1.5 text-xs font-semibold text-muted-foreground">{appState.commandPalette.title}</div>
			{/if}
			{#each appState.commandPalette.items as item}
				<Command.Item
					onSelect={() => {
						item.action();
						inputValue = "";
					}}
					disabled={item.disabled}
				>
					<div class="flex items-center gap-2.5 w-full">
						{#if item.icon}
							{@const iconValue = typeof item.icon === 'string' ? appState.icons.getLanguageIcon(item.icon) : item.icon}
							<Icon 
								icon={iconValue} 
								class="h-4 w-4 shrink-0 {item.iconClass || 'text-muted-foreground'}" 
							/>
						{/if}
						<span class="font-medium text-sm flex-1">{item.label}</span>
						{#if item.meta}
							<span class="text-xs text-muted-foreground/60">{item.meta}</span>
						{/if}
						{#if item.shortcut}
							<span class="text-xs text-muted-foreground/60 font-mono ml-auto">{item.shortcut}</span>
						{/if}
					</div>
				</Command.Item>
			{/each}
		{:else}
			{#each ["File", "Edit", "Format", "View", "Export"] as category}
				<Command.Group heading={category}>
					{#each appState.commands.getByCategory(category) as command}
						<Command.Item
							onSelect={() => executeCommand(command.id)}
							disabled={command.isEnabled && !command.isEnabled()}
						>
							<span>{command.label}</span>
							{#if command.shortcut}
								<Command.Shortcut>{formatShortcut(command.shortcut)}</Command.Shortcut>
							{/if}
						</Command.Item>
					{/each}
				</Command.Group>
			{/each}
		{/if}
	</Command.List>
</Command.Dialog>
