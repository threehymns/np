import { appState } from '../state.svelte';

export interface TreeNode {
	name: string;
	kind: 'file' | 'directory';
	handle: FileSystemFileHandle | FileSystemDirectoryHandle;
	parentHandle?: FileSystemDirectoryHandle;
	children?: TreeNode[];
	isExpanded: boolean;
}

export interface VisualNode {
	name: string;
	kind: 'file' | 'directory';
	handle: FileSystemFileHandle | FileSystemDirectoryHandle;
	parentHandle?: FileSystemDirectoryHandle;
	children?: VisualNode[];
	isExpanded: boolean;
	originalNode: TreeNode;
	leafNode: TreeNode;
	depth: number;
}

class GitIgnoreMatcher {
	private patterns: { regex: RegExp; negative: boolean }[] = [];

	constructor(content: string) {
		const lines = content.split(/\r?\n/);
		for (let line of lines) {
			line = line.trim();
			if (!line || line.startsWith('#')) continue;

			let negative = false;
			if (line.startsWith('!')) {
				negative = true;
				line = line.substring(1);
			}

			// Simple glob to regex conversion
			let pattern = line
				.replace(/\./g, '\\.')
				.replace(/\*\*/g, '(.+)')
				.replace(/\*/g, '([^/]+)')
				.replace(/\?/g, '(.)')
				.replace(/\/$/, '');
			
			if (pattern.startsWith('/')) {
				pattern = '^' + pattern.substring(1);
			} else {
				pattern = '(^|/)' + pattern;
			}

			try {
				this.patterns.push({
					regex: new RegExp(pattern),
					negative
				});
			} catch (e) {
				console.warn('Invalid gitignore pattern:', line);
			}
		}
	}

	ignores(path: string): boolean {
		let ignored = false;
		for (const { regex, negative } of this.patterns) {
			if (regex.test(path)) {
				ignored = !negative;
			}
		}
		return ignored;
	}
}

export class ProjectTree {
	nodes = $state<TreeNode[]>([]);
	isScanning = $state(false);
	isSearching = $state(false);
	searchQuery = $state("");
	private gitignore: GitIgnoreMatcher | null = null;
	private searchResults = $state<TreeNode[]>([]);
	private searchAbortController: AbortController | null = null;

	filteredNodes = $derived.by(() => {
		if (!this.searchQuery) return this.nodes;
		return this.searchResults;
	});

	visualNodes = $derived.by(() => {
		const flatten = (nodes: TreeNode[], depth = 0): VisualNode[] => {
			return nodes.map(node => {
				if (node.kind === 'directory') {
					let current = node;
					const pathNames = [current.name];
					
					// Concatenate only if children are already loaded AND there is exactly one directory child
					// If children are not loaded (length 0 but directory kind), we stop concatenation
					while (
						current.children && 
						current.children.length === 1 && 
						current.children[0].kind === 'directory'
					) {
						current = current.children[0];
						pathNames.push(current.name);
					}
					
					const visualNode: VisualNode = {
						name: pathNames.join('/'),
						kind: 'directory',
						handle: current.handle,
						parentHandle: node.parentHandle,
						isExpanded: current.isExpanded,
						children: [],
						originalNode: node,
						leafNode: current,
						depth
					};

					if (current.isExpanded && current.children && current.children.length > 0) {
						visualNode.children = flatten(current.children, depth + 1);
					}

					return visualNode;
				} else {
					return {
						name: node.name,
						kind: node.kind,
						handle: node.handle,
						parentHandle: node.parentHandle,
						isExpanded: node.isExpanded,
						children: undefined,
						originalNode: node,
						leafNode: node,
						depth
					};
				}
			});
		};

		return flatten(this.filteredNodes);
	});

	// Use an effect to update search results when query changes
	private searchEffect = $effect.root(() => {
		$effect(() => {
			const query = this.searchQuery.trim();
			if (!query) {
				if (this.searchAbortController) {
					this.searchAbortController.abort();
					this.searchAbortController = null;
				}
				this.searchResults = [];
				this.isSearching = false;
				return;
			}

			// Show loading immediately
			this.isSearching = true;

			// Debounce search slightly
			const timer = setTimeout(() => {
				this.performSearch(query);
			}, 150);

			return () => clearTimeout(timer);
		});
	});

