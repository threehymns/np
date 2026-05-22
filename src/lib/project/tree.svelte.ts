import { appState } from '../state.svelte';
import { saveExpandedPaths, loadExpandedPaths } from '../persistence';
import { SvelteSet } from 'svelte/reactivity';
import { browserHandleRegistry, toURI, type FileOrigin } from '../storage';

export interface TreeNode {
	name: string;
	kind: 'file' | 'directory';
	origin: FileOrigin;
	parentOrigin?: FileOrigin;
	children?: TreeNode[];
	isExpanded: boolean;
}

export interface VisualNode {
	name: string;
	kind: 'file' | 'directory';
	origin: FileOrigin;
	parentOrigin?: FileOrigin;
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
	private expandedPaths = new SvelteSet<string>();
	private initPromise: Promise<void> | null = null;
	private isRestoring = $state(false);

	constructor() {
		if (typeof window !== 'undefined') {
			this.isRestoring = true;
			this.initPromise = this.loadExpansionState().finally(() => {
				this.isRestoring = false;
			});
			
			$effect.root(() => {
				$effect(() => {
					if (this.isRestoring) return;
					// Persist expanded paths (pruned)
					const paths = Array.from(this.expandedPaths)
						.filter(p => !p.includes('node_modules') && !p.includes('.svelte-kit') && !p.includes('.git'))
						.slice(0, 500);
					saveExpandedPaths(paths);
				});
			});
		}
	}

