/**
 * The empty baseline contract for `getFileDiff`: an untracked (`U`) or added
 * (`A`) path has no HEAD content, and that `''` is load-bearing.
 *
 * `SpawnGitAdapter.getFileDiff` has two status-based short-circuits for these
 * cases (see its `U` and `A` branches). They are a subprocess optimization: for
 * a genuinely untracked path, `git show HEAD:<path>` and `git show :<path>`
 * both fail as not-found, and the general path coalesces the resulting null to
 * the same `''`. So the invariant these tests pin is the CONTENT the diff
 * reports — the empty baseline and its consequences — NOT the existence of the
 * short-circuits. Deleting the shortcuts leaves every assertion here green,
 * which is exactly the point: the contract is what a caller can rely on, and it
 * must survive the optimization being kept or removed. Whether the adapter
 * skips the lookups is a command-construction property, asserted by the two
 * unit tests in `SpawnGitAdapter.test.ts` that count `git show` calls.
 *
 * The browser engine (`IsomorphicGitAdapter`) has no status parameter at all and
 * computes these contents through its general path, so it satisfies the same
 * contract. Both engines are driven here so the baseline is pinned on the web
 * app too, not just on the desktop adapter that happens to own the shortcut.
 *
 * Why the write path matters (the reason this file exists): the `''` is not
 * decorative. A Hunk Action (stage/unstage/discard) splices the diff's three
 * contents together and hands the result to `updateIndexContent`, which renders
 * a patch that `git apply --cached` must accept. An empty original is the
 * baseline that splice indexes against, so these tests drive the real
 * Hunk Action write path and assert the resulting index content byte-for-byte.
 *
 * Scope — a STALE status letter is deliberately not pinned. `getFileDiff` trusts
 * the caller's letter and never re-reads porcelain, so a diff computed under an
 * old letter can be served after the path's status changes. Pinning that is out
 * of scope here: it would need a production change (re-probe before trusting
 * the letter) or a cache-key contract elsewhere. This file pins the FRESH-letter
 * case only, and is not a durability claim about a diff cached across a status
 * change.
 *
 * The staged/unstaged split (`AM`) and the A/D (staged-add-deleted-from-worktree)
 * shapes are driven through the REAL change pipeline — `getChanges` then the
 * `combineChangesByFilepath` reduction the UI applies — so the options pinned
 * here are the ones a caller actually sends, not hand-written combinations.
 */
import './rune-setup';
import { expect } from 'bun:test';
import { rm } from 'node:fs/promises';
import { Text } from '../../packages/core/node_modules/@codemirror/state';
import { Chunk } from '../../packages/core/node_modules/@codemirror/merge';
import { applyHunkAction, type HunkRange } from '../../packages/core/src/commands.svelte';
import { Repository } from '../../packages/core/src/project/repository.svelte';
import type { AppState } from '../../packages/core/src/state.svelte';
import type { FileOrigin, GitChange, VCSAdapter } from '@np/core';
import { toURI } from '@np/core/storage';
import { IsomorphicGitAdapter, browserHandleRegistry } from '@np/adapters-browser';
import { SpawnGitAdapter } from '../../apps/desktop/src/renderer/SpawnGitAdapter';
import { NodeDirectoryHandle } from './node-fs-handle';
import {
	TestRepo,
	createTrackedRepo,
	describe,
	it,
	indexContents,
	nodeFileAccess,
	porcelainStatus,
	runGit,
	seedCommit,
	worktreeContents
} from './harness';

/**
 * The read+write surface the empty-baseline contract needs, kept narrow enough
 * that both engines satisfy one interface — mirroring `change-diff-reads`.
 * `getFileDiff` here is the shared shape the UI calls; the desktop adapter's
 * extra `status` option is exercised explicitly where it is supplied.
 */
interface EmptyBaselineEngine {
	name: string;
	adapter(r: TestRepo): VCSAdapter;
	/** Whether this engine honors a `status` option at all (the browser one does not). */
	honorsStatus: boolean;
}

