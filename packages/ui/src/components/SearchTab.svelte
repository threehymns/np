<script lang="ts">
	import { useAppState } from '@np/core/state.svelte';
	import type { FileSearchResult, SearchMatch, SingleEdit, DocumentSession } from '@np/core';
	import { FileExcerptMap, applyReplaceAll, applyEditsToDocumentSession, toURI } from '@np/core';
	import MultiBuffer, { type MultibufferSection } from './MultiBuffer.svelte';
	import Icon from './Icon.svelte';
	import { CaretRightIcon, CaretDownIcon, MagnifyingGlassIcon } from 'phosphor-svelte';
	import { SvelteSet, SvelteMap } from 'svelte/reactivity';
	import { EditorView, lineNumbers, Decoration, type DecorationSet } from '@codemirror/view';
	import { EditorState, StateField, RangeSetBuilder } from '@codemirror/state';
	import { getLanguageExtensions, editorTheme, LanguageSupport } from '../editor/index';

	interface Props {
		tabId?: string;
	}

	let { tabId }: Props = $props();

	const appState = useAppState();
	const activeId = $derived(tabId ?? appState.workspace.activeTabId);
	const session = $derived(appState.workspace.getSearchSession(activeId));

	let replaceText = $state('');
	let fileResults = $state<FileSearchResult[]>([]);
	let isSearching = $state(false);
	let isTruncated = $state(false);
	let truncationReason = $state<'files' | 'matches' | undefined>(undefined);
	let searchTimeout: any = null;
	let currentAbortController: AbortController | null = null;
	const collapsedPaths = new SvelteSet<string>();

	interface ExcerptViewEntry {
		view: EditorView;
		getMap: () => FileExcerptMap;
	}
	const activeExcerptViews = new SvelteMap<string, ExcerptViewEntry>();

	let totalMatches = $derived(fileResults.reduce((sum, r) => sum + r.matches.length, 0));

	let sections = $derived<MultibufferSection[]>(
		fileResults.map((r) => ({
			filepath: r.filepath,
			key: r.filepath
		}))
	);

	function toggleCollapse(filepath: string) {
		if (collapsedPaths.has(filepath)) {
			collapsedPaths.delete(filepath);
		} else {
			collapsedPaths.add(filepath);
		}
	}

	function handleInput() {
		if (searchTimeout) {
			clearTimeout(searchTimeout);
		}
		searchTimeout = setTimeout(() => {
			runSearch();
		}, 150);
	}

	function toggleCaseSensitive() {
		session.toggleCaseSensitive();
		runSearch();
	}

	function toggleWholeWord() {
		session.toggleWholeWord();
		runSearch();
	}

	function toggleRegex() {
		session.toggleRegex();
		runSearch();
	}

	async function runSearch() {
		if (currentAbortController) {
			currentAbortController.abort();
			currentAbortController = null;
		}

		if (session.regexError) {
			fileResults = [];
			isSearching = false;
			isTruncated = false;
			truncationReason = undefined;
			return;
		}

		const query = session.toQuery();
		if (!query.pattern) {
			fileResults = [];
			isSearching = false;
			isTruncated = false;
			truncationReason = undefined;
			return;
		}

		currentAbortController = new AbortController();
		const signal = currentAbortController.signal;

		fileResults = [];
		isSearching = true;
		isTruncated = false;
		truncationReason = undefined;

		try {
			const backend = appState.workspace.project.searchBackend;
			const stream = backend.search(query, { signal });

			for await (const result of stream) {
				if (signal.aborted) break;
				fileResults = [...fileResults, result];
			}

			if (!signal.aborted) {
				isTruncated = stream.progress.truncated;
				truncationReason = stream.progress.truncationReason;
			}
		} catch (e) {
			if (!signal.aborted) {
				console.error('[SearchTab] Search failed:', e);
			}
		} finally {
			if (currentAbortController?.signal === signal) {
				isSearching = false;
			}
		}
	}

	async function openFile(result?: FileSearchResult) {
		if (!result) return;
		await appState.workspace.openFile(result.origin);
	}

	async function jumpToMatch(result: FileSearchResult, match: SearchMatch) {
		const doc = await appState.workspace.openFile(result.origin);
		if (doc) {
			doc.pendingLineToScroll = match.line;
			doc.pendingColumn = match.column;
			doc.pendingMatchLength = match.matchLength;
		}
	}

	async function applyUserEditToFile(fileResult: FileSearchResult, edit: SingleEdit): Promise<DocumentSession | null> {
		// Match by exact URI only: a path-suffix fallback can resolve to a
		// different file that happens to share the same filename.
		let doc = appState.workspace.documents.find(
			(d) => d.origin && toURI(d.origin) === toURI(fileResult.origin)
		);
		if (!doc) {
			doc = await appState.workspace.openFile(fileResult.origin);
		}
		if (doc) {
			applyEditsToDocumentSession(doc, [edit], appState.workspace);
			return doc;
		}
		return null;
	}

	async function replaceAll() {
		if (fileResults.length === 0 || !session.query) return;

		// Replace-all applies across all results in one action (per-file undo)
		// No confirmation modal, no summary report.
		// Dirty files accept replace edits without warnings.
		await applyReplaceAll({
			workspace: appState.workspace,
			fileResults,
			replacement: replaceText
		});

		// Re-run the search so every excerpt view rebuilds from fresh matches
		// computed against the post-replacement content. Reusing the old match
		// offsets would misalign excerpts whenever the replacement length
		// differs from the match length.
		await runSearch();
	}

	function setupExcerptEditor(node: HTMLDivElement, fileResult: FileSearchResult) {
		let view: EditorView | undefined;
		let disposed = false;
		let initSeq = 0;

		async function init() {
			// Invalidate any earlier in-flight init: the newest result wins.
			const seq = ++initSeq;
			const alive = () => !disposed && seq === initSeq;

			const uri = toURI(fileResult.origin);
			// Match by exact URI only: a path-suffix fallback can resolve to a
			// different file that happens to share the same filename.
			let doc = appState.workspace.documents.find(
				(d) => d.origin && toURI(d.origin) === uri
			);
			let content = doc?.content;
			if (content === undefined) {
				try {
					content = await appState.workspace.project.storage.readFile(fileResult.origin);
				} catch {
					content = '';
				}
			}
			if (!alive()) return;

			let excerptMap = new FileExcerptMap(
				fileResult.filepath,
				fileResult.origin,
				content,
				fileResult.matches,
				{ contextLines: 1 }
			);

			// The map snapshots the document at init() time. Track the document
			// revision it reflects so an edit made anywhere else (main editor,
			// another view) is detected before a stale offset can write to the
			// wrong place in the file.
			let mapRevision = doc?.revision ?? -1;

			// Document writes are serialized per view: each edit is checked
			// against the revision only after earlier edits have landed, so an
			// in-flight edit of our own never looks like an external change.
			let applyChain: Promise<void> = Promise.resolve();

			// Separator text between excerpts has no file counterpart. Reject
			// edits touching it at the editor level: mapping them would drop
			// the file edit while the buffer still changes, leaving the two
			// permanently out of sync. Separator bounds are read live from the
			// map because applyExcerptEdit shifts them after every edit; a
			// snapshot taken here would go stale after the first keystroke.
			const rejectSeparatorEdits = EditorState.changeFilter.of((tr) => {
				if (!tr.docChanged) return true;
				let allowed = true;
				tr.changes.iterChangedRanges((fromA, toA) => {
					for (let i = 0; i < excerptMap.excerpts.length - 1; i++) {
						const sepFrom = excerptMap.excerpts[i].bufferEnd;
						const sepTo = excerptMap.excerpts[i + 1].bufferStart;
						if (fromA < sepTo && toA > sepFrom) {
							allowed = false;
						}
					}
				});
				return allowed;
			});

			const highlightDecorations = () => {
				const builder = new RangeSetBuilder<Decoration>();
				for (const match of fileResult.matches) {
					const bufFrom = excerptMap.fileOffsetToExcerptOffset(match.offset);
					if (bufFrom !== null) {
						const bufTo = Math.min(bufFrom + match.matchLength, excerptMap.bufferText.length);
						if (bufFrom < bufTo) {
							builder.add(
								bufFrom,
								bufTo,
								Decoration.mark({
									class: 'cm-search-match bg-primary/30 text-primary font-bold rounded-xs px-0.5'
								})
							);
						}
					}
				}
				return builder.finish();
			};

			const matchField = StateField.define<DecorationSet>({
				create() {
					return highlightDecorations();
				},
				update(decorations, tr) {
					if (tr.docChanged) {
						return decorations.map(tr.changes);
					}
					return decorations;
				},
				provide: (f) => EditorView.decorations.from(f)
			});

			const customLineNumbers = lineNumbers({
				formatNumber(lineNo, state) {
					const line = state.doc.line(lineNo);
					const fileOffset = excerptMap.excerptOffsetToFileOffset(line.from);
					if (fileOffset !== null) {
						const prefix = content.slice(0, fileOffset);
						const fileLine = prefix.split('\n').length;
						return String(fileLine);
					}
					return String(lineNo);
				}
			});

			const langDesc = LanguageSupport.getLanguageForFile(fileResult.filepath);
			const langExtensions = await getLanguageExtensions(langDesc);
			if (!alive()) return;

			const startState = EditorState.create({
				doc: excerptMap.bufferText,
				extensions: [
					EditorView.lineWrapping,
					customLineNumbers,
					matchField,
					rejectSeparatorEdits,
					...langExtensions,
					editorTheme,
					EditorView.updateListener.of((update) => {
						if (update.docChanged) {
							update.transactions.forEach((tr) => {
								// iterChanges reports pre-transaction coordinates, so
								// handle the latest change first: each edit then still
								// refers to the map's current coordinate space.
								const changes: { from: number; to: number; insert: string }[] = [];
								tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
									changes.push({ from: fromA, to: toA, insert: inserted.toString() });
								});
								changes.sort((a, b) => b.from - a.from);
								for (const excerptEdit of changes) {
									const fileEdit = excerptMap.mapExcerptEditToFileEdit(excerptEdit);
									if (fileEdit) {
										applyChain = applyChain
											.then(async () => {
												const liveDoc =
													doc ??
													appState.workspace.documents.find(
														(d) => d.origin && toURI(d.origin) === uri
													);
												if (liveDoc && liveDoc.revision !== mapRevision) {
													// The document moved on outside this view since
													// init(): these offsets describe stale content.
													// Drop the edit and rebuild from the current
													// document instead of writing to the wrong place.
													queueMicrotask(() => {
														if (!alive()) return;
														view?.destroy();
														view = undefined;
														void init();
													});
													return;
												}
												const appliedDoc = await applyUserEditToFile(fileResult, fileEdit);
												if (appliedDoc) {
													doc = appliedDoc;
													mapRevision = appliedDoc.revision;
												}
											})
											.catch(() => {
												// A failed write must not break serialization for later edits.
											});
									}
									// Keep segment bounds in sync so later edits map
									// through current bounds, not search-time ones.
									excerptMap.applyExcerptEdit(excerptEdit, fileEdit);
								}
							});
						}
					})
				]
			});

			view = new EditorView({
				state: startState,
				parent: node
			});

			activeExcerptViews.set(fileResult.filepath, {
				view,
				getMap: () => excerptMap
			});
		}

		void init();

		return {
			update(newResult: FileSearchResult) {
				// A fresh result object means a new search run (e.g. the
				// re-search after Replace All). Rebuild the editor from the
				// fresh content and match offsets: keeping the old excerptMap
				// would map edits through stale segment bounds.
				if (newResult === fileResult) return;
				fileResult = newResult;
				view?.destroy();
				view = undefined;
				void init();
			},
			destroy() {
				disposed = true;
				activeExcerptViews.delete(fileResult.filepath);
				view?.destroy();
				view = undefined;
			}
		};
	}