	private async performSearch(query: string) {
		if (!appState.workspace.rootHandle) return;
		
		if (this.searchAbortController) {
			this.searchAbortController.abort();
		}
		this.searchAbortController = new AbortController();
		const signal = this.searchAbortController.signal;

		const q = query.toLowerCase();

		const search = async (handle: FileSystemDirectoryHandle, path = ""): Promise<TreeNode[] | null> => {
			if (signal.aborted) return null;
			const matchedChildren: TreeNode[] = [];
			
			try {
				for await (const entry of handle.values()) {
					if (signal.aborted) return null;

					const entryPath = path ? `${path}/${entry.name}` : entry.name;
					
					if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
					if (this.gitignore?.ignores(entryPath)) continue;

					let childrenMatch: TreeNode[] | null = null;
					if (entry.kind === 'directory') {
						childrenMatch = await search(entry as FileSystemDirectoryHandle, entryPath);
					}

					const nameMatch = entry.name.toLowerCase().includes(q);
					
					if (nameMatch || (childrenMatch && childrenMatch.length > 0)) {
						matchedChildren.push({
							name: entry.name,
							kind: entry.kind as 'file' | 'directory',
							handle: entry,
							parentHandle: handle,
							isExpanded: true,
							children: childrenMatch || (entry.kind === 'directory' ? [] : undefined)
						});
					}
				}
			} catch (e) {
				return null;
			}

			return matchedChildren.length > 0 ? matchedChildren.sort((a, b) => {
				if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
				return a.name.localeCompare(b.name);
			}) : null;
		};

		const found = await search(appState.workspace.rootHandle);
		if (!signal.aborted) {
			this.searchResults = found || [];
			this.isSearching = false;
		}
	}

	async scan(rootHandle: FileSystemDirectoryHandle) {
		this.isScanning = true;
		try {
			// Load .gitignore if it exists
			try {
				const fileHandle = await rootHandle.getFileHandle('.gitignore');
				const file = await fileHandle.getFile();
				const content = await file.text();
				this.gitignore = new GitIgnoreMatcher(content);
			} catch (e) {
				this.gitignore = null;
			}

			this.nodes = await this.buildLevel(rootHandle);
		} finally {
			this.isScanning = false;
		}
	}

	private async buildLevel(handle: FileSystemDirectoryHandle, path = ""): Promise<TreeNode[]> {
		const nodes: TreeNode[] = [];
		for await (const entry of handle.values()) {
			const entryPath = path ? `${path}/${entry.name}` : entry.name;
			
			if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
			if (this.gitignore?.ignores(entryPath)) continue;

			const node: TreeNode = {
				name: entry.name,
				kind: entry.kind as 'file' | 'directory',
				handle: entry,
				parentHandle: handle,
				isExpanded: false,
				children: entry.kind === 'directory' ? [] : undefined
			};
			nodes.push(node);
		}

		return nodes.sort((a, b) => {
			if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
	}

	async toggleExpand(node: TreeNode) {
		node.isExpanded = !node.isExpanded;
		if (node.isExpanded && node.kind === 'directory' && node.children?.length === 0) {
			// We need to calculate the path for gitignore
			const path = await this.getNodePath(node);
			node.children = await this.buildLevel(node.handle as FileSystemDirectoryHandle, path);
		}
	}

	private async getNodePath(node: TreeNode): Promise<string> {
		if (!appState.workspace.rootHandle) return node.name;
		const path = await appState.workspace.rootHandle.resolve(node.handle);
		return path ? path.join('/') : node.name;
	}

	async createFile(parentHandle: FileSystemDirectoryHandle, name: string, parentNode?: TreeNode) {
		await (appState.workspace as any).storage.createFile(parentHandle, name);
		if (parentNode) {
			parentNode.children = await this.buildLevel(parentHandle);
			parentNode.isExpanded = true;
		} else {
			await this.scan(appState.workspace.rootHandle!);
		}
	}

	async createDirectory(parentHandle: FileSystemDirectoryHandle, name: string, parentNode?: TreeNode) {
		await (appState.workspace as any).storage.createDirectory(parentHandle, name);
		if (parentNode) {
			parentNode.children = await this.buildLevel(parentHandle);
			parentNode.isExpanded = true;
		} else {
			await this.scan(appState.workspace.rootHandle!);
		}
	}

	async deleteEntry(node: TreeNode) {
		if (!node.parentHandle) return;
		await (appState.workspace as any).storage.deleteEntry(node.parentHandle, node.name);
		await this.scan(appState.workspace.rootHandle!);
	}

	async renameEntry(node: TreeNode, newName: string) {
		await (appState.workspace as any).storage.renameEntry(node.handle, newName);
		
		// Update any open documents that match this handle
		for (const doc of appState.documents) {
			if (doc.origin?.handle === node.handle) {
				doc.origin = { ...doc.origin, name: newName };
			}
		}

		await this.scan(appState.workspace.rootHandle!);
	}
}