	private async loadExpansionState() {
		try {
			// Add a safety timeout of 2 seconds
			const paths = await Promise.race([
				loadExpandedPaths(),
				new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error('Timeout loading expansion state')), 2000))
			]);
			
			// Prune heavy folders and limit count
			let count = 0;
			for (const path of paths) {
				if (path.includes('node_modules') || path.includes('.svelte-kit') || path.includes('.git')) continue;
				if (count++ > 500) break; // Limit to 500 expanded folders max
				this.expandedPaths.add(path);
			}
		} catch (e) {
			console.warn('[Tree] Failed to load expansion state:', e);
		}
	}

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
					let safety = 0;
					while (
						current.children && 
						current.children.length === 1 && 
						current.children[0].kind === 'directory' &&
						safety++ < 100
					) {
						current = current.children[0];
						pathNames.push(current.name);
					}
					
					const visualNode: VisualNode = {
						name: pathNames.join('/'),
						kind: 'directory',
						origin: current.origin,
						parentOrigin: node.parentOrigin,
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
						origin: node.origin,
						parentOrigin: node.parentOrigin,
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
		if (!appState.workspace.rootOrigin) return;
		
		if (this.searchAbortController) {
			this.searchAbortController.abort();
		}
		this.searchAbortController = new AbortController();
		const signal = this.searchAbortController.signal;

		const q = query.toLowerCase();

		const search = async (origin: FileOrigin, path = ""): Promise<TreeNode[] | null> => {
			if (signal.aborted) return null;
			const matchedChildren: TreeNode[] = [];
			
			try {
				const entries = await appState.workspace.storage.readDirectory(origin);
				for (const entry of entries) {
					if (signal.aborted) return null;

					const entryPath = path ? `${path}/${entry.name}` : entry.name;
					
					// Hard ignores for heavy folders
					if (entry.name === 'node_modules' || entry.name === '.svelte-kit' || entry.name === '.git') continue;
					if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
					if (this.gitignore?.ignores(entryPath)) continue;

					let childrenMatch: TreeNode[] | null = null;
					if (entry.kind === 'directory') {
						childrenMatch = await search(entry.origin, entryPath);
					}

					const nameMatch = entry.name.toLowerCase().includes(q);
					
					if (nameMatch || (childrenMatch && childrenMatch.length > 0)) {
						matchedChildren.push({
							name: entry.name,
							kind: entry.kind,
							origin: entry.origin,
							parentOrigin: origin,
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

		const found = await search(appState.workspace.rootOrigin);
		if (!signal.aborted) {
			this.searchResults = found || [];
			this.isSearching = false;
		}
	}

	async scan(rootOrigin: FileOrigin) {
		if (!appState.workspace.hasRootPermission) {
			return;
		}
		if (this.initPromise) {
			await this.initPromise;
		}
		this.isScanning = true;
		try {
			// Load .gitignore if it exists
			try {
				const gitignoreOrigin: FileOrigin = {
					scheme: rootOrigin.scheme,
					path: rootOrigin.path ? `${rootOrigin.path}/.gitignore` : '.gitignore',
					name: '.gitignore'
				};
				const content = await appState.workspace.storage.readFile(gitignoreOrigin);
				this.gitignore = new GitIgnoreMatcher(content);
			} catch (e) {
				this.gitignore = null;
			}

			this.nodes = await this.buildLevel(rootOrigin);
		} catch (e) {
			console.error('[Tree] Scan failed', e);
		} finally {
			this.isScanning = false;
		}
	}

	private async buildLevel(origin: FileOrigin, path = ""): Promise<TreeNode[]> {
		const nodes: TreeNode[] = [];
		try {
			let i = 0;
			const entries = await appState.workspace.storage.readDirectory(origin);
			for (const entry of entries) {
				// Yield every 50 items to keep UI responsive
				if (++i % 50 === 0) {
					await new Promise(resolve => setTimeout(resolve, 0));
				}

				const entryPath = path ? `${path}/${entry.name}` : entry.name;
				
				// Hard ignores for heavy folders
				if (entry.name === 'node_modules' || entry.name === '.svelte-kit' || entry.name === '.git') continue;
				if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
				if (this.gitignore?.ignores(entryPath)) continue;

				const isExpanded = this.expandedPaths.has(entryPath);
				const node: TreeNode = {
					name: entry.name,
					kind: entry.kind,
					origin: entry.origin,
					parentOrigin: origin,
					isExpanded,
					children: entry.kind === 'directory' ? [] : undefined
				};

				if (isExpanded && node.kind === 'directory') {
					node.children = await this.buildLevel(entry.origin, entryPath);
				}

				nodes.push(node);
			}
		} catch (e) {
			console.warn(`[Tree] Failed to build level for ${path || 'root'}`, e);
		}

		return nodes.sort((a, b) => {
			if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
	}

	async toggleExpand(node: TreeNode) {
		node.isExpanded = !node.isExpanded;
		const path = await this.getNodePath(node);
		
		if (node.isExpanded) {
			this.expandedPaths.add(path);
			if (node.kind === 'directory' && node.children?.length === 0) {
				node.children = await this.buildLevel(node.origin, path);
			}
		} else {
			this.expandedPaths.delete(path);
		}
	}

	private async getNodePath(node: TreeNode): Promise<string> {
		if (!appState.workspace.rootOrigin) return node.name;
		const rootOrigin = appState.workspace.rootOrigin;
		if (node.origin.path === rootOrigin.path) return '';
		if (node.origin.path.startsWith(rootOrigin.path + '/')) {
			return node.origin.path.slice(rootOrigin.path.length + 1);
		}
		return node.name;
	}

	async createFile(parentOrigin: FileOrigin, name: string, parentNode?: TreeNode) {
		await appState.workspace.storage.createFile(parentOrigin, name);
		if (parentNode) {
			parentNode.children = await this.buildLevel(parentOrigin);
			parentNode.isExpanded = true;
		} else {
			await this.scan(appState.workspace.rootOrigin!);
		}
	}

	async createDirectory(parentOrigin: FileOrigin, name: string, parentNode?: TreeNode) {
		await appState.workspace.storage.createDirectory(parentOrigin, name);
		if (parentNode) {
			parentNode.children = await this.buildLevel(parentOrigin);
			parentNode.isExpanded = true;
		} else {
			await this.scan(appState.workspace.rootOrigin!);
		}
	}

	async deleteEntry(node: TreeNode) {
		await appState.workspace.storage.deleteEntry(node.origin);
		await this.scan(appState.workspace.rootOrigin!);
	}

	async renameEntry(node: TreeNode, newName: string) {
		const newOrigin = await appState.workspace.storage.renameEntry(node.origin, newName);
		
		// Update any open documents that match this origin
		for (const doc of appState.documents) {
			if (doc.origin && toURI(doc.origin) === toURI(node.origin)) {
				doc.origin = newOrigin;
			}
		}

		await this.scan(appState.workspace.rootOrigin!);
	}
}
