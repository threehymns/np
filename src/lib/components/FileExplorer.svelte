<script lang="ts">
	import { useAppState } from "$lib/state.svelte";
	import FileTreeItem from "./FileTreeItem.svelte";
	import { FolderOpen, ArrowsClockwise, MagnifyingGlass, X, Funnel, Check, CaretUpDown, FolderPlus, GitBranch } from "phosphor-svelte";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import * as Tooltip from "$lib/components/ui/tooltip/index.js";
	import * as Command from "$lib/components/ui/command";
	import * as Popover from "$lib/components/ui/popover";
	import BranchSafetyModal from "./BranchSafetyModal.svelte";
	import type { RepositorySafetyReport } from "$lib/project/repository.svelte";
	import { toURI, type FileOrigin } from "$lib/storage";
	import { slide } from "svelte/transition";
	import { cn } from "$lib/utils";
	import { tick, onMount } from "svelte";

	const appState = useAppState();

	let showFilter = $state(false);
	let comboOpen = $state(false);
	let branchComboOpen = $state(false);
	let triggerRef = $state<HTMLButtonElement>(null!);
	let mounted = $state(false);

	let safetyReport = $state<RepositorySafetyReport | null>(null);
	let pendingBranch = $state<string | null>(null);

	onMount(() => {
		mounted = true;
	});

	function toggleFilter() {
		showFilter = !showFilter;
		if (!showFilter) {
			appState.workspace.projectTree.searchQuery = "";
		}
	}

	async function refresh() {
		if (appState.workspace.rootOrigin) {
			if (appState.workspace.repository) {
				await appState.workspace.repository.refresh();
			}
			await appState.workspace.projectTree.scan(appState.workspace.rootOrigin);
		}
	}

	function clearSearch() {
		appState.workspace.projectTree.searchQuery = "";
	}

	function closeAndFocusTrigger() {
		comboOpen = false;
		tick().then(() => {
			triggerRef?.focus();
		});
	}

	async function selectFolder(handle: FileOrigin | FileSystemDirectoryHandle) {
		await appState.workspace.openDirectory(handle);
		closeAndFocusTrigger();
	}

	async function switchBranch(branch: string) {
		const report = await appState.workspace.getBranchSafetyReport(branch);
		if (report && !report.canSwitch) {
			safetyReport = report;
			pendingBranch = branch;
			branchComboOpen = false;
			return;
		}

		await appState.workspace.switchBranch(branch);
		branchComboOpen = false;
	}

	async function recheckSafety() {
		if (!pendingBranch) return;
		const report = await appState.workspace.getBranchSafetyReport(pendingBranch);
		if (report && report.canSwitch) {
			const branch = pendingBranch;
			safetyReport = null;
			pendingBranch = null;
			await appState.workspace.switchBranch(branch);
		} else {
			safetyReport = report;
		}
	}
</script>

