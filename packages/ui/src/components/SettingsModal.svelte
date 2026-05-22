<script lang="ts">
	import * as Dialog from './ui/dialog/index.js';
	import * as RadioGroup from './ui/radio-group/index.js';
	import { Label } from './ui/label/index.js';
	import { Separator } from './ui/separator/index.js';
	import { Switch } from './ui/switch/index.js';
	import { useAppState } from '@np/core';
	import { setMode, resetMode } from "mode-watcher";
	import { Palette, TextT, Gear } from "phosphor-svelte";
	import { cn } from '@np/core';
	import type { AppearanceMode } from '@np/core';

	const appState = useAppState();

	let { open = $bindable(false) } = $props();

	let activeCategory = $state('appearance');

	function handleModeChange(value: string) {
		if (value === 'system') {
			resetMode();
		} else {
			setMode(value as any);
		}
	}

	const themes = [
		{ id: 'default', name: 'Default', colors: { bg: '#ffffff', fg: '#000000', primary: '#000000' } },
		{ id: 'catppuccin-latte', name: 'Catppuccin Latte', colors: { bg: '#eff1f5', fg: '#4c4f69', primary: '#8839ef' } },
		{ id: 'catppuccin-frappe', name: 'Catppuccin Frappé', colors: { bg: '#303446', fg: '#c6d0f5', primary: '#ca9ee6' } },
		{ id: 'catppuccin-macchiato', name: 'Catppuccin Macchiato', colors: { bg: '#24273a', fg: '#cad3f5', primary: '#c6a0f6' } },
		{ id: 'catppuccin-mocha', name: 'Catppuccin Mocha', colors: { bg: '#1e1e2e', fg: '#cdd6f4', primary: '#cba6f7' } },
		{ id: 'gruvbox-dark-hard', name: 'Gruvbox Dark Hard', colors: { bg: '#1d2021', fg: '#ebdbb2', primary: '#8ec07c' } },
		{ id: 'gruvbox-dark-medium', name: 'Gruvbox Dark Medium', colors: { bg: '#282828', fg: '#ebdbb2', primary: '#8ec07c' } },
		{ id: 'gruvbox-dark-soft', name: 'Gruvbox Dark Soft', colors: { bg: '#32302f', fg: '#ebdbb2', primary: '#8ec07c' } },
		{ id: 'gruvbox-light-hard', name: 'Gruvbox Light Hard', colors: { bg: '#f9f5d7', fg: '#3c3836', primary: '#427b58' } },
		{ id: 'gruvbox-light-medium', name: 'Gruvbox Light Medium', colors: { bg: '#fbf1c7', fg: '#3c3836', primary: '#427b58' } },
		{ id: 'gruvbox-light-soft', name: 'Gruvbox Light Soft', colors: { bg: '#f2e5bc', fg: '#3c3836', primary: '#427b58' } },
	];

	const modes = [
		{ id: 'light', name: 'Light', icon: 'sun' },
		{ id: 'dark', name: 'Dark', icon: 'moon' },
		{ id: 'system', name: 'System', icon: 'monitor' }
	];

	const categories = [
		{ id: 'appearance', name: 'Appearance', icon: Palette },
		{ id: 'editor', name: 'Editor', icon: TextT },
	];

	const catppuccinAccents = [
		{ id: 'rosewater', color: '#f5e0dc', name: 'Rosewater' },
		{ id: 'flamingo', color: '#f2cdcd', name: 'Flamingo' },
		{ id: 'pink', color: '#f5c2e7', name: 'Pink' },
		{ id: 'mauve', color: '#cba6f7', name: 'Mauve' },
		{ id: 'red', color: '#f38ba8', name: 'Red' },
		{ id: 'maroon', color: '#eba0ac', name: 'Maroon' },
		{ id: 'peach', color: '#fab387', name: 'Peach' },
		{ id: 'yellow', color: '#f9e2af', name: 'Yellow' },
		{ id: 'green', color: '#a6e3a1', name: 'Green' },
		{ id: 'teal', color: '#94e2d5', name: 'Teal' },
		{ id: 'sky', color: '#89dceb', name: 'Sky' },
		{ id: 'sapphire', color: '#74c7ec', name: 'Sapphire' },
		{ id: 'blue', color: '#89b4fa', name: 'Blue' },
		{ id: 'lavender', color: '#b4befe', name: 'Lavender' }
	];

	const gruvboxAccents = [
		{ id: 'red', color: '#fb4934', name: 'Red' },
		{ id: 'green', color: '#b8bb26', name: 'Green' },
		{ id: 'yellow', color: '#fabd2f', name: 'Yellow' },
		{ id: 'blue', color: '#83a598', name: 'Blue' },
		{ id: 'purple', color: '#d3869b', name: 'Purple' },
		{ id: 'aqua', color: '#8ec07c', name: 'Aqua' },
		{ id: 'orange', color: '#fe8019', name: 'Orange' }
	];

	const defaultAccents = [
		{ id: 'default', color: '#000000', name: 'Default' },
		{ id: 'blue', color: '#0070f3', name: 'Blue' },
		{ id: 'red', color: '#e00000', name: 'Red' },
		{ id: 'green', color: '#00703c', name: 'Green' },
		{ id: 'orange', color: '#ff4d00', name: 'Orange' },
		{ id: 'purple', color: '#7928ca', name: 'Purple' }
	];

	let currentAccents = $derived.by(() => {
		if (appState.prefs.theme.startsWith('catppuccin')) return catppuccinAccents;
		if (appState.prefs.theme.startsWith('gruvbox')) return gruvboxAccents;
		return defaultAccents;
	});

	// Reset accent when theme family changes
	let lastThemeFamily = $state('');
	$effect(() => {
		const family = appState.prefs.theme.split('-')[0];
		if (lastThemeFamily && lastThemeFamily !== family) {
			appState.prefs.accentColor = 'default';
		}
		lastThemeFamily = family;
	});
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-4xl h-[600px] flex flex-col p-0 gap-0 overflow-hidden bg-background border-border shadow-2xl">
		<div class="flex flex-1 min-h-0">
			<!-- Sidebar -->
			<aside class="w-64 border-r bg-muted/30 flex flex-col p-4 gap-2">
				<div class="flex items-center gap-2 px-2 mb-6 text-foreground/80">
					<Gear size={20} weight="bold" />
					<span class="font-bold tracking-tight text-lg">Settings</span>
				</div>
				
				<nav class="flex flex-col gap-1">
					{#each categories as cat (cat.id)}
						<button
							onclick={() => activeCategory = cat.id}
							class={cn(
								"flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200",
								activeCategory === cat.id 
									? "bg-primary text-primary-foreground shadow-md" 
									: "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
							)}
						>
							<cat.icon size={18} weight={activeCategory === cat.id ? "fill" : "regular"} />
							{cat.name}
						</button>
					{/each}
				</nav>
			</aside>

			<!-- Content Area -->
			<main class="flex-1 flex flex-col min-w-0 bg-background overflow-y-auto">
				<div class="px-8 pt-8 pb-6">
					{#if activeCategory === 'appearance'}
						<div class="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
							<header>
								<h2 class="text-2xl font-bold tracking-tight">Appearance</h2>
								<p class="text-sm text-muted-foreground">Customize how the application looks and feels.</p>
							</header>

							<div class="space-y-6">
								<div>
									<h4 class="text-sm font-semibold mb-4 flex items-center gap-2">
										<Palette size={16} /> Theme
									</h4>
									<RadioGroup.Root bind:value={appState.prefs.theme} class="grid grid-cols-2 lg:grid-cols-4 gap-3">
										{#each themes as theme (theme.id)}
											<Label
												for={"theme-" + theme.id}
												class="flex flex-col items-center justify-between rounded-xl border-2 border-muted bg-card p-3 hover:bg-accent hover:text-accent-foreground [&:has([data-state=checked])]:border-primary transition-all cursor-pointer shadow-sm"
											>
												<RadioGroup.Item value={theme.id} id={"theme-" + theme.id} class="sr-only" />
												<div class="mb-3 flex w-full flex-col gap-1.5 rounded-lg p-2 shadow-inner border border-border/50" style="background-color: {theme.colors.bg}">
													<div class="h-1.5 w-full rounded-full" style="background-color: {theme.colors.fg}"></div>
													<div class="h-1.5 w-3/4 rounded-full" style="background-color: {theme.colors.fg}; opacity: 0.5"></div>
													<div class="h-1.5 w-1/2 rounded-full" style="background-color: {theme.colors.primary}"></div>
												</div>
												<span class="text-[10px] font-semibold text-center line-clamp-1">{theme.name}</span>
											</Label>
										{/each}
									</RadioGroup.Root>
									</div>

									<Separator />

									<div>
									<h4 class="text-sm font-semibold mb-4 flex items-center gap-2">
										<Palette size={16} /> Accent Color
									</h4>
									<RadioGroup.Root bind:value={appState.prefs.accentColor} class="flex flex-wrap gap-2">
										{#each currentAccents as accent (accent.id)}
											<Label
												for={"accent-" + accent.id}
												class={cn(
													"flex items-center justify-center w-8 h-8 rounded-full border-2 border-transparent cursor-pointer transition-all hover:scale-110",
													appState.prefs.accentColor === accent.id ? "border-foreground shadow-sm scale-110" : "opacity-80"
												)}
												style="background-color: {accent.color}"
												title={accent.name}
											>
												<RadioGroup.Item value={accent.id} id={"accent-" + accent.id} class="sr-only" />
											</Label>
										{/each}
									</RadioGroup.Root>
									</div>

									<Separator />

									<div class="grid grid-cols-2 gap-8">
									<div class="space-y-4">
										<h4 class="text-sm font-semibold flex items-center gap-2">Mode</h4>
										<RadioGroup.Root 
											value={appState.prefs.appearanceMode} 
											onValueChange={(v) => {
												appState.prefs.appearanceMode = v as AppearanceMode;
												handleModeChange(v);
											}}
											class="flex gap-2"
										>
											{#each modes as mode (mode.id)}
												<Label
													for={"mode-" + mode.id}
													class="flex-1 flex flex-col items-center justify-center rounded-lg border-2 border-muted bg-card p-3 hover:bg-accent cursor-pointer transition-all [&:has([data-state=checked])]:border-primary [&:has([data-state=checked])]:bg-primary/5"
												>
													<RadioGroup.Item value={mode.id} id={"mode-" + mode.id} class="sr-only" />
													<span class="text-xs font-medium">{mode.name}</span>
												</Label>
											{/each}
										</RadioGroup.Root>
									</div>
									<div class="space-y-4">
										<h4 class="text-sm font-semibold flex items-center gap-2">Interface</h4>
										<div class="flex items-center justify-between p-4 rounded-xl border bg-card/50">
											<div class="space-y-0.5">
												<Label class="text-sm font-medium">Status Bar</Label>
												<p class="text-[10px] text-muted-foreground">Show editor info at the bottom</p>
											</div>
											<Switch bind:checked={appState.prefs.statusBar} />
										</div>
									</div>
								</div>

								<Separator />

								<div class="grid grid-cols-2 gap-8">
									<div class="space-y-4">
										<h4 class="text-sm font-semibold flex items-center gap-2">File Icon Theme</h4>
										<RadioGroup.Root 
											bind:value={appState.prefs.fileIconThemeId}
											class="flex flex-col gap-2"
										>
											{#each appState.icons.getFileThemes() as theme (theme.id)}
												<Label
													for={"file-icon-" + theme.id}
													class="flex items-center justify-between p-3 rounded-lg border-2 border-muted bg-card hover:bg-accent cursor-pointer transition-all [&:has([data-state=checked])]:border-primary [&:has([data-state=checked])]:bg-primary/5"
												>
													<RadioGroup.Item value={theme.id} id={"file-icon-" + theme.id} class="sr-only" />
													<span class="text-xs font-medium">{theme.name}</span>
												</Label>
											{/each}
										</RadioGroup.Root>
									</div>

									<div class="space-y-4">
										<h4 class="text-sm font-semibold flex items-center gap-2">Product Icon Theme</h4>
										<RadioGroup.Root 
											bind:value={appState.prefs.productIconThemeId}
											class="flex flex-col gap-2"
										>
											{#each appState.icons.getProductThemes() as theme (theme.id)}
												<Label
													for={"product-icon-" + theme.id}
													class="flex items-center justify-between p-3 rounded-lg border-2 border-muted bg-card hover:bg-accent cursor-pointer transition-all [&:has([data-state=checked])]:border-primary [&:has([data-state=checked])]:bg-primary/5"
												>
													<RadioGroup.Item value={theme.id} id={"product-icon-" + theme.id} class="sr-only" />
													<span class="text-xs font-medium">{theme.name}</span>
												</Label>
											{/each}
										</RadioGroup.Root>
									</div>
								</div>
							</div>
						</div>
					{:else if activeCategory === 'editor'}
						<div class="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
							<header>
								<h2 class="text-2xl font-bold tracking-tight">Editor</h2>
								<p class="text-sm text-muted-foreground">Manage your writing and editing experience.</p>
							</header>

							<div class="space-y-6">
								<div class="grid grid-cols-2 gap-4">
									<div class="flex items-center justify-between p-4 rounded-xl border bg-card/50 shadow-sm">
										<div class="space-y-0.5">
											<Label class="text-sm font-medium">Word Wrap</Label>
											<p class="text-[10px] text-muted-foreground">Wrap long lines to fit the window</p>
										</div>
										<Switch bind:checked={appState.prefs.wordWrap} />
									</div>

									<div class="flex items-center justify-between p-4 rounded-xl border bg-card/50 shadow-sm">
										<div class="space-y-0.5">
											<Label class="text-sm font-medium">Auto-save</Label>
											<p class="text-[10px] text-muted-foreground">Coming soon</p>
										</div>
										<Switch checked={false} disabled />
									</div>
								</div>

								<div class="space-y-4">
									<h4 class="text-sm font-semibold">Typography</h4>
									<div class="p-6 rounded-xl border bg-card/50 space-y-6">
										<div class="space-y-3">
											<div class="flex justify-between items-center">
												<Label class="text-sm font-medium">Zoom Level</Label>
												<span class="text-xs font-bold bg-primary/10 text-primary px-2 py-1 rounded">{appState.prefs.zoom}%</span>
											</div>
											<input 
												type="range" 
												min="50" 
												max="300" 
												step="10" 
												bind:value={appState.prefs.zoom}
												class="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
											/>
										</div>

										<div class="grid grid-cols-2 gap-4">
											<div class="space-y-1.5">
												<Label class="text-xs">Line Endings</Label>
												<div class="text-xs p-2 rounded border bg-muted/50 text-muted-foreground">
													{appState.prefs.lineEnding}
												</div>
											</div>
											<div class="space-y-1.5">
												<Label class="text-xs">Encoding</Label>
												<div class="text-xs p-2 rounded border bg-muted/50 text-muted-foreground">
													{appState.prefs.encoding}
												</div>
											</div>
										</div>
									</div>
								</div>
							</div>
						</div>
					{/if}
				</div>
			</main>
		</div>

		<footer class="p-4 border-t flex justify-end gap-3 bg-muted/20">
			<Dialog.Close class="inline-flex items-center justify-center rounded-lg bg-primary px-6 py-2 text-sm font-bold text-primary-foreground hover:bg-primary/90 shadow-md transition-all active:scale-95">
				Done
			</Dialog.Close>
		</footer>
	</Dialog.Content>
</Dialog.Root>
