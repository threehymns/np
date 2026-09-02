<script lang="ts">
	import { useAppState } from '@np/core/state.svelte';
	import { Button } from './ui/button';
	import { Checkbox } from './ui/checkbox';
	import { ButtonGroup } from './ui/button-group';
	import {
		GitBranchIcon, PlusIcon, MinusIcon, ArrowCounterClockwiseIcon, CheckIcon,
		CaretDownIcon, PlusMinusIcon, TrashIcon, GitDiffIcon
	} from 'phosphor-svelte';
	import Icon from './Icon.svelte';
	import GitFileItem from './GitFileItem.svelte';
	import GitStatusChip from './GitStatusChip.svelte';
	import * as Tooltip from './ui/tooltip/index';
	import * as ContextMenu from './ui/context-menu';
	import { runGitAction } from './git-actions';
	import { slide } from 'svelte/transition';
	import { onMount } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { type GitChange, type GroupedChange } from '@np/core';

	const appState = useAppState();
	let repo = $derived(appState.workspace.repository);

	let commitMessage = $state('');
	let showBranchDropdown = $state(false);
	let newBranchName = $state('');
	let stagedExpanded = $state(true);
	let changesExpanded = $state(true);
	let untrackedExpanded = $state(true);
	let dropdownRef = $state<HTMLDivElement | null>(null);

	// View mode: list or tree
	let viewMode = $state<'list' | 'tree'>('list');
	let collapsedDirs = new SvelteSet<string>();

	// Multi-selection state
	let selectedPaths = new SvelteSet<string>();
	let lastSelectedPath = $state<string | null>(null);

	// Split commit button dropdown flags
	let showCommitDropdown = $state(false);
	let isAmend = $state(false);
	let isSignoff = $state(false);
	let userConfig = $state<{ name: string; email: string } | null>(null);

	let commitBtnLabel = $derived.by(() => {
		const parts: string[] = [];
		if (isAmend) parts.push('Amend');
		if (isSignoff) parts.push('Signoff');
		return parts.length > 0 ? `Commit (${parts.join(', ')})` : 'Commit';
	});

	function groupChanges(changes: GitChange[]): GroupedChange[] {
		const map = new SvelteMap<string, GroupedChange>();
		for (const c of changes) {
			let existing = map.get(c.filepath);
			if (!existing) {
				existing = {
					filepath: c.filepath,
					status: c.status,
					additions: 0,
					deletions: 0,
					hasStaged: c.staged,
					hasUnstaged: !c.staged,
					changes: []
				};
				map.set(c.filepath, existing);
			}
			existing.additions += c.additions;
			existing.deletions += c.deletions;
			existing.changes.push(c);
			if (c.staged) existing.hasStaged = true;
			if (!c.staged) existing.hasUnstaged = true;
		}
		return Array.from(map.values());
	}

	// Group staged changes by path
	let stagedChangesGrouped = $derived.by((): GroupedChange[] => {
		if (!repo) return [];
		return groupChanges(repo.changes.filter(c => c.staged));
	});

	// Group unstaged tracked changes by path
	let unstagedChangesGrouped = $derived.by((): GroupedChange[] => {
		if (!repo) return [];
		return groupChanges(repo.changes.filter(c => !c.staged && c.status !== 'U'));
	});

	// Group untracked files by path
	let untrackedChangesGrouped = $derived.by((): GroupedChange[] => {
		if (!repo) return [];
		return groupChanges(repo.changes.filter(c => !c.staged && c.status === 'U'));
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
	async function handleFolderCheckboxClick(node: TreeNode) {
		if (!repo) return;
		const files = getDescendantFiles(node);
		const { checked } = getFolderStagingState(node);

		if (checked) {
			for (const f of files) {
				await appState.commands.execute('git.unstage', f.filepath);
			}
		} else {
			for (const f of files) {
				await appState.commands.execute('git.stage', f.filepath);
			}
		}
	}

	let stagedTree = $derived(buildTree(stagedChangesGrouped));
	let unstagedTree = $derived(buildTree(unstagedChangesGrouped));
	let untrackedTree = $derived(buildTree(untrackedChangesGrouped));

	async function handleCommit() {
		if (!repo) return;
		const stagedCount = repo.changes.filter(c => c.staged).length;
		if (stagedCount === 0 && !isAmend) return;
		let message = commitMessage.trim();
		if (!message) return;

		if (isSignoff && userConfig?.name && userConfig?.email) {
			message = `${message}\n\nSigned-off-by: ${userConfig.name} <${userConfig.email}>`;
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
		if (showCommitDropdown && !target.closest('.button-group-container')) {
			showCommitDropdown = false;
		}
	}

	function handleSelectPath(path: string, event: MouseEvent, sectionList?: GroupedChange[]) {
		const targetList = sectionList || [...stagedChangesGrouped, ...unstagedChangesGrouped, ...untrackedChangesGrouped];
		if (event.shiftKey && lastSelectedPath) {
			const idx1 = targetList.findIndex(c => c.filepath === lastSelectedPath);
			const idx2 = targetList.findIndex(c => c.filepath === path);

			if (idx1 !== -1 && idx2 !== -1) {
				const start = Math.min(idx1, idx2);
				const end = Math.max(idx1, idx2);
				for (let i = start; i <= end; i++) {
					selectedPaths.add(targetList[i].filepath);
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
		if (repo) {
			repo.selectedPaths = Array.from(selectedPaths);
		}
		appState.commands.execute('git.openDiff', path);
	}

	onMount(() => {
		window.addEventListener('click', handleDocumentClick);
		if (repo) {
			Promise.resolve(repo.refresh()).catch(err => {
				console.error("[GitPanel] Failed to refresh repository:", err);
			});
			repo.adapter.getUserConfig?.().then(cfg => { userConfig = cfg || null; }).catch(() => {});
		}
		return () => {
			window.removeEventListener('click', handleDocumentClick);
		};
	});
</script>



{#if !repo}
	<div class="h-full flex flex-col items-center justify-center p-6 text-center text-muted-foreground select-none">
		<GitBranchIcon class="size-8 mb-2 opacity-50 animate-pulse text-muted-foreground" />
		<p class="text-sm font-medium">No Git Repository</p>
		<p class="text-xs opacity-75 mt-1 max-w-[200px]">Open a folder containing a Git repository to use source control.</p>
	</div>
{:else}
	<div class="flex flex-col h-full bg-sidebar border-r border-border select-none relative font-sans text-xs">
		<!-- File List / Main Area -->
		<Tooltip.Provider delayDuration={400}>
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
					<div class="w-full flex items-center justify-between px-1 py-1 rounded hover:bg-muted/20 font-medium text-foreground/80">
						<button
							type="button"
							aria-expanded={stagedExpanded}
							aria-controls="git-staged-section"
							onclick={() => stagedExpanded = !stagedExpanded}
							class="flex flex-1 items-center gap-1.5 font-semibold text-[10px] uppercase text-muted-foreground text-left cursor-pointer"
						>
							Staged Changes
							<span class="px-1.5 py-0.5 text-[9px] rounded-full bg-primary/10 text-primary font-mono">{stagedChangesGrouped.length}</span>
							<CaretDownIcon size={11} class="transition-transform duration-200 {!stagedExpanded ? 'rotate-180' : ''}" />
						</button>
						<div class="flex items-center gap-1">
							<button
								type="button"
								onclick={() => appState.commands.execute('git.unstageAll')}
								class="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground cursor-pointer"
								title="Unstage all"
								aria-label="Unstage all"
							>
								<MinusIcon size={11} />
							</button>
						</div>
					</div>

					{#if stagedExpanded}
						<div id="git-staged-section" transition:slide={{ duration: 150 }} class="pl-1 space-y-0.5">
							{#if viewMode === 'list'}
								{#each stagedChangesGrouped as change (change.filepath)}
									<GitFileItem
										{change}
										isStaged={true}
										isSelected={selectedPaths.has(change.filepath)}
										isActive={repo?.activeDiffFile?.filepath === change.filepath}
										{selectedPaths}
										onclick={(e) => handleSelectPath(change.filepath, e as any, stagedChangesGrouped)}
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
					<div class="w-full flex items-center justify-between px-1 py-1 rounded hover:bg-muted/20 font-medium text-foreground/80">
						<button
							type="button"
							aria-expanded={changesExpanded}
							aria-controls="git-changes-section"
							onclick={() => changesExpanded = !changesExpanded}
							class="flex flex-1 items-center gap-1.5 font-semibold text-[10px] uppercase text-muted-foreground text-left cursor-pointer"
						>
							Changes
							<span class="px-1.5 py-0.5 text-[9px] rounded-full bg-amber-500/10 text-amber-500 font-mono">{unstagedChangesGrouped.length}</span>
							<CaretDownIcon size={11} class="transition-transform duration-200 {!changesExpanded ? 'rotate-180' : ''}" />
						</button>
						<div class="flex items-center gap-1">
							<button
								type="button"
								onclick={() => appState.commands.execute('git.stageAll')}
								class="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground cursor-pointer"
								title="Stage all changes"
								aria-label="Stage all changes"
							>
								<PlusIcon size={11} />
							</button>
							<button
								type="button"
								onclick={() => appState.commands.execute('git.discardAll')}
								class="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-destructive cursor-pointer"
								title="Discard all changes"
								aria-label="Discard all changes"
							>
								<ArrowCounterClockwiseIcon size={11} />
							</button>
						</div>
					</div>

					{#if changesExpanded}
						<div id="git-changes-section" transition:slide={{ duration: 150 }} class="pl-1 space-y-0.5">
							{#if viewMode === 'list'}
								{#each unstagedChangesGrouped as change (change.filepath)}
									<GitFileItem
										{change}
										isStaged={false}
										isSelected={selectedPaths.has(change.filepath)}
										isActive={repo?.activeDiffFile?.filepath === change.filepath}
										{selectedPaths}
										onclick={(e) => handleSelectPath(change.filepath, e as any, unstagedChangesGrouped)}
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

			<!-- UNTRACKED FILES -->
			{#if untrackedChangesGrouped.length > 0}
				<div class="space-y-1">
					<div class="w-full flex items-center justify-between px-1 py-1 rounded hover:bg-muted/20 font-medium text-foreground/80">
						<button
							type="button"
							aria-expanded={untrackedExpanded}
							aria-controls="git-untracked-section"
							onclick={() => untrackedExpanded = !untrackedExpanded}
							class="flex flex-1 items-center gap-1.5 font-semibold text-[10px] uppercase text-muted-foreground text-left cursor-pointer"
						>
							Untracked Files
							<span class="px-1.5 py-0.5 text-[9px] rounded-full bg-emerald-500/10 text-emerald-500 font-mono">{untrackedChangesGrouped.length}</span>
							<CaretDownIcon size={11} class="transition-transform duration-200 {!untrackedExpanded ? 'rotate-180' : ''}" />
						</button>
						<div class="flex items-center gap-1">
							<button
								type="button"
								onclick={async () => {
									for (const f of untrackedChangesGrouped) {
										await appState.commands.execute('git.stage', f.filepath);
									}
								}}
								class="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground cursor-pointer"
								title="Stage all untracked files"
								aria-label="Stage all untracked files"
							>
								<PlusIcon size={11} />
							</button>
							<button
								type="button"
								onclick={async () => {
									for (const f of untrackedChangesGrouped) {
										await appState.commands.execute('git.discard', f.filepath, { staged: false });
									}
								}}
								class="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-destructive cursor-pointer"
								title="Discard all untracked files"
								aria-label="Discard all untracked files"
							>
								<ArrowCounterClockwiseIcon size={11} />
							</button>
						</div>
					</div>

					{#if untrackedExpanded}
						<div id="git-untracked-section" transition:slide={{ duration: 150 }} class="pl-1 space-y-0.5">
							{#if viewMode === 'list'}
								{#each untrackedChangesGrouped as change (change.filepath)}
									<GitFileItem
										{change}
										isStaged={false}
										isSelected={selectedPaths.has(change.filepath)}
										isActive={repo?.activeDiffFile?.filepath === change.filepath}
										{selectedPaths}
										onclick={(e) => handleSelectPath(change.filepath, e as any, untrackedChangesGrouped)}
									/>
								{/each}
							{:else}
								<!-- Tree View Untracked -->
								{#each untrackedTree as node (node.path)}
									{@render renderTreeNode(node, false)}
								{/each}
							{/if}
						</div>
					{/if}
				</div>
			{/if}
		</div>
		</Tooltip.Provider>

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
							disabled={(repo.changes.filter(c => c.staged).length === 0 && !isAmend) || repo.isBusy || !commitMessage.trim()}
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
								onclick={() => { if (userConfig) { isSignoff = !isSignoff; } showCommitDropdown = false; }}
								disabled={!userConfig}
								class="w-full text-left px-3 py-1.5 text-xs hover:bg-accent flex items-center justify-between {isSignoff ? 'text-primary' : ''} {!userConfig ? 'opacity-50 cursor-not-allowed' : ''}"
								title={!userConfig ? "Git identity (user.name & user.email) not configured" : "Add Signed-off-by trailer"}
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

	</div>
{/if}

<!-- REUSABLE TREE NODE SNIPPET -->
{#snippet renderTreeNode(node: TreeNode, isStagedSection: boolean)}
	{@const isDir = node.kind === 'directory'}
	{@const sectionPrefix = isStagedSection ? 'staged:' : 'unstaged:'}
	{@const nodeKey = `${sectionPrefix}${node.path}`}
	{@const isCollapsed = collapsedDirs.has(nodeKey)}

	{#snippet treeRow()}
		<div
			role="button"
			tabindex="0"
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
					e.preventDefault();
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
		>
			<div class="flex items-center gap-1.5 min-w-0">
				{#if isDir}
					<button type="button" class="p-0.5 rounded hover:bg-muted/30 text-muted-foreground/60">
						<Icon resource={node.name} type="folder" folderOpen={!isCollapsed} size={14} />
					</button>
				{:else}
					{#if node.change}
						{#if isStagedSection}
							<GitStatusChip status="S" />
						{:else}
							<GitStatusChip status={node.change.status} />
						{/if}
					{/if}
					<Icon resource={node.path} size={14} class="shrink-0" />
				{/if}
				<span class="truncate">{node.name}</span>
			</div>

			<div class="flex items-center gap-1.5 shrink-0">
				{#if isDir}
					{@const stagingState = getFolderStagingState(node)}
					<div class="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
						<Checkbox
							checked={stagingState.checked}
							indeterminate={stagingState.indeterminate}
							onclick={(e) => { e.stopPropagation(); handleFolderCheckboxClick(node); }}
							class="scale-75"
						/>
					</div>
				{:else if node.change}
					{#if node.change.additions > 0 || node.change.deletions > 0}
						<div class="flex items-center gap-1 text-[9px] font-mono mr-1 opacity-80 pointer-events-none group-hover:opacity-0 group-focus-within:opacity-0 transition-opacity">
							{#if node.change.additions > 0}<span class="text-green-500">+{node.change.additions}</span>{/if}
							{#if node.change.deletions > 0}<span class="text-red-500">-{node.change.deletions}</span>{/if}
						</div>
					{/if}
					<div class="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
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
								onclick={(e) => { e.stopPropagation(); appState.commands.execute('git.discard', node.change!.filepath, { staged: false }); }}
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
			</div>
		</div>
	{/snippet}

	{#if !isDir && node.change}
		<ContextMenu.Root>
			<ContextMenu.Trigger>
				{@render treeRow()}
			</ContextMenu.Trigger>
			<ContextMenu.Content class="w-48 font-sans">
				{#if isStagedSection}
					<ContextMenu.Item onclick={() => runGitAction(appState, 'unstage', node.change!.filepath, { isStaged: true, selectedPaths })}>
						<MinusIcon size={11} />
						Unstage File
						<ContextMenu.Shortcut>
							{appState.keymaps.getShortcutForCommand('git.unstage')}
						</ContextMenu.Shortcut>
					</ContextMenu.Item>
				{:else}
					<ContextMenu.Item onclick={() => runGitAction(appState, 'stage', node.change!.filepath, { isStaged: false, selectedPaths })}>
						<PlusIcon size={11} />
						Stage File
						<ContextMenu.Shortcut>
							{appState.keymaps.getShortcutForCommand('git.stage')}
						</ContextMenu.Shortcut>
					</ContextMenu.Item>
					<ContextMenu.Item
						onclick={() => runGitAction(appState, 'discard', node.change!.filepath, { isStaged: false, selectedPaths })}
						class="text-destructive focus:text-destructive hover:!bg-destructive/10"
					>
						<TrashIcon size={11} />
						Discard Changes
						<ContextMenu.Shortcut>
							{appState.keymaps.getShortcutForCommand('git.discard')}
						</ContextMenu.Shortcut>
					</ContextMenu.Item>
				{/if}
				<ContextMenu.Separator />
				<ContextMenu.Item onclick={() => runGitAction(appState, 'diff', node.change!.filepath, { isStaged: isStagedSection })}>
					<GitDiffIcon size={11} />
					Open Diff
					<ContextMenu.Shortcut>
						{appState.keymaps.getShortcutForCommand('git.openDiff')}
					</ContextMenu.Shortcut>
				</ContextMenu.Item>
			</ContextMenu.Content>
		</ContextMenu.Root>
	{:else}
		{@render treeRow()}
	{/if}

	{#if isDir && !isCollapsed && node.children}
		<div class="pl-3.5 border-l border-border/40 ml-2.5 space-y-0.5">
			{#each node.children as child (child.path)}
				{@render renderTreeNode(child, isStagedSection)}
			{/each}
		</div>
	{/if}
{/snippet}
