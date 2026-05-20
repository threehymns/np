export interface TreeNode {
	name: string;
	kind: 'file' | 'directory';
	handle: FileSystemFileHandle | FileSystemDirectoryHandle;
	children?: TreeNode[];
	isExpanded: boolean;
}

export class ProjectTree {
	nodes = $state<TreeNode[]>([]);
	isScanning = $state(false);

	async scan(rootHandle: FileSystemDirectoryHandle) {
		this.isScanning = true;
		try {
			this.nodes = await this.buildTree(rootHandle);
		} finally {
			this.isScanning = false;
		}
	}

	private async buildTree(handle: FileSystemDirectoryHandle): Promise<TreeNode[]> {
		const nodes: TreeNode[] = [];
		for await (const entry of handle.values()) {
			const node: TreeNode = {
				name: entry.name,
				kind: entry.kind as 'file' | 'directory',
				handle: entry,
				isExpanded: false
			};

			if (entry.kind === 'directory') {
				// We don't scan children immediately to keep it fast, 
				// or we can scan everything if the project is small.
				// Let's do a deep scan for now but we could optimize later.
				node.children = await this.buildTree(entry);
			}
			nodes.push(node);
		}

		// Sort: directories first, then alphabetically
		return nodes.sort((a, b) => {
			if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
	}

	toggleExpand(node: TreeNode) {
		node.isExpanded = !node.isExpanded;
	}
}
