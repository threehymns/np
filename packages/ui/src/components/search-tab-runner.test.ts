import "../../../../tests/contract/rune-setup";
import { describe, it, expect } from "bun:test";
import { Worktree } from "../../../core/src/project/worktree.svelte";
import { TypeScriptSearchEngine, SearchResultStream } from "../../../core/src/search/engine";
import { SearchTabSession } from "../../../core/src/search/session.svelte";
import type {
	FileSearchResult,
	SearchBackend,
	SearchOptions,
	SearchProgress,
	SearchQuery
} from "../../../core/src/search/types";
import { SearchTabRunner } from "./search-tab-runner.svelte";
import { searchStatusText, truncationCapText } from "./search-tab-behavior";

const rootOrigin = { scheme: "file", path: "/test-project", name: "test-project" };

/**
 * A backend that answers with prepared results and records what it was
 * asked to search for. The SearchBackend is a seam (ADR 0026), so a test
 * double behind it is a boundary double, not a mock of our own internals.
 */
class FakeBackend implements SearchBackend {
	readonly queries: SearchQuery[] = [];
	readonly signals: (AbortSignal | undefined)[] = [];
	readonly liveContents: NonNullable<SearchOptions["liveContent"]>[] = [];

	constructor(
		private readonly respond: () => {
			results: FileSearchResult[];
			progress?: Partial<SearchProgress>;
		} = () => ({ results: [] })
	) {}

	search(query: SearchQuery, options?: SearchOptions): SearchResultStream {
		this.queries.push(query);
		this.signals.push(options?.signal);
		if (options?.liveContent) this.liveContents.push(options.liveContent);
		const { results, progress } = this.respond();
		return new SearchResultStream(
			async function* (signal, streamProgress) {
				Object.assign(streamProgress, progress);
				for (const result of results) {
					if (signal.aborted) return;
					yield result;
				}
			},
			options?.signal
		);
	}
}

function fileResult(filepath: string, matches: number): FileSearchResult {
	return {
		filepath,
		origin: { scheme: "file", path: `/test-project/${filepath}`, name: filepath },
		matches: Array.from({ length: matches }, (_, index) => ({
			line: index + 1,
			column: 1,
			offset: index,
			matchLength: 6,
			lineText: "needle",
			contextBefore: [],
			contextAfter: []
		}))
	};
}

/**
 * A storage whose files can change under the tab's feet, the way a file
 * edited in a terminal changes.
 */
function createStorage(files: Record<string, string>) {
	return {
		async readFile(origin: { path: string }) {
			const content = files[origin.path];
			if (content === undefined) throw { name: "NotFoundError" };
			return content;
		},
		async readDirectory(origin: { path: string }) {
			const entries: {
				name: string;
				kind: "file" | "directory";
				origin: { scheme: string; path: string; name: string };
			}[] = [];
			const seen = new Set<string>();
			for (const path of Object.keys(files)) {
				if (!path.startsWith(origin.path + "/")) continue;
				const rest = path.slice(origin.path.length + 1);
				const name = rest.split("/")[0];
				if (seen.has(name)) continue;
				seen.add(name);
				entries.push({
					name,
					kind: rest.includes("/") ? "directory" : "file",
					origin: { scheme: "file", path: `${origin.path}/${name}`, name }
				});
			}
			return entries;
		}
	};
}

/**
 * A backend whose first run holds on until the test lets it go, so a second
 * run can start while the first one is still in flight.
 */
class BlockingBackend implements SearchBackend {
	readonly queries: SearchQuery[] = [];
	readonly signals: (AbortSignal | undefined)[] = [];
	/** Resolves when the first run is holding on. */
	readonly holding: Promise<void>;

	private markHolding: () => void = () => {};
	private release: () => void = () => {};

	constructor(private readonly batches: FileSearchResult[][]) {
		this.holding = new Promise<void>((resolve) => {
			this.markHolding = resolve;
		});
	}

	search(query: SearchQuery, options?: SearchOptions): SearchResultStream {
		this.queries.push(query);
		this.signals.push(options?.signal);
		const index = this.queries.length - 1;
		const batch = this.batches[index] ?? [];
		const holds = index === 0;
		return new SearchResultStream(
			async function* (signal) {
				for (const result of batch) {
					yield result;
					if (!holds) continue;
					this.markHolding();
					await new Promise<void>((resolve) => {
						this.release = resolve;
					});
					if (signal.aborted) return;
					yield { ...result, filepath: `${result.filepath}-late` };
				}
			}.bind(this),
			options?.signal
		);
	}

