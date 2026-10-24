import { SvelteSet } from 'svelte/reactivity';
import { toURI, type FileOrigin, type Storage } from '../storage';
import { isNotFoundError } from '../utils';
import type { TreeNode } from './tree.svelte';

export interface FileSnapshot {
	readonly root: FileOrigin;
	readonly entries: TreeNode[];
	readonly version: number;
}

export type SnapshotListener = (snapshot: FileSnapshot) => void;

export interface WorktreeSnapshotStrategy {
	readonly name: string;
	start?(worktree: Worktree): void | Promise<void>;
	stop?(): void | Promise<void>;
	refresh?(worktree: Worktree): Promise<void>;
}

export class PolledSnapshotStrategy implements WorktreeSnapshotStrategy {
	readonly name = 'polled';

	async refresh(worktree: Worktree): Promise<void> {
		await worktree.scan();
	}

	stop(): void {}
}

export interface WorktreeOptions {
	storage?: Storage;
	strategy?: WorktreeSnapshotStrategy;
	entries?: TreeNode[];
}

export interface WorktreeScanOptions {
	/**
	 * Marks a path as expanded in the published snapshot. Display state
	 * only: it never changes which files the snapshot contains.
	 */
	isExpanded?: (path: string) => boolean;
	signal?: AbortSignal;
}

export class GitIgnoreMatcher {
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

/**
 * A Worktree represents a filesystem checkout within a Project.
 *
 * Per ADR 0025, Worktree owns the live file snapshot: the scanner lives here,
 * external watchers (ticket 2) and search (ticket 3) consume this snapshot,
 * and the file explorer tree subscribes to it rather than feeding entries in.
 *
 * Per ADR 0032, the snapshot is always the whole project file set. Which
 * files a scan publishes never depends on who triggered it: the tree's scan,
 * a watcher's rescan and the polled refresh all publish the same files.
 * Expansion state is display only, so the tree filters the snapshot for
 * display instead of narrowing what the snapshot contains.
 */
export function entriesEqual(a: readonly TreeNode[], b: readonly TreeNode[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const nodeA = a[i];
		const nodeB = b[i];
		if (nodeA.name !== nodeB.name || nodeA.kind !== nodeB.kind) return false;
		if (nodeA.kind === "directory" || nodeB.kind === "directory") {
			const childrenA = nodeA.children ?? [];
			const childrenB = nodeB.children ?? [];
			if (!entriesEqual(childrenA, childrenB)) return false;
		}
	}
	return true;
}

export class Worktree {
	root: FileOrigin;
	storage: Storage | null = null;
	strategy: WorktreeSnapshotStrategy;
	gitignore: GitIgnoreMatcher | null = null;

	private _entries = $state<TreeNode[]>([]);
	private _version = $state(0);
	private listeners = new SvelteSet<SnapshotListener>();
	private scanGeneration = 0;
	private isScanning = $state(false);
	/**
	 * The expansion predicate the file explorer handed us last. Remembered
	 * so a scan that carries none (a watcher's rescan) keeps publishing the
	 * display state the tree already had.
	 */
	private expansionProvider: ((path: string) => boolean) | null = null;

	constructor(
		root: FileOrigin,
		optionsOrStorageOrEntries?: Storage | WorktreeOptions | TreeNode[],
		initialEntries: TreeNode[] = []
	) {
		this.root = root;
		if (Array.isArray(optionsOrStorageOrEntries)) {
			this._entries = optionsOrStorageOrEntries;
			this.strategy = new PolledSnapshotStrategy();
		} else if (
			optionsOrStorageOrEntries &&
			'readDirectory' in optionsOrStorageOrEntries &&
			typeof (optionsOrStorageOrEntries as any).readDirectory === 'function'
		) {
			this.storage = optionsOrStorageOrEntries as Storage;
			this._entries = initialEntries;
			this.strategy = new PolledSnapshotStrategy();
		} else if (optionsOrStorageOrEntries && typeof optionsOrStorageOrEntries === 'object') {
			const opts = optionsOrStorageOrEntries as WorktreeOptions;
			this.storage = opts.storage ?? null;
			this.strategy = opts.strategy ?? new PolledSnapshotStrategy();
			this._entries = opts.entries ?? initialEntries;
		} else {
			this._entries = initialEntries;
			this.strategy = new PolledSnapshotStrategy();
		}
	}

	get entries(): TreeNode[] {
		return this._entries;
	}

	set entries(nodes: TreeNode[]) {
		this.updateSnapshot(nodes);
	}

