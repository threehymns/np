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
const MAX_CACHE_BYTES = 50 * 1024 * 1024; // 50 MB total file-content cache

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
 * Compiles a SearchQuery into a RegExp with lookaround support,
 * case-sensitivity flag, and whole-word boundaries.
 * Throws SyntaxError on invalid regex.
 */
export function buildSearchRegex(query: SearchQuery): RegExp {
	const pattern = query.pattern;
	const isRegex = Boolean(query.isRegex ?? false);
	const caseSensitive = Boolean(query.caseSensitive ?? false);
	const wholeWord = Boolean(query.wholeWord ?? false);

	let flags = 'gm';
	if (!caseSensitive) {
		flags += 'i';
	}

	let source = pattern;
	if (!isRegex) {
		source = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	if (wholeWord) {
		source = `(?<!\\w)(?:${source})(?!\\w)`;
	}

	return new RegExp(source, flags);
}

/**
 * Converts a glob pattern string (e.g. "*.ts", "src/**", "tests/*.test.ts") into a RegExp.
 */
export function globToRegex(glob: string): RegExp {
	let p = glob.trim();
	if (!p) return /(?:)/;

	// Normalize slashes
	p = p.replace(/\\/g, '/');
	// Strip leading ./ or /
	p = p.replace(/^(\.\/|\/)/, '');

	const hasSlash = p.includes('/');

	let regexStr = '';
	let i = 0;
	while (i < p.length) {
		const c = p[i];
		if (c === '*' && p[i + 1] === '*') {
			if (p[i + 2] === '/') {
				regexStr += '(?:.+/)?';
				i += 3;
			} else {
				regexStr += '.*';
				i += 2;
			}
		} else if (c === '*') {
			regexStr += '[^/]*';
			i++;
		} else if (c === '?') {
			regexStr += '[^/]';
			i++;
		} else if ('./+()[]{}|^$'.includes(c)) {
			regexStr += '\\' + c;
			i++;
		} else {
			regexStr += c;
			i++;
		}
	}

	if (!hasSlash) {
		return new RegExp(`(?:^|/)${regexStr}$`, 'i');
	} else {
		return new RegExp(`^${regexStr}$`, 'i');
	}
}

/**
 * Parses comma-separated or array glob inputs into RegExp array.
 */
export function parseGlobs(input?: string[] | string): RegExp[] {
	if (!input) return [];
	const rawList = Array.isArray(input)
		? input.flatMap((s) => s.split(','))
		: input.split(',');
	return rawList
		.map((g) => g.trim())
		.filter((g) => g.length > 0)
		.map((g) => globToRegex(g));
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
 * - Query options: regex (lookaround support), case-sensitive, whole-word, include/exclude globs.
 * - Streaming results out via AsyncIterable.
 */
export class TypeScriptSearchEngine implements SearchBackend {
	private worktree: Worktree | null = null;
	private fileCache = new Map<string, { content: string; version: number }>();
	private cacheBytes = 0;
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
		this.cacheBytes = 0;

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
				this.cacheBytes -= value.content.length;
				this.fileCache.delete(key);
			}
		}
	}

	/**
	 * Store content in the cache, evicting oldest entries if the total
	 * cached size would exceed MAX_CACHE_BYTES. Keeps memory bounded
	 * on large projects.
	 */
	private cacheFileContent(key: string, content: string, version: number): void {
		const existing = this.fileCache.get(key);
		if (existing) {
			this.cacheBytes -= existing.content.length;
			this.fileCache.delete(key);
		}
		while (this.cacheBytes + content.length > MAX_CACHE_BYTES && this.fileCache.size > 0) {
			const oldest = this.fileCache.keys().next();
			if (oldest.done) break;
			const evicted = this.fileCache.get(oldest.value)!;
			this.cacheBytes -= evicted.content.length;
			this.fileCache.delete(oldest.value);
		}
		// Skip files larger than the entire cache budget
		if (content.length > MAX_CACHE_BYTES) return;
		this.fileCache.set(key, { content, version });
		this.cacheBytes += content.length;
	}

	dispose(): void {
		if (this.worktreeUnsubscribe) {
			this.worktreeUnsubscribe();
			this.worktreeUnsubscribe = null;
		}
		this.fileCache.clear();
		this.cacheBytes = 0;
		this.worktree = null;
	}

	/**
	 * Extract all candidate files strictly from snapshot entries in memory.
	 * Never walks disk or calls readDirectory.
	 *
	 * The worktree is passed in rather than read from the engine: a search
	 * runs across yields, and the project can switch roots while it runs.
	 * The caller passes the worktree the snapshot came from, so the file
	 * set and the ignore rules belong to the same root.
	 */
	collectFilesFromSnapshot(
		entries: TreeNode[],
		worktree: Worktree | null,
		parentPath = ''
	): FlattenedFile[] {
		const files: FlattenedFile[] = [];

		for (const node of entries) {
			const relPath = parentPath ? `${parentPath}/${node.name}` : node.name;

			// Skip ignored dirs like node_modules or build output
			if (node.kind === 'directory') {
				if (DEFAULT_IGNORED_DIRS.has(node.name)) {
					continue;
				}
				if (worktree?.gitignore?.ignores(relPath)) {
					continue;
				}
				if (node.children) {
					files.push(...this.collectFilesFromSnapshot(node.children, worktree, relPath));
				}
			} else if (node.kind === 'file') {
				// Skip if path has any ignored directory component
				const parts = relPath.split('/');
				if (parts.some((p) => DEFAULT_IGNORED_DIRS.has(p))) {
					continue;
				}
				if (worktree?.gitignore?.ignores(relPath)) {
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

		let searchRegex: RegExp | null = null;
		if (pattern) {
			try {
				searchRegex = buildSearchRegex(query);
			} catch {
				searchRegex = null;
			}
		}

		const includeRegexes = parseGlobs(query?.includeGlobs);
		const excludeRegexes = parseGlobs(query?.excludeGlobs);

		return new SearchResultStream(
			async function* (this: TypeScriptSearchEngine, signal: AbortSignal, progress: SearchProgress) {
// The worktree is captured once. A search spans yields, and
				// the project can switch roots in between: reading the
				// engine's current worktree mid-search would mix two roots
				// (one root's file list with another's files).
				const worktree = this.worktree;
				if (!pattern || !searchRegex || !worktree) {
					return;
				}

				const snapshot: FileSnapshot = worktree.snapshot;
				// The engine reads ONLY the Worktree snapshot — it never walks the disk itself
				const files = this.collectFilesFromSnapshot(snapshot.entries, worktree);

				for (const file of files) {
					if (signal.aborted) {
						break;
					}

// The project switched roots while the search ran. The
					// results so far belong to the old root and the rest
					// would belong to the new one, so the search stops.
					if (this.worktree !== worktree) {
						break;
					}

					// Globs filter the searched file set
					if (includeRegexes.length > 0 && !includeRegexes.some((r) => r.test(file.relativePath))) {
						continue;
					}
					if (excludeRegexes.length > 0 && excludeRegexes.some((r) => r.test(file.relativePath))) {
						continue;
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
					} else if (worktree.storage) {
						try {
							content = await worktree.storage.readFile(file.origin);
							// Cache only while the worktree the content
							// came from is still the current one: a
							// switched root must not serve the old root's
							// content from the cache.
							if (this.worktree === worktree) {
								this.cacheFileContent(file.relativePath, content, snapshot.version);
							}
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
					searchRegex.lastIndex = 0;
					if (!searchRegex.test(content)) {
						continue;
					}

					// Phase 2: Full match only on files with hits
					const lines = content.split(/\r?\n/);
					const fileMatches: SearchMatch[] = [];
					let charOffset = 0;

					for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
						if (signal.aborted) break;

						const lineText = lines[lineIdx];
						searchRegex.lastIndex = 0;
						let match: RegExpExecArray | null;

						while ((match = searchRegex.exec(lineText)) !== null) {
							if (match[0].length === 0) {
								if (searchRegex.lastIndex <= match.index) {
									searchRegex.lastIndex = match.index + 1;
								}
								continue;
							}

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
								column: match.index + 1,
								offset: charOffset + match.index,
								matchLength: match[0].length,
								lineText,
								contextBefore,
								contextAfter
							});

							if (progress.truncated) {
								break;
							}
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
