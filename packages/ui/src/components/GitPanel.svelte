<script lang="ts">
	import { useAppState } from '@np/core/state.svelte';
	import { Button } from './ui/button';
	import { Checkbox } from './ui/checkbox';
	import { ButtonGroup } from './ui/button-group';
	import {
		GitBranchIcon, PlusIcon, MinusIcon, ArrowCounterClockwiseIcon, CheckIcon,
		CaretDownIcon, TrashIcon, PlusMinusIcon
	} from 'phosphor-svelte';
	import Icon from './Icon.svelte';
	import GitFileItem from './GitFileItem.svelte';
	import { slide } from 'svelte/transition';
	import { onMount } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import type { GitChange, GroupedChange } from '@np/core';

	const appState = useAppState();
	let repo = $derived(appState.workspace.repository);

	let commitMessage = $state('');
	let showBranchDropdown = $state(false);
	let newBranchName = $state('');
	let trackedExpanded = $state(true);
	let untrackedExpanded = $state(true);
	let dropdownRef = $state<HTMLDivElement | null>(null);
	let hoveredPath = $state<string | null>(null);

	// View mode: list or tree
	let viewMode = $state<'list' | 'tree'>('list');
	let collapsedDirs = new SvelteSet<string>();

	// Multi-selection state
	let selectedPaths = new SvelteSet<string>();
	let lastSelectedPath = $state<string | null>(null);

	// Context menu state
	let showContextMenu = $state(false);
	let contextMenuX = $state(0);
	let contextMenuY = $state(0);
	let contextTargetFile = $state<GitChange | null>(null);
	let contextMenuRef = $state<HTMLDivElement | null>(null);

	// Split commit button dropdown flags
	let showCommitDropdown = $state(false);
	let isAmend = $state(false);
	let isSignoff = $state(false);

	let commitBtnLabel = $derived.by(() => {
		const parts: string[] = [];
		if (isAmend) parts.push('Amend');
		if (isSignoff) parts.push('Signoff');
		return parts.length > 0 ? `Commit (${parts.join(', ')})` : 'Commit';
	});

	// Group staged changes by path
	let stagedChangesGrouped = $derived.by((): GroupedChange[] => {
		if (!repo) return [];
		const map = new SvelteMap<string, GroupedChange>();
		repo.changes.filter(c => c.staged).forEach(c => {
			let existing = map.get(c.filepath);
			if (!existing) {
				existing = {
					filepath: c.filepath,
					status: c.status,
					additions: 0,
					deletions: 0,
					hasStaged: true,
					hasUnstaged: false,
					changes: []
				};
				map.set(c.filepath, existing);
			}
			existing.additions += c.additions;
			existing.deletions += c.deletions;
			existing.changes.push(c);
		});
		return Array.from(map.values());
	});

	// Group unstaged changes by path
	let unstagedChangesGrouped = $derived.by((): GroupedChange[] => {
		if (!repo) return [];
		const map = new SvelteMap<string, GroupedChange>();
		repo.changes.filter(c => !c.staged).forEach(c => {
			let existing = map.get(c.filepath);
			if (!existing) {
				existing = {
					filepath: c.filepath,
					status: c.status,
					additions: 0,
					deletions: 0,
					hasStaged: false,
					hasUnstaged: true,
					changes: []
				};
				map.set(c.filepath, existing);
			}
			existing.additions += c.additions;
			existing.deletions += c.deletions;
			existing.changes.push(c);
		});
		return Array.from(map.values());
	});

	// Tree structure node definition
	interface TreeNode {
		name: string;
		path: string;
		kind: 'directory' | 'file';
		children?: TreeNode[];
		change?: GroupedChange;
	}

	// Build hierarchical tree from grouped changes
	function buildTree(changesList: GroupedChange[]): TreeNode[] {
		const root: TreeNode[] = [];

		changesList.forEach(change => {
			const parts = change.filepath.split('/');
			let currentLevel = root;
			let currentPath = '';

			parts.forEach((part, index) => {
				currentPath = currentPath ? `${currentPath}/${part}` : part;
				const isLast = index === parts.length - 1;

				if (isLast) {
					currentLevel.push({
						name: part,
						path: currentPath,
						kind: 'file',
						change
					});
				} else {
					let dirNode = currentLevel.find(n => n.kind === 'directory' && n.path === currentPath);
					if (!dirNode) {
						dirNode = {
							name: part,
							path: currentPath,
							kind: 'directory',
							children: []
						};
						currentLevel.push(dirNode);
					}
					currentLevel = dirNode.children!;
				}
			});
		});

		const compressTree = (nodes: TreeNode[]) => {
			for (let i = 0; i < nodes.length; i++) {
				const node = nodes[i];
				if (node.kind === 'directory' && node.children) {
					compressTree(node.children);
					while (node.children && node.children.length === 1 && node.children[0].kind === 'directory') {
						const singleChild: TreeNode = node.children[0];
						node.name = `${node.name}/${singleChild.name}`;
						node.path = singleChild.path;
						node.children = singleChild.children;
					}
				}
			}
		};
		compressTree(root);

		const sortTree = (nodes: TreeNode[]) => {
			nodes.sort((a, b) => {
				if (a.kind !== b.kind) {
					return a.kind === 'directory' ? -1 : 1;
				}
				return a.name.localeCompare(b.name);
			});
			nodes.forEach(n => {
				if (n.children) sortTree(n.children);
			});
		};
		sortTree(root);

		return root;
	}

	// Recursive helper to find files in folder
	function getDescendantFiles(node: TreeNode): GroupedChange[] {
		if (node.kind === 'file') {
			return node.change ? [node.change] : [];
		}
		const files: GroupedChange[] = [];
		node.children?.forEach(child => {
			files.push(...getDescendantFiles(child));
		});
		return files;
	}

	// Determine checkbox states for folder nodes
	function getFolderStagingState(node: TreeNode) {
		const files = getDescendantFiles(node);
		if (files.length === 0) return { checked: false, indeterminate: false };

		let anyStaged = false;
		let anyUnstaged = false;

		files.forEach(f => {
			if (f.hasStaged) anyStaged = true;
			if (f.hasUnstaged) anyUnstaged = true;
		});

		if (anyStaged && anyUnstaged) {
			return { checked: false, indeterminate: true };
		}
		if (anyStaged) {
			return { checked: true, indeterminate: false };
		}
		return { checked: false, indeterminate: false };
	}

	// Directory checkbox handler
	function handleFolderCheckboxClick(node: TreeNode) {
		if (!repo) return;
		const files = getDescendantFiles(node);
		const { checked } = getFolderStagingState(node);

		if (checked) {
			files.forEach(f => appState.commands.execute('git.unstage', f.filepath));
		} else {
			files.forEach(f => appState.commands.execute('git.stage', f.filepath));
		}
	}

	let stagedTree = $derived(buildTree(stagedChangesGrouped));
	let unstagedTree = $derived(buildTree(unstagedChangesGrouped));

	async function handleCommit() {
		if (!repo) return;
		const stagedCount = repo.changes.filter(c => c.staged).length;
		if (stagedCount === 0 && !isAmend) return;
		let message = commitMessage.trim();
		if (!message) return;

		if (isSignoff) {
			message = `${message}\n\nSigned-off-by: You <you@example.com>`;
		}

		const success = await appState.commands.execute('git.commit', message, { amend: isAmend });
		if (success) {
			commitMessage = '';
			showCommitDropdown = false;
			isAmend = false;
		}
	}

	function handleTextareaKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			handleCommit();
		}
	}

	function handleDocumentClick(e: MouseEvent) {
		const target = e.target as HTMLElement;

		if (showBranchDropdown && dropdownRef && !dropdownRef.contains(target)) {
			showBranchDropdown = false;
		}
		if (showContextMenu && contextMenuRef && !contextMenuRef.contains(target)) {
			showContextMenu = false;
		}
		if (showCommitDropdown && !target.closest('.button-group-container')) {
			showCommitDropdown = false;
		}
	}

	function handleSelectPath(path: string, event: MouseEvent) {
		if (event.shiftKey && lastSelectedPath) {
			const changesList = unstagedChangesGrouped; // simplified multi-select scope
			const idx1 = changesList.findIndex(c => c.filepath === lastSelectedPath);
			const idx2 = changesList.findIndex(c => c.filepath === path);

			if (idx1 !== -1 && idx2 !== -1) {
				const start = Math.min(idx1, idx2);
				const end = Math.max(idx1, idx2);
				for (let i = start; i <= end; i++) {
					selectedPaths.add(changesList[i].filepath);
				}
			}
		} else if (event.ctrlKey || event.metaKey) {
			if (selectedPaths.has(path)) {
				selectedPaths.delete(path);
			} else {
				selectedPaths.add(path);
			}
		} else {
			selectedPaths.clear();
			selectedPaths.add(path);
		}
		lastSelectedPath = path;
		appState.commands.execute('git.openDiff', path);
	}

	function handleContextMenu(event: MouseEvent, file: GitChange) {
		event.preventDefault();
		contextTargetFile = file;
		contextMenuX = event.clientX;
		contextMenuY = event.clientY;
		showContextMenu = true;
	}

	function triggerAction(action: 'stage' | 'unstage' | 'discard' | 'diff') {
		if (!repo || !contextTargetFile) return;
		showContextMenu = false;

		const targets = selectedPaths.has(contextTargetFile.filepath)
			? Array.from(selectedPaths)
			: [contextTargetFile.filepath];

		if (action === 'stage') {
			targets.forEach(path => appState.commands.execute('git.stage', path));
		} else if (action === 'unstage') {
			targets.forEach(path => appState.commands.execute('git.unstage', path));
		} else if (action === 'discard') {
			targets.forEach(path => appState.commands.execute('git.discard', path));
		} else if (action === 'diff') {
			appState.commands.execute('git.openDiff', contextTargetFile.filepath);
		}
	}

	onMount(() => {
		window.addEventListener('click', handleDocumentClick);
		if (repo) {
			repo.refresh();
		}
		return () => {
			window.removeEventListener('click', handleDocumentClick);
		};
	});