	get version(): number {
		return this._version;
	}

	get snapshot(): FileSnapshot {
		return {
			root: this.root,
			entries: this._entries,
			version: this._version
		};
	}

	get scanning(): boolean {
		return this.isScanning;
	}

	subscribe(listener: SnapshotListener): () => void {
		this.listeners.add(listener);
		listener(this.snapshot);
		return () => {
			this.listeners.delete(listener);
		};
	}

	updateSnapshot(entries: TreeNode[]): void {
		if (this._version === 0 || !entriesEqual(this._entries, entries)) {
			this._version++;
		}
		this._entries = entries;
		this.notify();
	}

	notifyEntriesChanged(): void {
		this._version++;
		this.notify();
	}

	notify(): void {
		const snap = this.snapshot;
		for (const listener of this.listeners) {
			try {
				listener(snap);
			} catch (e) {
				console.error('[Worktree] Error in snapshot listener:', e);
			}
		}
	}

	async refresh(): Promise<void> {
		if (this.strategy.refresh) {
			await this.strategy.refresh(this);
		} else {
			await this.scan();
		}
	}

	async scan(
		rootOrigin?: FileOrigin,
		options?: WorktreeScanOptions
	): Promise<TreeNode[]> {
		const targetRoot = rootOrigin ?? this.root;
		if (!this.storage) {
			return this._entries;
		}

		const generation = ++this.scanGeneration;
		this.isScanning = true;
		try {
			// The matcher belongs to this scan: an overlapping rescan must
			// not filter entries with another scan's rules.
			let scanGitignore: GitIgnoreMatcher | null = null;
			try {
				const gitignoreOrigin: FileOrigin = {
					scheme: targetRoot.scheme,
					path: targetRoot.path ? `${targetRoot.path}/.gitignore` : '.gitignore',
					name: '.gitignore'
				};
				const content = await this.storage.readFile(gitignoreOrigin);
				scanGitignore = new GitIgnoreMatcher(content);
			} catch (e: any) {
				if (!isNotFoundError(e)) {
					console.warn('[Worktree] Error reading .gitignore:', e);
				}
			}

			// Remember the expansion predicate so a later scan without one
			// publishes the same display state. It never changes the file set.
			if (options?.isExpanded) {
				this.expansionProvider = options.isExpanded;
			}
			const isExpanded = options?.isExpanded ?? this.expansionProvider ?? undefined;

			// The whole project file set, every time: the snapshot does not
			// depend on who triggered the scan (ADR 0032).
			const builtNodes = await this.buildLevel(targetRoot, '', isExpanded, scanGitignore);
			if (generation === this.scanGeneration && toURI(targetRoot) === toURI(this.root)) {
				this.gitignore = scanGitignore;
				this.updateSnapshot(builtNodes);
			}
			return builtNodes;
		} catch (e) {
			console.error('[Worktree] Scan failed', e);
			return this._entries;
		} finally {
			if (generation === this.scanGeneration) {
				this.isScanning = false;
			}
		}
	}

	async buildLevel(
		origin: FileOrigin,
		path = '',
		isExpanded?: (path: string) => boolean,
		matcher: GitIgnoreMatcher | null = this.gitignore
	): Promise<TreeNode[]> {
		if (!this.storage) return [];
		const nodes: TreeNode[] = [];
		try {
			let i = 0;
			const entries = await this.storage.readDirectory(origin);
			for (const entry of entries) {
				if (++i % 50 === 0) {
					await new Promise((resolve) => setTimeout(resolve, 0));
				}

				const entryPath = path ? `${path}/${entry.name}` : entry.name;

				if (entry.name === 'node_modules' || entry.name === '.svelte-kit' || entry.name === '.git') continue;
				if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
				if (matcher?.ignores(entryPath)) continue;

				const node: TreeNode = {
					name: entry.name,
					kind: entry.kind,
					origin: entry.origin,
					parentOrigin: origin,
					isExpanded: isExpanded ? isExpanded(entryPath) : false,
					children: entry.kind === 'directory' ? [] : undefined
				};

				if (node.kind === 'directory') {
					node.children = await this.buildLevel(entry.origin, entryPath, isExpanded, matcher);
				}

				nodes.push(node);
			}
		} catch (e) {
			console.warn(`[Worktree] Failed to build level for ${path || 'root'}`, e);
		}

		return nodes.sort((a, b) => {
			if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
	}

	dispose(): void {
		this.strategy.stop?.();
		this.listeners.clear();
	}
}