const spawnEngine: EmptyBaselineEngine = {
	name: 'SpawnGitAdapter (real git)',
	honorsStatus: true,
	adapter(r) {
		return new SpawnGitAdapter({ scheme: 'file', path: r.path, name: 'repo' } as FileOrigin, (workingDir, args) => runGit(workingDir, r.env, args), nodeFileAccess);
	}
};

const isomorphicEngine: EmptyBaselineEngine = {
	name: 'IsomorphicGitAdapter (isomorphic-git over node fs)',
	honorsStatus: false,
	adapter(r) {
		const repoOrigin: FileOrigin = { scheme: 'browser', path: r.path, name: 'repo' };
		browserHandleRegistry.register(toURI(repoOrigin), new NodeDirectoryHandle('repo', r.path));
		return new IsomorphicGitAdapter(repoOrigin);
	}
};

/**
 * `combineChangesByFilepath` from `DiffViewer.svelte`: folds the staged and
 * unstaged entries the adapter reports for one path into the single combined
 * entry the UI hands to `getFileDiff`. Reproduced here so the pinned options are
 * the ones a caller really sends. Returns the change with the given filepath.
 */
function combinedChange(changes: GitChange[], filepath: string): GitChange {
	const group = changes.filter(c => c.filepath === filepath);
	if (group.length === 1) return group[0];
	const staged = group.find(c => c.staged);
	const unstaged = group.find(c => !c.staged);
	if (!staged || !unstaged) return group[0];
	return {
		filepath,
		status: staged.status !== 'U' ? staged.status : unstaged.status,
		staged: false,
		combined: true,
		diff: `${staged.diff || ''}\n${unstaged.diff || ''}`,
		originalContent: staged.originalContent,
		modifiedContent: unstaged.modifiedContent,
		stagedContent: staged.modifiedContent ?? unstaged.originalContent,
		additions: (staged.additions || 0) + (unstaged.additions || 0),
		deletions: (staged.deletions || 0) + (unstaged.deletions || 0)
	};
}

/** A minimal Repository + AppState so the real Hunk Action write path can run. */
function hunkContext(r: TestRepo, adapter: VCSAdapter): { repository: Repository; appState: AppState } {
	const repository = new Repository({ scheme: 'file', path: r.path, name: 'repo' } as FileOrigin, () => adapter);
	const appState = {
		workspace: { repository },
		dialogService: {
			alert: async (msg: string) => {
				throw new Error(`Unexpected alert dialog: ${msg}`);
			}
		}
	} as unknown as AppState;
	return { repository, appState };
}

function diffHunks(original: string, modified: string): HunkRange[] {
	const origText = Text.of(original.split(/\r?\n/));
	const modText = Text.of(modified.split(/\r?\n/));
	return Chunk.build(origText, modText).map(c => ({ fromA: c.fromA, toA: c.toA, fromB: c.fromB, toB: c.toB }));
}