	/** Lets the run that is holding on continue. */
	continue(): void {
		this.release();
	}
}

describe("Search tab runner (Issue #355)", () => {
	it("runs the search with the session's query and its options", async () => {
		const backend = new FakeBackend();
		const session = new SearchTabSession({ query: "needle" });
		session.isRegex = true;
		session.caseSensitive = true;
		session.wholeWord = true;
		session.includePattern = "*.ts";
		session.excludePattern = "*.test.ts";

		const runner = new SearchTabRunner({
			getBackend: () => backend,
			getSession: () => session
		});
		await runner.run();

		expect(backend.queries.length).toBe(1);
		expect(backend.queries[0]).toEqual({
			pattern: "needle",
			isRegex: true,
			caseSensitive: true,
			wholeWord: true,
			includeGlobs: "*.ts",
			excludeGlobs: "*.test.ts"
		});
	});

	it("hands the backend the live text a Document holds", async () => {
		// A file changed in the results is unsaved: its text lives in a
		// Document. The runner passes that text along, so the re-run after a
		// replace describes what the user sees.
		const backend = new FakeBackend();
		const session = new SearchTabSession({ query: "needle" });
		const live = new Map([["/test-project/a.ts", "needle in memory"]]);

		const runner = new SearchTabRunner({
			getBackend: () => backend,
			getSession: () => session,
			getLiveContent: (origin) => live.get(origin.path)
		});
		await runner.run();

		expect(backend.liveContents).toHaveLength(1);
		const liveContent = backend.liveContents[0];
		expect(
			liveContent({ scheme: "file", path: "/test-project/a.ts", name: "a.ts" })
		).toBe("needle in memory");
		expect(
			liveContent({ scheme: "file", path: "/test-project/b.ts", name: "b.ts" })
		).toBeUndefined();
	});

	it("shows the new content of a file that changed outside the editor", async () => {
		const files: Record<string, string> = { "/test-project/notes.txt": "needle old" };
		const storage = createStorage(files);
		const worktree = new Worktree(rootOrigin, { storage: storage as any });
		await worktree.scan();

		const session = new SearchTabSession({ query: "needle" });
		session.caseSensitive = true;
		session.includePattern = "*.txt";
		// One engine for both runs: the file cache it holds is keyed on the
		// snapshot version, so the re-run only reads what changed.
		const engine = new TypeScriptSearchEngine(worktree);
		const runner = new SearchTabRunner({
			getBackend: () => engine,
			getSession: () => session,
			debounceMs: 5
		});
		runner.attachToWorktree(worktree);

		await runner.run();
		expect(runner.results.length).toBe(1);
		expect(runner.results[0].matches[0].lineText).toBe("needle old");

		// The file is edited in a terminal, so the watcher publishes a new
		// snapshot. The user does not touch the query.
		files["/test-project/notes.txt"] = "needle new";
		worktree.notifyEntriesChanged();

		await runner.idle();
		expect(runner.results.length).toBe(1);
		expect(runner.results[0].matches[0].lineText).toBe("needle new");

		// The re-run searched for the session's query and left it, and the
		// options that go with it, alone.
		expect(session.query).toBe("needle");
		expect(session.caseSensitive).toBe(true);
		expect(session.includePattern).toBe("*.txt");
	});

	it("aborts the search it replaces so two searches never interleave", async () => {
		const backend = new BlockingBackend([
			[fileResult("first.txt", 1)],
			[fileResult("second.txt", 1)]
		]);
		const session = new SearchTabSession({ query: "needle" });
		const runner = new SearchTabRunner({
			getBackend: () => backend,
			getSession: () => session
		});

		const first = runner.run();
		await backend.holding;
		const second = runner.run();
		backend.continue();
		await Promise.all([first, second]);

		expect(backend.signals[0]?.aborted).toBe(true);
		expect(runner.results.map((result) => result.filepath)).toEqual(["second.txt"]);
	});

	it("rebuilds the excerpt views after a re-run", async () => {
		const files: Record<string, string> = { "/test-project/a.txt": "needle" };
		const storage = createStorage(files);
		const worktree = new Worktree(rootOrigin, { storage: storage as any });
		await worktree.scan();

		const backend = new FakeBackend(() => ({ results: [fileResult("a.txt", 1)] }));
		const session = new SearchTabSession({ query: "needle" });
		const runner = new SearchTabRunner({
			getBackend: () => backend,
			getSession: () => session,
			debounceMs: 5
		});
		runner.attachToWorktree(worktree);

		let rebuilds = 0;
		runner.registerExcerptView("a.txt", {
			rebuild: () => {
				rebuilds++;
			}
		});

		await runner.run();
		expect(rebuilds).toBe(1);

		// A change of the file snapshot runs the search again, and the
		// excerpt views are rebuilt from what the new run found.
		worktree.notifyEntriesChanged();
		await runner.idle();
		expect(rebuilds).toBe(2);
	});

	it("coalesces a burst of snapshot changes into one re-run", async () => {
		const files: Record<string, string> = { "/test-project/a.txt": "needle" };
		const storage = createStorage(files);
		const worktree = new Worktree(rootOrigin, { storage: storage as any });
		await worktree.scan();

		const backend = new FakeBackend(() => ({ results: [fileResult("a.txt", 1)] }));
		const session = new SearchTabSession({ query: "needle" });
		const runner = new SearchTabRunner({
			getBackend: () => backend,
			getSession: () => session,
			debounceMs: 5
		});
		runner.attachToWorktree(worktree);

		await runner.run();
		expect(backend.queries.length).toBe(1);

		// A save storm publishes a snapshot per file. The search runs once
		// for the storm, not once per file.
		worktree.notifyEntriesChanged();
		worktree.notifyEntriesChanged();
		worktree.notifyEntriesChanged();

		await runner.idle();
		expect(backend.queries.length).toBe(2);
	});

	it("does not re-run a search that has no query", async () => {
		const files: Record<string, string> = { "/test-project/a.txt": "needle" };
		const storage = createStorage(files);
		const worktree = new Worktree(rootOrigin, { storage: storage as any });
		await worktree.scan();

		const backend = new FakeBackend(() => ({ results: [fileResult("a.txt", 1)] }));
		const session = new SearchTabSession({ query: "" });
		const runner = new SearchTabRunner({
			getBackend: () => backend,
			getSession: () => session,
			debounceMs: 5
		});
		runner.attachToWorktree(worktree);

		worktree.notifyEntriesChanged();
		await runner.idle();
		// Long enough for a re-run to have happened, if one was scheduled.
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(backend.queries.length).toBe(0);
		expect(runner.results.length).toBe(0);
	});

	it("reports the counts and the truncation notice of the run that finished", async () => {
		const backend = new FakeBackend(() => ({
			results: [fileResult("a.txt", 2), fileResult("b.txt", 1)],
			progress: { truncated: true, truncationReason: "matches" }
		}));
		const session = new SearchTabSession({ query: "needle" });
		const runner = new SearchTabRunner({
			getBackend: () => backend,
			getSession: () => session
		});

		await runner.run();

		expect(
			searchStatusText({
				isSearching: runner.isSearching,
				totalMatches: runner.results.reduce((sum, r) => sum + r.matches.length, 0),
				fileCount: runner.results.length,
				isQueryEmpty: false
			})
		).toBe("3 matches across 2 files");
		expect(runner.isTruncated).toBe(true);
		expect(truncationCapText(runner.truncationReason)).toBe("10,000 matches");
	});

	it("a re-run replaces the results of the run before it", async () => {
		const files: Record<string, string> = { "/test-project/a.txt": "needle" };
		const storage = createStorage(files);
		const worktree = new Worktree(rootOrigin, { storage: storage as any });
		await worktree.scan();

		let batch = [fileResult("a.txt", 1), fileResult("b.txt", 1)];
		const backend = new FakeBackend(() => ({ results: batch }));
		const session = new SearchTabSession({ query: "needle" });
		const runner = new SearchTabRunner({
			getBackend: () => backend,
			getSession: () => session,
			debounceMs: 5
		});
		runner.attachToWorktree(worktree);

		await runner.run();
		expect(runner.results.length).toBe(2);

		// The second file is gone: the re-run reports one file, not two.
		batch = [fileResult("a.txt", 1)];
		worktree.notifyEntriesChanged();
		await runner.idle();

		expect(runner.results.length).toBe(1);
		expect(runner.results[0].filepath).toBe("a.txt");
	});
});
