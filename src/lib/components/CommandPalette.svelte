<script lang="ts">
	import { commands } from "$lib/commands.svelte";
	import * as Command from "$lib/components/ui/command";
	import { onMount } from "svelte";

	let open = $state(false);

	$effect(() => {
		function handleKeydown(e: KeyboardEvent) {
			if ((e.metaKey || e.ctrlKey) && e.key === "p") {
				e.preventDefault();
				open = !open;
			}
		}

		window.addEventListener("keydown", handleKeydown);
		return () => window.removeEventListener("keydown", handleKeydown);
	});

	function executeCommand(id: string) {
		commands.execute(id);
		open = false;
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

<Command.Dialog bind:open>
	<Command.Input placeholder="Type a command or search..." />
	<Command.List>
		<Command.Empty>No results found.</Command.Empty>
		{#each ["File", "Edit", "Format", "View", "Export"] as category}
			<Command.Group heading={category}>
				{#each commands.getByCategory(category) as command}
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
	</Command.List>
</Command.Dialog>