for (const engine of [spawnEngine, isomorphicEngine]) {
	describe(`${engine.name} — the empty baseline for untracked and added paths`, () => {
		// U: the path is in no commit and no index entry, so BOTH the original and
		// staged sides are '' and the worktree file is the only real content.
		it('reports an untracked file as all-new: empty original, empty staged, real worktree', async () => {
			const r = await createTrackedRepo();
			await seedCommit(r);
			await r.write('untracked.txt', 'brand new\n');
			const adapter = engine.adapter(r);

			// Precondition: the path really is untracked, so the empty baseline is
			// the truth rather than an accident of the fixture.
			const status = await runGit(r.path, r.env, ['status', '--porcelain', '-z', '--', 'untracked.txt']);
			expect(status.code).toBe(0);
			expect(status.stdout).toContain('untracked.txt');
			expect(status.stdout).toContain('??');

			// The options the UI sends for an untracked entry: the combined change's
			// status, with no `staged` key (fetchDiff passes `{ status }` alone when
			// the change is combined). Either way the empty baseline is the answer.
			const detail = engine.honorsStatus ? await adapter.getFileDiff!('untracked.txt', { status: 'U' } as never) : await adapter.getFileDiff!('untracked.txt');
			expect(detail.originalContent).toBe('');
			expect(detail.stagedContent).toBe('');
			expect(detail.modifiedContent).toBe('brand new\n');
		});

		// The load-bearing consequence: the empty original is the baseline a Hunk
		// Action splices against, and the result must land in the index verbatim.
		it('stages an untracked file whole, writing the worktree content to the index exactly', async () => {
			const r = await createTrackedRepo();
			await seedCommit(r);
			const content = 'alpha\nbeta\ngamma\n';
			await r.write('untracked.txt', content);
			const adapter = engine.adapter(r);
			const { appState } = hunkContext(r, adapter);

			const change = combinedChange(await adapter.getChanges!(), 'untracked.txt');
			const detail = await adapter.getFileDiff!('untracked.txt', { status: 'U' } as never);

			// An untracked file diffed from empty to N lines is a single insertion
			// hunk spanning the whole file — the empty baseline is what makes it so.
			const hunks = diffHunks(detail.originalContent, detail.modifiedContent);
			expect(hunks).toHaveLength(1);

			await applyHunkAction(appState, change, hunks[0], 'stage');

			// The index now holds exactly the worktree bytes, and nothing else moved.
			expect(await indexContents(r, 'untracked.txt')).toBe(content);
			expect(await worktreeContents(r, 'untracked.txt')).toBe(content);
			expect(await porcelainStatus(r)).toEqual([{ x: 'A', y: ' ', path: 'untracked.txt' }]);
		});

		// A (staged-only, a new file added to the index): HEAD has no such path, so
		// the original side is ''. The staged (index) and worktree sides are real.
		// This is the options object `getChanges` itself produces for a staged add.
		it('reports a staged addition as all-new: empty original against the real index', async () => {
			const r = await createTrackedRepo();
			await seedCommit(r);
			await r.write('added.txt', 'staged version\n');
			await r.git(['add', 'added.txt']);
			await r.write('added.txt', 'staged version\nplus an unstaged line\n');
			const adapter = engine.adapter(r);

			// Precondition: HEAD has no such path, the index holds the staged blob,
			// and the worktree holds a further edit. runGit returns stdout verbatim,
			// so the trailing newline is part of the content.
			expect((await runGit(r.path, r.env, ['cat-file', '-e', 'HEAD:added.txt'])).code).not.toBe(0);
			expect(await indexContents(r, 'added.txt')).toBe('staged version\n');
			expect(await worktreeContents(r, 'added.txt')).toBe('staged version\nplus an unstaged line\n');
			expect((await runGit(r.path, r.env, ['status', '--porcelain', '-z', '--', 'added.txt'])).stdout.startsWith('AM ')).toBe(true);

			// The combined AM entry carries status 'A'; the UI sends `{ status }` with
			// no `staged` key for it. Both spellings report the same empty original.
			const combined = engine.honorsStatus ? await adapter.getFileDiff!('added.txt', { status: 'A' } as never) : await adapter.getFileDiff!('added.txt');
			expect(combined.originalContent).toBe('');
			expect(combined.stagedContent).toBe('staged version\n');
			expect(combined.modifiedContent).toBe('staged version\nplus an unstaged line\n');

			// The staged view diffs the index against the same empty HEAD.
			const staged = await adapter.getFileDiff!('added.txt', { staged: true } as never);
			expect(staged.originalContent).toBe('');
			expect(staged.modifiedContent).toBe('staged version\n');
		});

		// A/D: a staged addition whose worktree copy is gone. The staging must be a
		// plain `rm`, not `git rm` — `git rm` also drops the index entry, which
		// leaves the path out of porcelain entirely and is NOT the A/D case.
		//
		// The UI never hand-builds this call. `getChanges` splits the porcelain
		// entry into a staged 'A' and an unstaged 'D', and the combined entry
		// (status 'A', no `staged` key) is what reaches `getFileDiff`. Driving that
		// real pipeline is what makes this a contract rather than a shape the UI
		// cannot produce.
		it('reports a staged addition deleted from the worktree as empty-original with the index retained', async () => {
			const r = await createTrackedRepo();
			await seedCommit(r);
			await r.write('gone.txt', 'was here\n');
			await r.git(['add', 'gone.txt']);
			await rm(`${r.path}/gone.txt`);
			const adapter = engine.adapter(r);

			// Precondition: porcelain really is x='A', y='D', and the index still holds it.
			expect((await runGit(r.path, r.env, ['status', '--porcelain', '-z', '--', 'gone.txt'])).stdout.startsWith('AD ')).toBe(true);
			expect(await indexContents(r, 'gone.txt')).toBe('was here\n');
			expect(await worktreeContents(r, 'gone.txt')).toBeNull();

			// Drive the real pipeline: getChanges splits it, the combined entry
			// takes the staged letter ('A'), and that is what the UI sends.
			const change = combinedChange(await adapter.getChanges!(), 'gone.txt');
			expect(change.status).toBe('A');
			expect(change.combined).toBe(true);

			const detail = engine.honorsStatus ? await adapter.getFileDiff!('gone.txt', { status: change.status } as never) : await adapter.getFileDiff!('gone.txt');
			expect(detail.originalContent).toBe('');
			expect(detail.stagedContent).toBe('was here\n');
			expect(detail.modifiedContent).toBe('');
		});

		// F5: unstage a staged addition's only hunk. The empty original is the
		// baseline the splice indexes against, and the patch `updateIndexContent`
		// renders must be one `git apply --cached` accepts — landing an empty entry
		// in the index. This is the write-path consequence of the empty baseline
		// that the read-only assertions above do not reach.
		it('unstaging a staged addition empties the index entry, proving the empty baseline indexes correctly', async () => {
			const r = await createTrackedRepo();
			await seedCommit(r);
			await r.write('added.txt', 'one\ntwo\nthree\n');
			await r.git(['add', 'added.txt']);
			const adapter = engine.adapter(r);
			const { appState } = hunkContext(r, adapter);

			const change = combinedChange(await adapter.getChanges!(), 'added.txt');
			expect(change.status).toBe('A');

			// The staged view is all-new: empty original, real index content.
			const detail = await adapter.getFileDiff!('added.txt', { staged: true } as never);
			expect(detail.originalContent).toBe('');
			expect(detail.modifiedContent).toBe('one\ntwo\nthree\n');
			const hunks = diffHunks(detail.originalContent, detail.modifiedContent);
			expect(hunks).toHaveLength(1);

			await applyHunkAction(appState, change, hunks[0], 'unstage');

			// The index entry is now empty and the worktree is untouched. The index
			// holds '' (an empty blob), not a deleted path.
			expect(await indexContents(r, 'added.txt')).toBe('');
			expect(await worktreeContents(r, 'added.txt')).toBe('one\ntwo\nthree\n');
			expect(await porcelainStatus(r)).toEqual([{ x: 'A', y: 'M', path: 'added.txt' }]);
		});

		// An empty file that was committed empty. Its diff is empty-vs-empty: all
		// three sides ''. It exercises the no-op and empty-patch edges of the write
		// path (`renderIndexPatch` emits no hunk for an empty add).
		it('reports an empty added file as empty on all three sides', async () => {
			const r = await createTrackedRepo();
			await seedCommit(r);
			await r.write('empty.txt', '');
			await r.git(['add', 'empty.txt']);
			const adapter = engine.adapter(r);

			const detail = await adapter.getFileDiff!('empty.txt', { staged: true } as never);
			expect(detail).toEqual({ originalContent: '', modifiedContent: '', stagedContent: '' });
		});
	});
}
