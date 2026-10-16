import type { FileOrigin } from '../storage';
import type { TreeNode } from '../project/tree.svelte';
import type { Worktree, FileSnapshot } from '../project/worktree.svelte';
import type {
	SearchBackend,
	SearchQuery,
	SearchOptions,
	SearchResultStream as ISearchResultStream,
	FileSearchResult,
	SearchMatch,
	SearchProgress,
	SearchMatchContextLine
} from './types';

export const DEFAULT_MAX_FILES = 5000;
export const DEFAULT_MAX_MATCHES = 10000;
export const SNIFF_SIZE = 8192; // 8 KB cheap sniff

const DEFAULT_IGNORED_DIRS = new Set([
	'node_modules',
	'.git',
	'.svelte-kit',
	'dist',
	'build',
	'out'
]);

export interface FlattenedFile {
	origin: FileOrigin;
	relativePath: string;
}

export class SearchResultStream implements ISearchResultStream {
	readonly progress: SearchProgress = {
		scannedFiles: 0,
		matchedFiles: 0,
		totalMatches: 0,
		truncated: false
	};

	private abortController: AbortController;
	private generator: AsyncGenerator<FileSearchResult, void, unknown>;

	constructor(
		generatorFactory: (
			signal: AbortSignal,
			progress: SearchProgress
		) => AsyncGenerator<FileSearchResult, void, unknown>,
		externalSignal?: AbortSignal
	) {
		this.abortController = new AbortController();
		if (externalSignal) {
			if (externalSignal.aborted) {
				this.abortController.abort();
			} else {
				externalSignal.addEventListener('abort', () => this.abortController.abort(), { once: true });
			}
		}
		this.generator = generatorFactory(this.abortController.signal, this.progress);
	}

	[Symbol.asyncIterator](): AsyncGenerator<FileSearchResult, void, unknown> {
		return this.generator;
	}

	cancel(): void {
		this.abortController.abort();
	}

	async all(): Promise<FileSearchResult[]> {
		const results: FileSearchResult[] = [];
		for await (const item of this) {
			results.push(item);
		}
		return results;
	}
}

/**
 * Hand-rolled Zed-style TypeScript search engine behind the SearchBackend seam (ADR 0026).
 *
 * Characteristics:
 * - Persistent in-process: caches file contents across queries, invalidates when snapshot version updates.
 * - Reads ONLY the Worktree snapshot: extracts files from snapshot entries in-memory, never walks the disk.
 * - Zed-style two-phase scan: cheap 8 KB sniff per file (binary check + substring check), full match only on hits.
 * - Respects .gitignore and skips node_modules/build output by default.
 * - Caps at 5,000 files / 10,000 matches with truncation notice.
 * - Literal matching only (v1).
 * - Streaming results out via AsyncIterable.
 */
export class TypeScriptSearchEngine implements SearchBackend {
	private worktree: Worktree | null = null;
	private fileCache = new Map<string, { content: string; version: number }>();
	private worktreeUnsubscribe: (() => void) | null = null;

	constructor(worktree?: Worktree | null) {
		if (worktree) {
			this.attachToWorktree(worktree);
		}
	}

	attachToWorktree(worktree: Worktree | null): void {
		if (this.worktree === worktree) return;
		if (this.worktreeUnsubscribe) {
			this.worktreeUnsubscribe();
			this.worktreeUnsubscribe = null;
		}
		this.worktree = worktree;
		this.fileCache.clear();

		if (worktree) {
			this.worktreeUnsubscribe = worktree.subscribe((snapshot) => {
				// Clear or prune cached files on external snapshot update
				this.pruneCache(snapshot.version);
			});
		}
	}

	private pruneCache(currentVersion: number): void {
		for (const [key, value] of this.fileCache.entries()) {
			if (value.version < currentVersion) {
				this.fileCache.delete(key);
			}
		}
	}

	dispose(): void {
		if (this.worktreeUnsubscribe) {
			this.worktreeUnsubscribe();
			this.worktreeUnsubscribe = null;
		}
		this.fileCache.clear();
		this.worktree = null;
	}

