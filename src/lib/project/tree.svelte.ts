import { appState } from '../state.svelte';

export interface TreeNode {
	name: string;
	kind: 'file' | 'directory';
	handle: FileSystemFileHandle | FileSystemDirectoryHandle;
	parentHandle?: FileSystemDirectoryHandle;
	children?: TreeNode[];
	isExpanded: boolean;
}

export class ProjectTree {
	nodes = $state<TreeNode[]>([]);
	isScanning = $state(false);
	searchQuery = $state("");

	filteredNodes = $derived.by(() => {
		if (!this.searchQuery) return this.nodes;
		const query = this.searchQuery.toLowerCase();
		
		const filter = (nodes: TreeNode[]): TreeNode[] | null => {
			const filtered: TreeNode[] = [];
			for (const node of nodes) {
				let childrenMatch: TreeNode[] | null = null;
				if (node.children) {
					childrenMatch = filter(node.children);
				}

				const nameMatch = node.name.toLowerCase().includes(query);
				
				if (nameMatch || (childrenMatch && childrenMatch.length > 0)) {
					filtered.push({
						...node,
						// If children matched, show them, otherwise show original children
						children: childrenMatch ?? node.children,
						// Auto-expand if we are searching and there's a match inside
						isExpanded: this.searchQuery ? true : node.isExpanded
					});
				}
			}
			return filtered.length > 0 ? filtered : null;
		};

		return filter(this.nodes) || [];
	});

	async scan(rootHandle: FileSystemDirectoryHandle) {
		this.isScanning = true;
		try {
			this.nodes = await this.buildTree(rootHandle);
		} finally {
			this.isScanning = false;
		}
	}

	private async buildTree(handle: FileSystemDirectoryHandle, parentHandle?: FileSystemDirectoryHandle): Promise<TreeNode[]> {
		const nodes: TreeNode[] = [];
		for await (const entry of handle.values()) {
			if (entry.name.startsWith('.')) continue;

			const node: TreeNode = {
				name: entry.name,
				kind: entry.kind as 'file' | 'directory',
				handle: entry,
				parentHandle: handle,
				isExpanded: false
			};

			if (entry.kind === 'directory') {
				node.children = await this.buildTree(entry, entry);
			}
			nodes.push(node);
		}

		return nodes.sort((a, b) => {
			if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
	}

	toggleExpand(node: TreeNode) {
		node.isExpanded = !node.isExpanded;
	}

	async createFile(parent: FileSystemDirectoryHandle, name: string) {
		await (appState.workspace as any).storage.createFile(parent, name);
		await this.scan(appState.workspace.rootHandle!);
	}

	async createDirectory(parent: FileSystemDirectoryHandle, name: string) {
		await (appState.workspace as any).storage.createDirectory(parent, name);
		await this.scan(appState.workspace.rootHandle!);
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