</script>

<div class="flex flex-col h-full w-full bg-background text-foreground overflow-hidden">
	<!-- Query bar on top -->
	<div class="border-b border-border/40 p-3 bg-muted/20 flex flex-col gap-2 shrink-0">
		<!-- Search row -->
		<div class="relative flex items-center">
			<MagnifyingGlassIcon class="absolute left-2.5 size-4 text-muted-foreground pointer-events-none" />
			<input
				type="text"
				bind:value={session.query}
				oninput={handleInput}
				placeholder="Search project..."
				class="w-full bg-background border border-input rounded-md pl-9 pr-24 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				aria-label="Search query"
			/>
			<div class="absolute right-1.5 flex items-center gap-0.5">
				<button
					type="button"
					class="px-1.5 py-0.5 text-xs font-mono rounded border transition-colors {session.caseSensitive ? 'bg-primary/20 text-primary border-primary/40 font-semibold' : 'text-muted-foreground border-transparent hover:bg-muted hover:text-foreground'}"
					aria-label="Match Case"
					aria-pressed={session.caseSensitive}
					title="Match Case"
					onclick={toggleCaseSensitive}
				>
					Aa
				</button>
				<button
					type="button"
					class="px-1.5 py-0.5 text-xs font-mono rounded border transition-colors {session.wholeWord ? 'bg-primary/20 text-primary border-primary/40 font-semibold' : 'text-muted-foreground border-transparent hover:bg-muted hover:text-foreground'}"
					aria-label="Match Whole Word"
					aria-pressed={session.wholeWord}
					title="Match Whole Word"
					onclick={toggleWholeWord}
				>
					\b
				</button>
				<button
					type="button"
					class="px-1.5 py-0.5 text-xs font-mono rounded border transition-colors {session.isRegex ? 'bg-primary/20 text-primary border-primary/40 font-semibold' : 'text-muted-foreground border-transparent hover:bg-muted hover:text-foreground'}"
					aria-label="Use Regular Expression"
					aria-pressed={session.isRegex}
					title="Use Regular Expression"
					onclick={toggleRegex}
				>
					.*
				</button>
			</div>
		</div>

		{#if session.regexError}
			<div class="text-xs text-destructive font-medium px-0.5 flex items-center gap-1" role="alert">
				<span>{session.regexError}</span>
			</div>
		{/if}

		<!-- File include and exclude globs -->
		<div class="grid grid-cols-2 gap-2">
			<input
				type="text"
				bind:value={session.includePattern}
				oninput={handleInput}
				placeholder="files to include (e.g. *.ts, src/**)"
				aria-label="Files to include"
				class="w-full bg-background border border-input rounded-md px-2.5 py-1 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
			/>
			<input
				type="text"
				bind:value={session.excludePattern}
				oninput={handleInput}
				placeholder="files to exclude (e.g. *.test.ts, build/**)"
				aria-label="Files to exclude"
				class="w-full bg-background border border-input rounded-md px-2.5 py-1 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
			/>
		</div>

		<!-- Replace row -->
		<div class="flex items-center gap-2">
			<input
				type="text"
				bind:value={replaceText}
				placeholder="Replace with..."
				class="flex-1 bg-background border border-input rounded-md px-3 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				aria-label="Replace query"
				onkeydown={(e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						replaceAll();
					}
				}}
			/>
			<button
				type="button"
				onclick={replaceAll}
				disabled={fileResults.length === 0 || !session.query}
				class="px-3 py-1.5 bg-primary text-primary-foreground text-xs font-medium rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
				aria-label="Replace all"
			>
				Replace All
			</button>
		</div>

		<!-- Status and truncation bar -->
		<div class="flex items-center justify-between text-xs px-0.5">
			<div class="flex items-center gap-2">
				{#if isSearching}
					<span class="text-muted-foreground animate-pulse">Searching...</span>
				{:else if !session.query}
					<span class="text-muted-foreground">Type a query to search</span>
				{:else if fileResults.length === 0}
					<span class="text-muted-foreground">No results found</span>
				{:else}
					<span class="text-muted-foreground">
						{totalMatches} {totalMatches === 1 ? 'match' : 'matches'} across {fileResults.length} {fileResults.length === 1 ? 'file' : 'files'}
					</span>
				{/if}
			</div>

			{#if isTruncated}
				<div class="text-amber-500 font-medium" role="status">
					Results truncated: capped at {truncationReason === 'files' ? '5,000 files' : '10,000 matches'}
				</div>
			{/if}
		</div>
	</div>

	<!-- Grouped results below using MultiBuffer -->
	<div class="flex-1 overflow-hidden flex flex-col">
		<MultiBuffer
			{sections}
			isCollapsed={(fp) => collapsedPaths.has(fp)}
			idPrefix="search-"
		>
			{#snippet header(filepath: string)}
				{@const fileResult = fileResults.find((r) => r.filepath === filepath)}
				<div
					class="flex items-center gap-2 py-1 px-2 hover:bg-muted/30 rounded cursor-pointer select-none"
					onclick={() => toggleCollapse(filepath)}
					role="button"
					tabindex="0"
					onkeydown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							toggleCollapse(filepath);
						}
					}}
				>
					<button
						type="button"
						aria-label={collapsedPaths.has(filepath) ? `Expand ${filepath}` : `Collapse ${filepath}`}
						class="p-0.5 hover:bg-muted rounded text-muted-foreground"
						onclick={(e) => {
							e.stopPropagation();
							toggleCollapse(filepath);
						}}
					>
						{#if collapsedPaths.has(filepath)}
							<CaretRightIcon size={14} />
						{:else}
							<CaretDownIcon size={14} />
						{/if}
					</button>

					<Icon resource={filepath} type="file" class="size-4 opacity-90" />

					<button
						type="button"
						class="font-medium text-xs text-foreground hover:underline truncate text-left"
						onclick={(e) => {
							e.stopPropagation();
							openFile(fileResult);
						}}
					>
						{filepath}
					</button>

					<span class="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full font-mono">
						{fileResult?.matches.length ?? 0}
					</span>
				</div>
			{/snippet}

			{#snippet content(filepath: string)}
				{@const fileResult = fileResults.find((r) => r.filepath === filepath)}
				{#if fileResult}
					<!-- Editable excerpt multibuffer for this file -->
					<div class="search-excerpt-editor flex flex-col py-1 border-t border-border/20">
						<div use:setupExcerptEditor={fileResult}></div>

						<!-- Hidden snippet preserving accessible match context for tests/screen readers -->
						<div class="sr-only" aria-hidden="true">
							{#each fileResult.matches as match (match.offset)}
								{#each match.contextBefore as ctx (ctx.line)}
									<span>{ctx.text}</span>
								{/each}
								<mark>{match.lineText.slice(match.column - 1, match.column - 1 + match.matchLength)}</mark>
								{#each match.contextAfter as ctx (ctx.line)}
									<span>{ctx.text}</span>
								{/each}
							{/each}
						</div>
					</div>
				{/if}
			{/snippet}

			{#snippet emptyState()}
				<div class="flex-1 flex flex-col items-center justify-center p-8 text-muted-foreground text-sm">
					{#if session.query.trim()}
						<p>No results found for &ldquo;{session.query}&rdquo;</p>
					{:else}
						<p>Type a query above to search the project.</p>
					{/if}
				</div>
			{/snippet}
		</MultiBuffer>
	</div>
</div>