{#if safetyReport && pendingBranch}
	<BranchSafetyModal 
		report={safetyReport} 
		targetBranch={pendingBranch} 
		onConfirm={recheckSafety}
		onCancel={() => { safetyReport = null; pendingBranch = null; }}
	/>
{/if}

<div class="flex flex-col h-full text-sidebar-foreground overflow-hidden select-none">
	<div class="flex-1 overflow-auto py-1">
		{#if mounted}
			{#if appState.workspace.rootHandle}
				{@const rootHandle = appState.workspace.rootHandle}
				<div class="px-2 mb-1">
					<div class="flex items-center justify-between px-2 py-1 text-[11px] font-semibold opacity-60 group/header">
						<div class="flex items-center gap-1 min-w-0">
							<Popover.Root bind:open={comboOpen}>
								<Popover.Trigger bind:ref={triggerRef}>
									{#snippet child({ props })}
										<button
											{...props}
											class="flex items-center gap-1 truncate hover:text-sidebar-foreground transition-all text-left hover:bg-sidebar-accent px-1.5 -ml-1 rounded-sm py-0.5"
										>
											<span class="truncate">{rootHandle.name}</span>
											<CaretUpDown class="size-3 shrink-0 opacity-0 group-hover/header:opacity-50 transition-opacity" />
										</button>
									{/snippet}
								</Popover.Trigger>
								<Popover.Content class="p-0 flex flex-col" align="start">
									<Command.Root class="flex-1 p-0">
										<Command.Input placeholder="Recent Folders" class="h-8" />
										<Command.List class="px-1 pt-2 pb-0">
											<Command.Empty class="py-2 text-[11px] text-center">No folders found.</Command.Empty>
											{#each appState.workspace.recentFolders as folder (folder.name)}
												<Command.Item
													value={folder.name}
													onSelect={() => selectFolder(folder)}
													class="text-[11px] flex items-center gap-2 px-2 py-1.5"
												>
													<div class="flex items-center gap-1 truncate">
														<!-- TODO: Implement base path display once a native backend (like Electron) is available. 
															The Web File System Access API does not provide absolute paths. -->
														<span class="truncate">{folder.name}</span>
													</div>
													{#if rootHandle.name === folder.name}
														<span class="text-[10px] opacity-40 shrink-0">- Current</span>
													{/if}
												</Command.Item>
											{/each}
										</Command.List>
									</Command.Root>
									<div class="border-t p-1 flex justify-end">
										<Tooltip.Provider delayDuration={400}>
											<Tooltip.Root>
												<Tooltip.Trigger>
													{#snippet child({ props })}
														<Button 
															variant="ghost" 
															size="icon-xs" 
															{...props} 
															onclick={() => {
																appState.workspace.openDirectory();
																closeAndFocusTrigger();
															}}
															class="hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
														>
															<FolderPlus class="size-3.5" />
														</Button>
													{/snippet}
												</Tooltip.Trigger>
												<Tooltip.Content side="top" align="center" class="text-[10px] px-2 py-1">
													Open New Folder
												</Tooltip.Content>
											</Tooltip.Root>
										</Tooltip.Provider>
									</div>
								</Popover.Content>
							</Popover.Root>

							{#if appState.workspace.hasRootPermission && appState.workspace.currentBranch}
								<Popover.Root bind:open={branchComboOpen}>
									<Popover.Trigger>
										{#snippet child({ props })}
											<button
												{...props}
												class="flex items-center gap-1 opacity-50 hover:opacity-100 hover:bg-sidebar-accent transition-all px-1 rounded-sm py-0.5 -ml-0.5 truncate"
											>
												{#if appState.workspace.repository?.isBusy}
													<div class="size-3 animate-spin border-2 border-sidebar-foreground/50 border-t-sidebar-foreground rounded-full"></div>
												{:else}
													<GitBranch class="size-3 shrink-0" />
												{/if}
												<span class="text-[10px] truncate max-w-[80px]">{appState.workspace.currentBranch}</span>
											</button>
										{/snippet}
									</Popover.Trigger>
									<Popover.Content class="p-0 flex flex-col" align="start">
										<Command.Root class="flex-1 p-0">
											<Command.Input placeholder="Switch Branch" class="h-8" />
											<Command.List class="px-1 py-1">
												<Command.Empty class="py-2 text-[11px] text-center">No branches found.</Command.Empty>
												{#each appState.workspace.branches as branch}
													<Command.Item
														value={branch}
														onSelect={() => switchBranch(branch)}
														class="text-[11px] flex items-center justify-between gap-2 px-2 py-1.5"
													>
														<div class="flex items-center gap-2 truncate">
															<GitBranch class="size-3 opacity-50" />
															<span class="truncate">{branch}</span>
														</div>
														{#if appState.workspace.currentBranch === branch}
															<Check class="size-3 opacity-50" />
														{/if}
													</Command.Item>
												{/each}
											</Command.List>
										</Command.Root>
									</Popover.Content>
								</Popover.Root>
							{/if}
						</div>


						<div class="flex gap-0.5 shrink-0 opacity-0 pointer-events-none group-hover/header:opacity-100 group-hover/header:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto transition-opacity">
							<Tooltip.Provider delayDuration={400}>
								<Tooltip.Root>
									<Tooltip.Trigger>
										{#snippet child({ props })}
											<Button variant="ghost" size="icon-xs" {...props} onclick={toggleFilter} class={cn(showFilter ? 'bg-sidebar-accent text-sidebar-accent-foreground' : '', "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground")}>
												<Funnel class="size-3" />
											</Button>
										{/snippet}
									</Tooltip.Trigger>
									<Tooltip.Content side="top" align="center" class="text-[10px] px-2 py-1">
										Filter Files
									</Tooltip.Content>
								</Tooltip.Root>
								<Tooltip.Root>
									<Tooltip.Trigger>
										{#snippet child({ props })}
											<Button variant="ghost" size="icon-xs" {...props} onclick={refresh} class="hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
												<ArrowsClockwise class="size-3" />
											</Button>
										{/snippet}
									</Tooltip.Trigger>
									<Tooltip.Content side="top" align="center" class="text-[10px] px-2 py-1">
										Refresh Explorer
									</Tooltip.Content>
								</Tooltip.Root>
								<Tooltip.Root>
									<Tooltip.Trigger>
										{#snippet child({ props })}
											<Button variant="ghost" size="icon-xs" {...props} onclick={() => appState.workspace.openDirectory()} class="hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
												<FolderOpen class="size-3" />
											</Button>
										{/snippet}
									</Tooltip.Trigger>
									<Tooltip.Content side="top" align="center" class="text-[10px] px-2 py-1">
										Open Folder
									</Tooltip.Content>
								</Tooltip.Root>
							</Tooltip.Provider>
						</div>
					</div>

					{#if showFilter}
						<div transition:slide={{ duration: 200 }} class="px-2 py-1.5">
							<div class="relative group">
								<Funnel class="absolute left-2 top-1/2 -translate-y-1/2 size-3 opacity-40 group-focus-within:opacity-80 transition-opacity" />
								<!-- svelte-ignore a11y_autofocus -->
								<input
									type="text"
									autofocus
									placeholder="Filter files by name..."
									bind:value={appState.workspace.projectTree.searchQuery}
									class="w-full bg-sidebar-accent/50 border-none rounded-md pl-7 pr-7 py-1 text-[11px] outline-none ring-1 ring-sidebar-border/50 focus:ring-sidebar-ring/40 transition-all placeholder:opacity-50"
								/>
								{#if appState.workspace.projectTree.searchQuery}
									<button 
										onclick={clearSearch}
										class="absolute right-2 top-1/2 -translate-y-1/2 opacity-40 hover:opacity-100 transition-opacity"
									>
										<X class="size-3" />
									</button>
								{/if}
							</div>
						</div>
					{/if}
				</div>
				
				<div class="space-y-0.5">
					{#if appState.workspace.hasRootPermission}
						{#each appState.workspace.projectTree.visualNodes as visualNode (toURI(visualNode.origin))}
							<FileTreeItem {visualNode} />
						{/each}
					{:else}
						<div class="px-6 py-10 text-center">
							<FolderOpen class="size-8 mx-auto mb-3 opacity-20" />
							<p class="text-[11px] opacity-60 mb-4 px-2">Access to this folder needs to be restored.</p>
							<Button 
								variant="outline" 
								size="sm" 
								onclick={() => appState.workspace.requestRootPermission()} 
								class="h-7 text-[10px] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground border-sidebar-border"
							>
								Grant Permission
							</Button>
						</div>
					{/if}
				</div>
				
				{#if appState.workspace.projectTree.searchQuery && appState.workspace.projectTree.isSearching}
					<div class="px-6 py-10 text-center">
						<div class="inline-block animate-spin size-4 border-2 border-primary border-t-transparent rounded-full mb-2"></div>
						<p class="text-xs opacity-40">Searching...</p>
					</div>
				{:else if appState.workspace.projectTree.searchQuery && appState.workspace.projectTree.visualNodes.length === 0}
					<div class="px-6 py-10 text-center">
						<p class="text-xs opacity-40">No matches found</p>
					</div>
				{/if}
			{:else}
				<div class="flex flex-col items-center justify-center h-40 px-6 text-center">
					<FolderOpen class="size-8 mb-3 opacity-20" />
					<p class="text-xs opacity-50 mb-4">No folder opened</p>
					<Button variant="outline" size="sm" onclick={() => appState.workspace.openDirectory()} class="hover:bg-sidebar-accent hover:text-sidebar-accent-foreground border-sidebar-border">
						Open Folder
					</Button>
				</div>
			{/if}
		{/if}
	</div>
</div>