</script>

{#snippet renderStatusChip(status: 'M' | 'A' | 'D' | 'S' | 'U')}
	{#if status === 'M'}
		<span class="text-[9px] font-bold px-1 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 font-mono scale-90 w-4 flex justify-center shrink-0">M</span>
	{:else if status === 'A' || status === 'U'}
		<span class="text-[9px] font-bold px-1 rounded bg-primary/10 text-primary font-mono scale-90 w-4 flex justify-center shrink-0">U</span>
	{:else if status === 'D'}
		<span class="text-[9px] font-bold px-1 rounded bg-destructive/10 text-destructive font-mono scale-90 w-4 flex justify-center shrink-0">D</span>
	{:else if status === 'S'}
		<span class="text-[9px] font-bold px-1 rounded bg-primary/10 text-primary font-mono scale-90 w-4 flex justify-center shrink-0">S</span>
	{/if}
{/snippet}

{#if !repo}
	<div class="h-full flex flex-col items-center justify-center p-6 text-center text-muted-foreground select-none">
		<GitBranchIcon class="size-8 mb-2 opacity-50 animate-pulse text-muted-foreground" />
		<p class="text-sm font-medium">No Git Repository</p>
		<p class="text-xs opacity-75 mt-1 max-w-[200px]">Open a folder containing a Git repository to use source control.</p>
	</div>
{:else}
	<div class="flex flex-col h-full bg-sidebar border-r border-border select-none relative font-sans text-xs">
		<!-- File List / Main Area -->
		<div class="flex-1 overflow-y-auto p-2 space-y-4">
			<!-- Commit View Actions -->
			<div class="flex items-center justify-between px-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
			<button
				type="button"
				onclick={() => appState.commands.execute('git.openDiff')}
				class="p-0.5 rounded hover:bg-muted/40 text-muted-foreground hover:text-foreground mr-1 gap-1 flex"
				title="View Diff"
			>
				<PlusMinusIcon size={12} />
				View Diff
			</button>
				<div class="flex items-center gap-1">
					<button
						type="button"
						onclick={() => viewMode = 'list'}
						class="px-1.5 py-0.5 rounded {viewMode === 'list' ? 'bg-muted text-foreground' : 'hover:bg-muted/40'}"
					>List</button>
					<button
						type="button"
						onclick={() => viewMode = 'tree'}
						class="px-1.5 py-0.5 rounded {viewMode === 'tree' ? 'bg-muted text-foreground' : 'hover:bg-muted/40'}"
					>Tree</button>
				</div>
			</div>

			{#if repo.changes.length === 0}
				<div class="py-8 text-center text-muted-foreground/60 select-none">
					<CheckIcon class="size-6 mx-auto mb-1 opacity-40 text-green-500" />
					<p class="text-[11px] font-medium">No changes detected</p>
				</div>
			{/if}

			<!-- STAGED CHANGES -->
			{#if stagedChangesGrouped.length > 0}
				<div class="space-y-1">
				<div
						role="button"
						tabindex="0"
						onclick={() => trackedExpanded = !trackedExpanded}
						onkeydown={(e) => e.key === 'Enter' && (trackedExpanded = !trackedExpanded)}
						class="w-full flex items-center justify-between px-1 py-1 rounded hover:bg-muted/20 font-medium text-foreground/80"
					>
						<span class="flex items-center gap-1.5 font-semibold text-[10px] uppercase text-muted-foreground">
							Staged Changes
							<span class="px-1.5 py-0.5 text-[9px] rounded-full bg-primary/10 text-primary font-mono">{stagedChangesGrouped.length}</span>
						</span>
						<div class="flex items-center gap-1">
							<button
								type="button"
								onclick={(e) => { e.stopPropagation(); appState.commands.execute('git.unstageAll'); }}
								class="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
								title="Unstage all"
							>
								<MinusIcon size={11} />
							</button>
							<CaretDownIcon size={11} class="transition-transform duration-200 {!trackedExpanded ? 'rotate-180' : ''}" />
						</div>
					</div>

					{#if trackedExpanded}
						<div transition:slide={{ duration: 150 }} class="pl-1 space-y-0.5">
							{#if viewMode === 'list'}
								{#each stagedChangesGrouped as change (change.filepath)}
									<GitFileItem
										{change}
										isStaged={true}
										isSelected={selectedPaths.has(change.filepath)}
										isActive={repo?.activeDiffFile?.filepath === change.filepath}
										{selectedPaths}
										onclick={(e) => handleSelectPath(change.filepath, e as any)}
									/>
								{/each}
							{:else}
								<!-- Tree View Staged -->
								{#each stagedTree as node (node.path)}
									{@render renderTreeNode(node, true)}
								{/each}
							{/if}
						</div>
					{/if}
				</div>
			{/if}

			<!-- UNSTAGED CHANGES -->
			{#if unstagedChangesGrouped.length > 0}
				<div class="space-y-1">
					<div
						role="button"
						tabindex="0"
						onclick={() => untrackedExpanded = !untrackedExpanded}
						onkeydown={(e) => e.key === 'Enter' && (untrackedExpanded = !untrackedExpanded)}
						class="w-full flex items-center justify-between px-1 py-1 rounded hover:bg-muted/20 font-medium text-foreground/80"
					>
						<span class="flex items-center gap-1.5 font-semibold text-[10px] uppercase text-muted-foreground">
							Changes
							<span class="px-1.5 py-0.5 text-[9px] rounded-full bg-amber-500/10 text-amber-500 font-mono">{unstagedChangesGrouped.length}</span>
						</span>
						<div class="flex items-center gap-1">
							<button
								type="button"
								onclick={(e) => { e.stopPropagation(); appState.commands.execute('git.stageAll'); }}
								class="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
								title="Stage all changes"
							>
								<PlusIcon size={11} />
							</button>
							<button
								type="button"
								onclick={(e) => { e.stopPropagation(); appState.commands.execute('git.discardAll'); }}
								class="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-destructive"
								title="Discard all changes"
							>
								<ArrowCounterClockwiseIcon size={11} />
							</button>
							<CaretDownIcon size={11} class="transition-transform duration-200 {!untrackedExpanded ? 'rotate-180' : ''}" />
						</div>
					</div>

					{#if untrackedExpanded}
						<div transition:slide={{ duration: 150 }} class="pl-1 space-y-0.5">
							{#if viewMode === 'list'}
								{#each unstagedChangesGrouped as change (change.filepath)}
									<GitFileItem
										{change}
										isStaged={false}
										isSelected={selectedPaths.has(change.filepath)}
										isActive={repo?.activeDiffFile?.filepath === change.filepath}
										{selectedPaths}
										onclick={(e) => handleSelectPath(change.filepath, e as any)}
									/>
								{/each}
							{:else}
								<!-- Tree View Unstaged -->
								{#each unstagedTree as node (node.path)}
									{@render renderTreeNode(node, false)}
								{/each}
							{/if}
						</div>
					{/if}
				</div>
			{/if}
		</div>

		<!-- Footer/Commit Area -->
		<div class="p-3 border-t border-border shrink-0 bg-sidebar/95 backdrop-blur-sm">
			<div class="rounded-md border border-border bg-muted/30 focus-within:ring-1 focus-within:ring-primary focus-within:border-transparent transition-all flex flex-col relative">
				<textarea
					placeholder="Commit message (Ctrl+Enter to commit)..."
					bind:value={commitMessage}
					onkeydown={handleTextareaKeydown}
					class="w-full min-h-[64px] max-h-28 bg-transparent p-2 text-xs text-foreground placeholder-muted-foreground/60 focus:outline-none resize-y font-sans border-b border-border/40 rounded-t-md"
				></textarea>

				<div class="p-1.5 bg-muted/20 flex items-center justify-between gap-1.5 relative button-group-container rounded-b-md">
					<div class="text-[10px] text-muted-foreground font-mono px-1 select-none">
						{#if isAmend}<span class="text-amber-500 font-bold mr-1">Amend</span>{/if}
						{#if isSignoff}<span class="text-emerald-500 font-bold mr-1">Signed-off</span>{/if}
					</div>

					<ButtonGroup class="flex-1 max-w-[140px]">
						<Button
							onclick={handleCommit}
							disabled={repo.changes.filter(c => c.staged).length === 0 || repo.isBusy || !commitMessage.trim()}
							size="xs"
							class="flex-1 shadow-sm font-semibold tracking-wide"
						>
							{#if repo.isBusy}
								<div class="size-3 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin"></div>
							{:else}
								{commitBtnLabel}
							{/if}
						</Button>

						<Button
							onclick={() => showCommitDropdown = !showCommitDropdown}
							disabled={repo.isBusy}
							size="xs"
							variant="default"
							class="px-1.5 border-l border-primary-foreground/20"
						>
							<CaretDownIcon size={11} />
						</Button>
					</ButtonGroup>

					{#if showCommitDropdown}
						<div class="absolute bottom-full right-1.5 mb-1.5 w-48 rounded bg-popover border border-border shadow-lg z-50 py-1 animate-in fade-in slide-in-from-bottom-1 duration-100">
							<button
								type="button"
								onclick={() => { isAmend = !isAmend; showCommitDropdown = false; }}
								class="w-full text-left px-3 py-1.5 text-xs hover:bg-accent flex items-center justify-between {isAmend ? 'text-primary' : ''}"
							>
								<span>Amend commit</span>
								{#if isAmend}
									<CheckIcon size={11} />
								{/if}
							</button>
							<button
								type="button"
								onclick={() => { isSignoff = !isSignoff; showCommitDropdown = false; }}
								class="w-full text-left px-3 py-1.5 text-xs hover:bg-accent flex items-center justify-between {isSignoff ? 'text-primary' : ''}"
							>
								<span>Add sign-off</span>
								{#if isSignoff}
									<CheckIcon size={11} />
								{/if}
							</button>
						</div>
					{/if}
				</div>
			</div>
		</div>

		<!-- Context Menu -->
		{#if showContextMenu}
			<div
				bind:this={contextMenuRef}
				style="top: {contextMenuY}px; left: {contextMenuX}px;"
				class="fixed bg-popover text-popover-foreground border border-border rounded shadow-lg py-1 z-50 min-w-[120px] font-sans"
			>
				{#if contextTargetFile}
					{#if contextTargetFile.staged}
						<button
							type="button"
							onclick={() => triggerAction('unstage')}
							class="w-full text-left px-3 py-1.5 text-xs hover:bg-accent flex items-center justify-between"
						>
							<span>Unstage File</span>
							<MinusIcon size={11} class="opacity-60" />
						</button>
					{:else}
						<button
							type="button"
							onclick={() => triggerAction('stage')}
							class="w-full text-left px-3 py-1.5 text-xs hover:bg-accent flex items-center justify-between"
						>
							<span>Stage File</span>
							<PlusIcon size={11} class="opacity-60" />
						</button>
						<button
							type="button"
							onclick={() => triggerAction('discard')}
							class="w-full text-left px-3 py-1.5 text-xs hover:bg-accent text-destructive hover:bg-destructive/10 flex items-center justify-between"
						>
							<span>Discard Changes</span>
							<TrashIcon size={11} class="opacity-60" />
						</button>
					{/if}
					<button
						type="button"
						onclick={() => triggerAction('diff')}
						class="w-full text-left px-3 py-1.5 text-xs hover:bg-accent flex items-center justify-between"
					>
						<span>Open Diff</span>
						<EyeIcon size={11} class="opacity-60" />
					</button>
				{/if}
			</div>
		{/if}
	</div>
{/if}

<!-- REUSABLE TREE NODE SNIPPET -->
{#snippet renderTreeNode(node: TreeNode, isStagedSection: boolean)}
	{@const isDir = node.kind === 'directory'}
	{@const sectionPrefix = isStagedSection ? 'staged:' : 'unstaged:'}
	{@const nodeKey = isDir ? `${sectionPrefix}${node.path}` : node.path}
	{@const isCollapsed = collapsedDirs.has(nodeKey)}

	<div class="space-y-0.5">
		<div
			role="button"
			tabindex="0"
			onmouseenter={() => hoveredPath = nodeKey}
			onmouseleave={() => hoveredPath = null}
			class="group flex items-center justify-between px-2 py-0.5 rounded hover:bg-muted/15 text-foreground/90 font-medium"
			onclick={(e) => {
				if (isDir) {
					if (isCollapsed) {
						collapsedDirs.delete(nodeKey);
					} else {
						collapsedDirs.add(nodeKey);
					}
				} else if (node.change) {
					handleSelectPath(node.change.filepath, e);
				}
			}}
			onkeydown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					if (isDir) {
						if (isCollapsed) {
							collapsedDirs.delete(nodeKey);
						} else {
							collapsedDirs.add(nodeKey);
						}
					} else if (node.change) {
						handleSelectPath(node.change.filepath, e as any);
					}
				}
			}}
			oncontextmenu={(e) => {
				if (!isDir && node.change) {
					handleContextMenu(e, node.change.changes[0]);
				}
			}}
		>
			<div class="flex items-center gap-1.5 min-w-0">
				{#if isDir}
					<button type="button" class="p-0.5 rounded hover:bg-muted/30 text-muted-foreground/60">
						<Icon resource={node.name} type="folder" folderOpen={!isCollapsed} size={14} />
					</button>
				{:else}
					{#if node.change}
						{#if isStagedSection}
							{@render renderStatusChip('S')}
						{:else}
							{@render renderStatusChip(node.change.status === 'A' ? 'U' : node.change.status)}
						{/if}
					{/if}
					<Icon resource={node.path} size={14} class="shrink-0" />
				{/if}
				<span class="truncate">{node.name}</span>
			</div>

			<div class="flex items-center gap-1.5 shrink-0">
				{#if hoveredPath === nodeKey}
					{#if isDir}
						{@const stagingState = getFolderStagingState(node)}
						<div class="transition-opacity">
							<Checkbox
								checked={stagingState.checked}
								indeterminate={stagingState.indeterminate}
								onclick={(e) => { e.stopPropagation(); handleFolderCheckboxClick(node); }}
								class="scale-75"
							/>
						</div>
					{:else if node.change}
						<div class="flex items-center gap-1.5 transition-opacity">
							{#if isStagedSection}
								<button
									type="button"
									onclick={(e) => { e.stopPropagation(); appState.commands.execute('git.unstage', node.change!.filepath); }}
									class="p-0.5 rounded bg-muted/40 hover:bg-muted text-muted-foreground"
									title="Unstage"
								>
									<MinusIcon size={9} />
								</button>
							{:else}
								<button
									type="button"
									onclick={(e) => { e.stopPropagation(); appState.commands.execute('git.discard', node.change!.filepath); }}
									class="p-0.5 rounded bg-muted/40 hover:bg-muted text-destructive"
									title="Discard"
								>
									<ArrowCounterClockwiseIcon size={9} />
								</button>
								<button
									type="button"
									onclick={(e) => { e.stopPropagation(); appState.commands.execute('git.stage', node.change!.filepath); }}
									class="p-0.5 rounded bg-muted/40 hover:bg-muted text-muted-foreground"
									title="Stage"
								>
									<PlusIcon size={9} />
								</button>
							{/if}
						</div>
					{/if}
				{:else if !isDir && node.change && (node.change.additions > 0 || node.change.deletions > 0)}
					<div class="flex items-center gap-1 text-[9px] font-mono mr-1 opacity-80 pointer-events-none">
						{#if node.change.additions > 0}<span class="text-green-500">+{node.change.additions}</span>{/if}
						{#if node.change.deletions > 0}<span class="text-red-500">-{node.change.deletions}</span>{/if}
					</div>
				{/if}
			</div>
		</div>

		{#if isDir && !isCollapsed && node.children}
			<div class="pl-3.5 border-l border-border/40 ml-2.5 space-y-0.5">
				{#each node.children as child (child.path)}
					{@render renderTreeNode(child, isStagedSection)}
				{/each}
			</div>
		{/if}
	</div>
{/snippet}