	/**
	 * Extract all candidate files strictly from snapshot entries in memory.
	 * Never walks disk or calls readDirectory.
	 */
	collectFilesFromSnapshot(entries: TreeNode[], parentPath = ''): FlattenedFile[] {
		const files: FlattenedFile[] = [];

		for (const node of entries) {
			const relPath = parentPath ? `${parentPath}/${node.name}` : node.name;

			// Skip ignored dirs like node_modules or build output
			if (node.kind === 'directory') {
				if (DEFAULT_IGNORED_DIRS.has(node.name)) {
					continue;
				}
				if (this.worktree?.gitignore?.ignores(relPath)) {
					continue;
				}
				if (node.children) {
					files.push(...this.collectFilesFromSnapshot(node.children, relPath));
				}
			} else if (node.kind === 'file') {
				// Skip if path has any ignored directory component
				const parts = relPath.split('/');
				if (parts.some((p) => DEFAULT_IGNORED_DIRS.has(p))) {
					continue;
				}
				if (this.worktree?.gitignore?.ignores(relPath)) {
					continue;
				}
				files.push({
					origin: node.origin,
					relativePath: relPath
				});
			}
		}

		return files;
	}

	search(query: SearchQuery, options?: SearchOptions): SearchResultStream {
		const pattern = query?.pattern ?? '';
		const maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;
		const maxMatches = options?.maxMatches ?? DEFAULT_MAX_MATCHES;
		const contextLines = options?.contextLines ?? 1;

		return new SearchResultStream(
			async function* (this: TypeScriptSearchEngine, signal: AbortSignal, progress: SearchProgress) {
				if (!pattern || !this.worktree) {
					return;
				}

				const snapshot: FileSnapshot = this.worktree.snapshot;
				// The engine reads ONLY the Worktree snapshot — it never walks the disk itself
				const files = this.collectFilesFromSnapshot(snapshot.entries);

				for (const file of files) {
					if (signal.aborted) {
						break;
					}

					// Cap at 5,000 files
					if (progress.scannedFiles >= maxFiles) {
						progress.truncated = true;
						progress.truncationReason = 'files';
						break;
					}

					progress.scannedFiles++;

					// Read file content (from cache if valid, otherwise storage)
					let content: string | null = null;
					const cached = this.fileCache.get(file.relativePath);
					if (cached && cached.version === snapshot.version) {
						content = cached.content;
					} else if (this.worktree.storage) {
						try {
							content = await this.worktree.storage.readFile(file.origin);
							this.fileCache.set(file.relativePath, {
								content,
								version: snapshot.version
							});
						} catch {
							// If file read fails (missing / permission), skip it
							continue;
						}
					}

					if (content === null || content === undefined) {
						continue;
					}

					// Phase 1: Cheap sniff per file
					// Check for binary file (null byte in first 8 KB)
					const sniffSample = content.length <= SNIFF_SIZE ? content : content.slice(0, SNIFF_SIZE);
					if (sniffSample.includes('\0')) {
						// Binary file skipped
						continue;
					}

					// Cheap check: does file contain pattern?
					if (!content.includes(pattern)) {
						continue;
					}

					// Phase 2: Full match only on files with hits
					const lines = content.split(/\r?\n/);
					const fileMatches: SearchMatch[] = [];
					let charOffset = 0;

					for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
						if (signal.aborted) break;

						const lineText = lines[lineIdx];
						let colIdx = 0;

						while ((colIdx = lineText.indexOf(pattern, colIdx)) !== -1) {
							// Check if matches cap would be reached
							if (progress.totalMatches + fileMatches.length >= maxMatches) {
								progress.truncated = true;
								progress.truncationReason = 'matches';
								break;
							}

							// Build context lines
							const contextBefore: SearchMatchContextLine[] = [];
							for (let b = Math.max(0, lineIdx - contextLines); b < lineIdx; b++) {
								contextBefore.push({ line: b + 1, text: lines[b] });
							}

							const contextAfter: SearchMatchContextLine[] = [];
							for (let a = lineIdx + 1; a <= Math.min(lines.length - 1, lineIdx + contextLines); a++) {
								contextAfter.push({ line: a + 1, text: lines[a] });
							}

							fileMatches.push({
								line: lineIdx + 1,
								column: colIdx + 1,
								offset: charOffset + colIdx,
								matchLength: pattern.length,
								lineText,
								contextBefore,
								contextAfter
							});

							colIdx += pattern.length;
						}

						charOffset += lineText.length + 1;

						if (progress.truncated) {
							break;
						}
					}

					if (fileMatches.length > 0) {
						progress.matchedFiles++;
						progress.totalMatches += fileMatches.length;

						const result: FileSearchResult = {
							filepath: file.relativePath,
							origin: file.origin,
							matches: fileMatches
						};

						options?.onMatch?.(result);
						yield result;
					}

					if (progress.truncated) {
						break;
					}
				}
			}.bind(this),
			options?.signal
		);
	}
}
