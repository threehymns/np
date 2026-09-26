import type { VCSAdapter, SwitchResult, VCSStatus, FileOrigin, GitChange, GitCommit, FileDiffDetail, GetFileDiffOptions } from '@np/core';
import { resolveDiffDetail, countLines } from '@np/core/project/vcs';
import { mapBounded, isNotFoundError, isDirectoryError } from '@np/core/utils';

export interface GitRunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** A function that runs git in a working directory, returning code + captured output. */
export type GitRunner = (workingDir: string, args: string[]) => Promise<GitRunResult>;

/** File operations the adapter needs beyond git itself: worktree reads and temp-file writes. */
export interface GitFileAccess {
	readFile(path: string): Promise<Uint8Array | string>;
	writeFile(path: string, content: string): Promise<void>;
	deleteEntry(path: string): Promise<void>;
	/**
	 * Whether `path` is a symbolic link. A git symlink is a blob whose content
	 * is the target path (mode 120000), never the text a user edits, so the
	 * adapter must know before it reads or writes one.
	 *
	 * Optional: an access object that cannot answer leaves every path treated as
	 * a regular file, which is the pre-existing behavior.
	 */
	isSymlink?(path: string): Promise<boolean>;
}

const ipcGitRunner: GitRunner = (workingDir, args) => window.electronAPI.gitRun(workingDir, args);

const ipcFileAccess: GitFileAccess = {
	readFile: async (path) => {
		const toNotFound = (cause: unknown): Error => {
			const message =
				cause instanceof Error && cause.message
					? cause.message
					: typeof (cause as any)?.message === 'string'
						? (cause as any).message
						: `ENOENT: no such file or directory, open '${path}'`;
			const err = new Error(message);
			err.name = 'NotFoundError';
			(err as any).code = 'ENOENT';
			return err;
		};
		let result: Uint8Array | string | unknown;
		try {
			result = await window.electronAPI.readFile(path);
		} catch (e) {
			// Rejected IPC error (old main, or non-marker path): normalize
			// ENOENT the same way ElectronStorage does.
			if (isNotFoundError(e)) throw toNotFound(e);
			throw e;
		}
		// Main resolves with a not-found marker for missing files instead of
		// rejecting. Callers here expect an ENOENT rejection (deleted files are
		// treated as empty), so re-throw preserving that contract.
		if (isNotFoundError(result)) {
			throw toNotFound(result);
		}
		return result as Uint8Array;
	},
	writeFile: (path, content) => window.electronAPI.writeFile(path, content),
	deleteEntry: (path) => window.electronAPI.deleteEntry(path),
	isSymlink: (path) => window.electronAPI.isSymlink(path)
};

export class SpawnGitAdapter implements VCSAdapter {
	constructor(
		private rootOrigin: FileOrigin,
		private readonly gitRunner: GitRunner = ipcGitRunner,
		private readonly fileAccess: GitFileAccess = ipcFileAccess
	) {}

	private async runGit(args: string[]): Promise<GitRunResult> {
		return await this.gitRunner(this.rootOrigin.path, args);
	}

	async detect(rootPath: string): Promise<boolean> {
		const res = await this.runGit(['-C', rootPath, 'rev-parse', '--is-inside-work-tree']);
		return res.code === 0 && res.stdout.trim() === 'true';
	}

	async init(rootPath?: string): Promise<void> {
		const targetPath = rootPath ?? this.rootOrigin.path;
		const res = await this.gitRunner(targetPath, ['init']);
		if (res.code !== 0) {
			throw new Error(res.stderr || `Failed to initialize git repository at ${targetPath}`);
		}
	}

	private static readonly PATH_NOT_FOUND_MARKERS = [
		'not in index',
		'does not exist in',
		'does not have an entry in index',
		'exists on disk, but not in',
		'did not match any file(s)',
		'neither on disk nor in the index'
	];

	/** Markers for `git rm --cached` reporting that no index entries matched the pathspec (an empty unborn index). */
	private static readonly RM_EMPTY_INDEX_MARKERS = [
		'did not match any files'
	];

	/** Markers for the unborn-HEAD failure: `git reset`/`git restore` resolving `HEAD` on a repository with no commits yet. */
	private static readonly UNBORN_HEAD_MARKERS = [
		"ambiguous argument 'HEAD'",
		'could not resolve',
		'as a valid ref'
	];

	private isPathNotFoundError(stderr: string): boolean {
		return SpawnGitAdapter.PATH_NOT_FOUND_MARKERS.some(marker => stderr.includes(marker));
	}

	private isRmEmptyIndexError(stderr: string): boolean {
		return SpawnGitAdapter.RM_EMPTY_INDEX_MARKERS.some(marker => stderr.includes(marker));
	}

	private isUnbornHeadError(stderr: string): boolean {
		return SpawnGitAdapter.UNBORN_HEAD_MARKERS.some(marker => stderr.includes(marker));
	}

	/**
	 * True when HEAD is unborn (i.e. a symbolic ref to a branch that has no commits yet,
	 * and no refs exist in the repository). A detached HEAD or a broken HEAD on a repository
	 * with existing commits/objects must not trigger the unborn fallback.
	 */
	private async isUnbornRepository(): Promise<boolean> {
		const symRef = await this.runGit(['symbolic-ref', '-q', 'HEAD']);
		if (symRef.code !== 0 || !symRef.stdout.trim()) {
			return false;
		}
		const headRef = await this.runGit(['rev-parse', '--verify', 'HEAD']);
		if (headRef.code === 0) {
			return false;
		}
		const refs = await this.runGit(['for-each-ref', '--format=%(refname)']);
		return refs.code === 0 && refs.stdout.trim() === '';
	}

	private async readGitObject(objectSpec: string): Promise<string | null> {
		const res = await this.runGit(['show', objectSpec]);
		if (res.code === 0) return res.stdout;
		if (this.isPathNotFoundError(res.stderr)) return null;
		throw new Error(res.stderr || `Failed to read git object ${objectSpec}`);
	}

	async getCurrentBranch(): Promise<string | null> {
		const res = await this.runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
		if (res.code !== 0) {
			const symRes = await this.runGit(['symbolic-ref', '--short', 'HEAD']);
			if (symRes.code === 0) {
				return symRes.stdout.trim() || null;
			}
			throw new Error(res.stderr || symRes.stderr || 'Failed to determine current branch');
		}
		const branch = res.stdout.trim();
		return branch === 'HEAD' ? null : branch;
	}

	async getBranches(): Promise<string[]> {
		const res = await this.runGit(['branch', '--format=%(refname:short)']);
		if (res.code !== 0) {
			throw new Error(res.stderr || 'Failed to get branch list');
		}
		return res.stdout.split('\n').map(line => line.trim()).filter(Boolean);
	}

	private parseStatusEntries(stdout: string): Array<{ x: string; y: string; filepath: string; origPath?: string }> {
		const result: Array<{ x: string; y: string; filepath: string; origPath?: string }> = [];
		const entries = stdout.split('\0');
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			if (!entry || entry.length < 3) continue;
			const x = entry[0];
			const y = entry[1];
			const filepath = entry.substring(3);
			let origPath: string | undefined;
			if (x === 'R' || y === 'R') {
				origPath = entries[++i];
			} else if (x === 'C' || y === 'C') {
				// Porcelain v1 -z emits the source path as a subsequent NUL token for copies.
				// Consume it to keep token alignment without recording a rename source.
				i++;
			}
			if (filepath.endsWith('/')) continue;
			result.push({ x, y, filepath, origPath });
		}
		return result;
	}

	async getStatus(): Promise<VCSStatus> {
		const res = await this.runGit(['status', '--porcelain=v1', '-z', '-uall']);
		if (res.code !== 0) {
			throw new Error(res.stderr || 'Failed to get repository status');
		}
		const entries = this.parseStatusEntries(res.stdout);
		const uncommittedFiles = entries.map(e => e.filepath);
		return {
			isDirty: uncommittedFiles.length > 0,
			uncommittedFiles
		};
	}

	async switchBranch(branchName: string, options?: { dryRun?: boolean }): Promise<SwitchResult> {
		const currentBranch = await this.getCurrentBranch();
		if (currentBranch === branchName) {
			return { status: 'noop' };
		}

		const refRes = await this.runGit(['rev-parse', '--verify', branchName]);
		if (refRes.code !== 0) {
			return { status: 'error', message: `Target branch ${branchName} does not exist` };
		}

		const status = await this.getStatus();
		if (status.uncommittedFiles.length > 0) {
		// A dirty file conflicts with the target branch iff its path differs
		// between the HEAD and target trees. A single tree-to-tree diff reports
		// exactly those files in one git invocation, instead of the previous
		// two `git rev-parse` processes per file (O(N) process spawns). Desktop-only
		// O(1): the browser IsomorphicGitAdapter still walks files one-by-one (see
		// packages/adapters-browser/src/isomorphic-git.ts).
		// We avoid spreading uncommittedFiles into CLI arguments to prevent E2BIG
		// on large repositories, intersecting diff changes with the dirty set in JS.
		// `-z` NUL-separates the paths so non-ASCII filenames come back raw and
		// unquoted, matching the raw paths getStatus() returns.
		// Untracked collisions are covered too: a path absent from HEAD but
		// present on the target appears in the diff, and getStatus() reports
		// untracked files in uncommittedFiles, so the intersection catches them
		// (see contract test 'blocks switch when local untracked file collides
		// with target branch tracked file'). #69 owns any future `worktree` vs
		// `conflict` reason harmonization.
			const diffRes = await this.runGit(['diff', '--name-only', '-z', 'HEAD', branchName]);
			if (diffRes.code !== 0) {
				return { status: 'error', message: diffRes.stderr || `Failed to diff HEAD with ${branchName}` };
			}
			const uncommittedSet = new Set(status.uncommittedFiles);
			const conflictingFiles = diffRes.stdout
				.split('\0')
				.filter((p) => p.length > 0 && uncommittedSet.has(p));

			if (conflictingFiles.length > 0) {
				return { status: 'blocked', reason: 'conflict', files: conflictingFiles };
			}
		}

		if (options?.dryRun) {
			return { status: 'switched' };
		}

		const checkoutRes = await this.runGit(['checkout', branchName]);
		if (checkoutRes.code !== 0) {
			return { status: 'error', message: checkoutRes.stderr || `Failed to checkout branch ${branchName}` };
		}

		return { status: 'switched' };
	}

	async stageFile(filepath: string): Promise<void> {
		const res = await this.runGit(['add', '--', filepath]);
		if (res.code !== 0) {
			throw new Error(res.stderr || `Failed to stage file: ${filepath}`);
		}
	}

	async unstageFile(filepath: string): Promise<void> {
		const origPath = await this.resolveOrigPath(filepath);
		const paths = origPath && origPath !== filepath ? [origPath, filepath] : [filepath];
		const res = await this.runGit(['reset', 'HEAD', '--', ...paths]);
		if (res.code !== 0) {
			// An unborn HEAD (no commits yet) cannot resolve 'HEAD' as a revision
			// (older git rejects the explicit reset outright; newer git accepts it),
			// so remove the index entries directly, leaving the worktree untouched —
			// the same outcome reset produces once a first commit exists. The message
			// alone is not proof of an unborn HEAD: a broken HEAD on a repo with
			// commits emits the same error, so the fallback only runs when the
			// repository is genuinely commit-less.
			if (this.isUnbornHeadError(res.stderr) && (await this.isUnbornRepository())) {
				const rmRes = await this.runGit(['rm', '--cached', '-q', '--', ...paths]);
				if (rmRes.code !== 0 && !this.isRmEmptyIndexError(rmRes.stderr)) {
					throw new Error(rmRes.stderr || `Failed to unstage file: ${filepath}`);
				}
				return;
			}
			throw new Error(res.stderr || `Failed to unstage file: ${filepath}`);
		}
	}

	private async getRenameEntry(filepath: string): Promise<{ origPath?: string; hasWorktreeEdits: boolean; isCopy: boolean } | null> {
		const statusRes = await this.runGit(['status', '--porcelain=v1', '-z', '-uall']);
		if (statusRes.code === 0 && statusRes.stdout) {
			const entries = this.parseStatusEntries(statusRes.stdout);
			const match = entries.find(e => e.filepath === filepath && (e.origPath || e.x === 'C' || e.y === 'C'));
			if (match) {
				// Copy entries never record origPath (parseStatusEntries consumes the
				// copy-source token without recording it): copies are not renames, so
				// no source path is returned, only the isCopy flag.
				return {
					origPath: match.origPath,
					hasWorktreeEdits: match.y === 'M',
					isCopy: match.x === 'C' || match.y === 'C'
				};
			}
		}
		return null;
	}

	private async resolveOrigPath(filepath: string): Promise<string | undefined> {
		const entry = await this.getRenameEntry(filepath);
		return entry?.origPath;
	}

	private async cleanIfPresent(filepath: string): Promise<void> {
		const cleanRes = await this.runGit(['clean', '-fd', '--', filepath]);
		if (cleanRes.code !== 0) {
			throw new Error(cleanRes.stderr || `Failed to discard changes for ${filepath}`);
		}
	}

	/**
	 * The paths whose deletion is staged but which have since been recreated in the
	 * worktree, read from an already-parsed porcelain v1 listing.
	 *
	 * Git reports that state as two entries for the same path: `D  f.txt` (the
	 * staged deletion, with an empty worktree column) alongside `?? f.txt` (present
	 * on disk). Together they mean the user deleted the file, staged the deletion,
	 * and then wrote a new copy over it. The worktree copy's content is in neither
	 * the index nor HEAD, so nothing else in the repository can restore it.
	 *
	 * Both entries are required, and the deletion must be in the *index* column: a
	 * plain worktree deletion (` D`) plus an untracked path of the same name has
	 * the same shape here but is not this state.
	 */
	private findResurrectedAfterStagedDelete(entries: Array<{ x: string; y: string; filepath: string }>): string[] {
		const stagedDeletions = new Set(
			entries.filter(e => e.x === 'D' && e.y === ' ').map(e => e.filepath)
		);
		return entries.filter(e => e.x === '?' && e.y === '?' && stagedDeletions.has(e.filepath)).map(e => e.filepath);
	}

	private async readResurrectedAfterStagedDelete(): Promise<string[]> {
		const res = await this.runGit(['status', '--porcelain=v1', '-z', '-uall']);
		if (res.code !== 0) return [];
		return this.findResurrectedAfterStagedDelete(this.parseStatusEntries(res.stdout));
	}

	/**
	 * Finds the tracked source of an unstaged worktree rename whose destination is
	 * `filepath`, or undefined when `filepath` is not such a destination.
	 *
	 * An unstaged worktree rename is invisible to git: porcelain v1 reports the
	 * destination as an untracked file and the source as a worktree deletion, and
	 * rename detection does not help because it only pairs content between two
	 * commits, not between the index and the worktree. Verified directly:
	 * `git status --porcelain=v1 -uall --find-renames` still prints ` D src.txt` /
	 * `?? moved.txt`, and `git diff --find-renames` is empty because the index
	 * equals HEAD.
	 *
	 * So the pair is recovered by content instead: candidates are paths git reports
	 * as worktree-deleted *and* still present in the index, and a candidate matches
	 * only when its index content is byte-identical to the destination.
	 *
	 * Byte-identical is necessary but not sufficient to identify a source. Two
	 * tracked files can hold the same bytes, and a file the user deleted on purpose
	 * is indistinguishable from the source half of a rename — no git invocation
	 * separates the two. So a match must be *unique*: when two or more candidates
	 * match, the pairing is ambiguous and no source is recovered, because
	 * guessing would resurrect a deliberate deletion while still leaving the real
	 * source deleted. The destination is then simply treated as an untracked file,
	 * which is the behaviour that predates this recovery.
	 */
	private async findUnstagedRenameSource(filepath: string): Promise<string | undefined> {
		const res = await this.runGit(['status', '--porcelain=v1', '-z', '-uall']);
		if (res.code !== 0) return undefined;
		const entries = this.parseStatusEntries(res.stdout);
		const destination = entries.find(e => e.filepath === filepath);
		if (!destination || destination.x !== '?' || destination.y !== '?') return undefined;

		let destinationContent: string;
		try {
			const buffer = await this.fileAccess.readFile(this.rootOrigin.path + '/' + filepath);
			destinationContent = typeof buffer === 'string' ? buffer : new TextDecoder().decode(buffer);
		} catch {
			// The destination is gone between status and read; nothing to pair.
			return undefined;
		}

		const deletedSources = entries.filter(e => e.y === 'D' && e.filepath !== filepath);
		const matches: string[] = [];
		for (const source of deletedSources) {
			const indexContent = await this.readGitObject(`:${source.filepath}`);
			if (indexContent !== null && indexContent === destinationContent) {
				matches.push(source.filepath);
			}
		}
		return matches.length === 1 ? matches[0] : undefined;
	}

	async discardChanges(filepath: string, options?: { staged?: boolean }): Promise<void> {
		if (options?.staged === false) {
			// A file whose deletion is staged but which has been recreated holds
			// content in neither the index nor HEAD, and git's own model calls that
			// worktree copy untracked, so there are no unstaged changes to revert and
			// the only way to act on it is to delete it. Both entries below would
			// destroy the only copy: `restore` cannot reach the path (it left the
			// index), and the resulting "pathspec did not match" error is what leads
			// to the `cleanIfPresent` fallback that unlinks it. Measured on a real
			// repository: git 2.55.
			if ((await this.readResurrectedAfterStagedDelete()).includes(filepath)) {
				return;
			}
			// Unstaged scope: reset only the worktree copy to the index version. If the
			// destination path is not in the index (e.g. an unstaged worktree rename),
			// restore the original source path from the index and clean the destination.
			const res = await this.runGit(['restore', '--worktree', '--', filepath]);
			if (res.code !== 0) {
				if (!this.isPathNotFoundError(res.stderr)) {
					throw new Error(res.stderr || `Failed to discard changes for ${filepath}`);
				}
				// An unstaged worktree rename is not representable in porcelain v1: git
				// reports it as a worktree deletion plus an untracked file, never as a
				// rename pair, so `resolveOrigPath` cannot find a source and the
				// recovery below never ran. Discarding the destination therefore left
				// the tracked source deleted too, destroying a file git still knows
				// about — and any content the user had added at the destination, which
				// was never in the object store and so was unrecoverable.
				//
				// Pair the untracked destination back to a tracked source by content: git
				// itself pairs renames the same way. The source must still be missing
				// from the worktree and present in the index, so an unrelated deletion
				// that merely happens to hold identical content is never restored over.
				const source = await this.findUnstagedRenameSource(filepath);
				if (source) {
					const restoreOrigRes = await this.runGit(['restore', '--worktree', '--', source]);
					if (restoreOrigRes.code !== 0) {
						throw new Error(restoreOrigRes.stderr || `Failed to discard changes for ${filepath}`);
					}
				}
				await this.cleanIfPresent(filepath);
			}
			return;
		}

		const renameEntry = await this.getRenameEntry(filepath);
		if (renameEntry?.isCopy) {
			// Staged copy: unstage the destination only — the source file is never
			// touched. `checkout HEAD -- dest` fails because the destination is absent
			// from HEAD, so a plain reset removes the copy from the index. A copy whose
			// destination also holds unstaged edits (CM) keeps its worktree copy after
			// the reset: it is left in place instead of being cleaned away with the
			// user's edits in it.
			const resetRes = await this.runGit(['reset', 'HEAD', '--', filepath]);
			if (resetRes.code !== 0) {
				throw new Error(resetRes.stderr || `Failed to discard changes for ${filepath}`);
			}
			if (!renameEntry.hasWorktreeEdits) {
				await this.cleanIfPresent(filepath);
			}
			return;
		}

		const origPath = renameEntry?.origPath;
		if (origPath && origPath !== filepath) {
			// Staged rename reported by git itself: revert the whole rename. `checkout HEAD -- newPath`
			// fails because the new path is absent from HEAD, so restore the original path from
			// HEAD in index and worktree and remove the new path, instead of dropping the
			// original tracked file.
			const preserveDestination = renameEntry.hasWorktreeEdits;
			const resetRes = await this.runGit(['reset', 'HEAD', '--', origPath, filepath]);
			if (resetRes.code !== 0) {
				throw new Error(resetRes.stderr || `Failed to discard changes for ${filepath}`);
			}
			const checkoutRes = await this.runGit(['checkout', 'HEAD', '--', origPath]);
			if (checkoutRes.code !== 0) {
				throw new Error(checkoutRes.stderr || `Failed to discard changes for ${filepath}`);
			}
			// An RM rename (staged rename plus unstaged edits at the destination) keeps its
			// worktree copy: after the reset it is untracked, so it is left in place instead
			// of being cleaned away with the user's edits in it.
			if (!preserveDestination) {
				await this.cleanIfPresent(filepath);
			}
			return;
		}

		const res = await this.runGit(['checkout', 'HEAD', '--', filepath]);
		if (res.code !== 0) {
			// Only a path absent from HEAD (a staged addition or an untracked file)
			// reaches the reset+clean recovery; any other checkout failure surfaces
			// as-is instead of being masked by a successful reset.
			if (!this.isPathNotFoundError(res.stderr)) {
				throw new Error(res.stderr || `Failed to discard changes for ${filepath}`);
			}
			const resetRes = await this.runGit(['reset', 'HEAD', '--', filepath]);
			if (resetRes.code !== 0 && !this.isPathNotFoundError(resetRes.stderr)) {
				// A trailing "did not match" means the path has no index entry either
				// (untracked), so proceed to clean instead of failing the discard.
				throw new Error(resetRes.stderr || `Failed to discard changes for ${filepath}`);
			}
			await this.cleanIfPresent(filepath);
		}
	}

	async stageAll(): Promise<void> {
		const res = await this.runGit(['add', '-A']);
		if (res.code !== 0) {
			throw new Error(res.stderr || 'Failed to stage all changes');
		}
	}

	async unstageAll(): Promise<void> {
		const res = await this.runGit(['restore', '--staged', '.']);
		if (res.code !== 0) {
			// Unborn HEAD: `git restore --staged` cannot resolve its default source.
			// Empty the index with `rm --cached` instead, leaving the worktree
			// untouched; a trailing "did not match" means nothing was staged. The
			// marker also fires for a broken HEAD on a repo with commits, so the
			// fallback only runs when the repository is genuinely commit-less.
			if (this.isUnbornHeadError(res.stderr) && (await this.isUnbornRepository())) {
				const rmRes = await this.runGit(['rm', '--cached', '-q', '-r', '--', '.']);
				if (rmRes.code !== 0 && !this.isRmEmptyIndexError(rmRes.stderr)) {
					throw new Error(rmRes.stderr || 'Failed to unstage all changes');
				}
				return;
			}
			throw new Error(res.stderr || 'Failed to unstage all changes');
		}
	}

	async discardAll(): Promise<void> {
		// A path whose deletion is staged but which has been recreated holds content
		// in neither HEAD nor the index, so a blanket "discard everything" would have
		// to destroy it: `restore --staged --worktree .` cannot reach the path (it
		// left the index) and `clean -fd .` unlinks it as an untracked file. Measured
		// on a real repository, git 2.55 — `clean -fd` also ignores `-e
		// :(exclude)` pathspecs for untracked files, so an exclusion cannot be used
		// to shield the path; the removals are enumerated instead.
		const resurrected = new Set(await this.readResurrectedAfterStagedDelete());

		// Unstage and restore everything except those paths, so a resurrected file
		// keeps its staged deletion and its worktree copy.
		const restoreArgs = ['restore', '--staged', '--worktree', '.'];
		for (const filepath of resurrected) {
			restoreArgs.push(`:(top,exclude,literal)${filepath}`);
		}
		const restoreRes = await this.runGit(restoreArgs);
		if (restoreRes.code !== 0) {
			throw new Error(restoreRes.stderr || 'Failed to discard all changes');
		}

		// Whatever is untracked once the restore has run is what this discard is
		// allowed to remove. That cannot be predicted from the listing above -- a
		// resurrected path left the index because of the staged deletion, so it only
		// becomes untracked at that point -- so it is read here rather than assumed.
		// The recreated paths are dropped from the list and stay on disk.
		const remainingRes = await this.runGit(['status', '--porcelain=v1', '-z', '-uall']);
		if (remainingRes.code !== 0) {
			throw new Error(remainingRes.stderr || 'Failed to discard all changes');
		}
		const removable = this.parseStatusEntries(remainingRes.stdout)
			.filter(e => e.x === '?' && e.y === '?' && !resurrected.has(e.filepath))
			.map(e => e.filepath);
		if (removable.length === 0) return;
		const cleanRes = await this.runGit(['clean', '-fd', '--', ...removable]);
		if (cleanRes.code !== 0) {
			throw new Error(cleanRes.stderr || 'Failed to discard all changes');
		}
	}

	async getUserConfig(): Promise<{ name: string; email: string } | null> {
		const nameRes = await this.runGit(['config', 'user.name']);
		const emailRes = await this.runGit(['config', 'user.email']);
		const name = nameRes.code === 0 ? nameRes.stdout.trim() : '';
		const email = emailRes.code === 0 ? emailRes.stdout.trim() : '';
		if (name && email) return { name, email };
		return null;
	}

	async commit(message: string, options?: { author?: { name: string; email: string }; amend?: boolean }): Promise<void> {
		const args = ['commit'];
		if (options?.amend) {
			args.push('--amend');
		}
		args.push('-m', message);
		if (options?.author) {
			args.push(`--author=${options.author.name} <${options.author.email}>`);
		}
		const res = await this.runGit(args);
		if (res.code !== 0) {
			throw new Error(res.stderr || `Git commit failed with code ${res.code}`);
		}
	}

	async createBranch(branchName: string): Promise<void> {
		const res = await this.runGit(['checkout', '-b', branchName]);
		if (res.code !== 0) {
			throw new Error(res.stderr || `Failed to create branch ${branchName}`);
		}
	}

	async getCommits(): Promise<GitCommit[]> {
		// `--name-only` without `-z` C-quotes any path holding an unusual byte, so
		// a name containing a newline arrives as the two characters `\` and `n`
		// rather than a real newline. The line-oriented parse still works, but it
		// hands the caller a *display* string that resolves to no file. `-z`
		// instead emits every path raw and NUL-delimited, so a name can contain
		// any byte, including the newlines and `|` this format uses to separate
		// its own fields.
		const res = await this.runGit(['log', '-z', '-n', '50', '--date=short', '--pretty=format:%x00%h|%an <%ae>|%ad|%s', '--name-only', '--no-renames']);
		if (res.code !== 0) {
			if (res.stderr.includes('does not have any commits yet') || res.stderr.includes('fatal: bad default revision')) {
				return [];
			}
			throw new Error(res.stderr || 'Failed to retrieve git commit log');
		}
		// With `-z` git emits a NUL-separated stream shaped like:
		//
		//     \0<hash>|<author>|<date>|<subject>\n<path>\0<path>\0\0\0<next header>...
		//
		// `%x00` prefixes each header, every path is newline- and NUL-terminated,
		// and two more NULs separate one commit from the next. Splitting on NUL
		// consumes those delimiters, so the header is identified structurally --
		// it is the first record after a blank one -- rather than by the shape of
		// its fields. That way a filename may contain `|`, a newline, or any other
		// byte and still be read back as exactly the one path it is.
		const commits: GitCommit[] = [];
		let current: GitCommit | undefined;
		let expectHeader = true;
		for (const record of res.stdout.split('\0')) {
			if (record === '') {
				// A blank record only ever closes one commit's path list.
				expectHeader = true;
				continue;
			}
			if (expectHeader) {
				// The subject is followed by a newline, then the first path, so the
				// header is everything before the record's *first* newline and the
				// first path is everything after it -- newline and all. Splitting on
				// every newline instead would tear a path that itself holds one into
				// two names, neither of which exists.
				const sep = record.indexOf('\n');
				const headerLine = sep === -1 ? record : record.slice(0, sep);
				const firstPath = sep === -1 ? '' : record.slice(sep + 1);
				const [hash, author, date, ...rest] = headerLine.split('|');
				current = {
					hash,
					author,
					date,
					message: rest.join('|'),
					files: firstPath === '' ? [] : [firstPath]
				};
				commits.push(current);
				expectHeader = false;
			} else if (current) {
				// The whole record is one path, newline and all.
				current.files.push(record);
			}
		}
		return commits;
	}

	/**
	 * Parse `diff --numstat -z` into per-path counts.
	 *
	 * With `-z`, git never C-quotes a path, so a name may contain newlines,
	 * tabs, quotes, and `|` freely. The framing has two shapes, both verified
	 * against real git output:
	 *
	 *  - Ordinary change: `<add>\t<del>\t<path>\0`
	 *  - Rename or copy:  `<add>\t<del>\t\0<source>\0<dest>\0`
	 *
	 * A rename puts an *empty* path in the count prefix and follows it with the
	 * two names as separate NUL-terminated fields, so the record must be read
	 * positionally: the counts, then the first name, then the second when the
	 * first was empty.
	 *
	 * Because the name is whatever remains after the count prefix, a tab inside
	 * the path is preserved — splitting the record on tabs would corrupt it.
	 *
	 * A binary file reports `-` for both counts. That is not a number, so
	 * `parseInt` yields NaN and the `|| 0` fallback turns it into the same zero
	 * the previous implementation produced, keeping a usable count in the badge
	 * rather than leaking NaN.
	 */
	private parseNumstat(output: string): Map<string, { additions: number; deletions: number }> {
		const stats = new Map<string, { additions: number; deletions: number }>();
		if (!output) return stats;
		// Records are NUL-terminated, so the final field is followed by a NUL and
		// the split leaves an empty tail that must not become a key.
		const fields = output.split('\0');
		for (let i = 0; i < fields.length; i++) {
			const field = fields[i];
			if (!field) continue;
			// The counts and the path are the only tabs in an ordinary record;
			// the second one introduces the path.
			const pathStart = field.indexOf('\t', field.indexOf('\t') + 1);
			if (pathStart === -1) continue;
			const [addField, delField] = field.slice(0, pathStart).split('\t');
			if (addField === undefined || delField === undefined) continue;
			const counts = {
				additions: parseInt(addField, 10) || 0,
				deletions: parseInt(delField, 10) || 0
			};
			const first = field.slice(pathStart + 1);
			if (first) {
				stats.set(first, counts);
				continue;
			}
			// An empty name means a rename or copy: the source and destination are
			// the next two fields, and the change list asks for the destination.
			const source = fields[i + 1];
			const dest = fields[i + 2];
			if (dest) stats.set(dest, counts);
			if (source && dest) stats.set(source, counts);
		}
		return stats;
	}

	private static readonly EMPTY_STAT = { additions: 0, deletions: 0 };

	/** How many untracked worktree files getChanges reads per concurrent batch. */
	private static readonly UNTRACKED_READ_CONCURRENCY = 8;

	async getChanges(): Promise<GitChange[]> {
		const [statusRes, stagedNumstatRes, unstagedNumstatRes] = await Promise.all([
			this.runGit(['status', '--porcelain=v1', '-z', '-uall']),
			this.runGit(['-c', 'core.quotepath=false', 'diff', '--cached', '--numstat', '-z']),
			this.runGit(['-c', 'core.quotepath=false', 'diff', '--numstat', '-z'])
		]);

		if (statusRes.code !== 0) {
			throw new Error(statusRes.stderr || 'Failed to get git status for changes');
		}

		const stagedStats = this.parseNumstat(stagedNumstatRes.stdout);
		const unstagedStats = this.parseNumstat(unstagedNumstatRes.stdout);

		const changes: GitChange[] = [];
		const entries = this.parseStatusEntries(statusRes.stdout);

		// Untracked files are read from disk for their line counts; collect them
		// first so the reads run with bounded concurrency instead of one at a time
		// or all at once. Porcelain always lists untracked entries last, so pushing
		// them after the loop keeps the output in git status order.
		const untrackedPaths: string[] = [];

		for (const { x, y, filepath } of entries) {

			if (x !== ' ' && x !== '?') {
				const status = x === 'A' ? 'A' : (x === 'D' ? 'D' : 'M');
				const stat = stagedStats.get(filepath) ?? SpawnGitAdapter.EMPTY_STAT;

				changes.push({
					filepath,
					status,
					additions: stat.additions,
					deletions: stat.deletions,
					diff: '',
					staged: true
				});
			}

			if (y !== ' ') {
				const status = y === '?' ? 'U' : (y === 'D' ? 'D' : 'M');

				if (y === '?') {
					untrackedPaths.push(filepath);
				} else {
					const stat = unstagedStats.get(filepath) ?? SpawnGitAdapter.EMPTY_STAT;

					changes.push({
						filepath,
						status,
						additions: stat.additions,
						deletions: stat.deletions,
						diff: '',
						staged: false
					});
				}
			}
		}

		// git diff --numstat never includes untracked files, so count lines directly.
		const counts = await mapBounded(untrackedPaths, SpawnGitAdapter.UNTRACKED_READ_CONCURRENCY, async (filepath) => {
			let additions = 0;
			try {
				const buffer = await this.fileAccess.readFile(this.rootOrigin.path + '/' + filepath);
				const content = typeof buffer === 'string' ? buffer : new TextDecoder().decode(buffer);
				additions = countLines(content);
			} catch (e) {}
			return { filepath, additions };
		});
		for (const { filepath, additions } of counts) {
			changes.push({
				filepath,
				status: 'U',
				additions,
				deletions: 0,
				diff: '',
				staged: false
			});
		}

		return changes;
	}

	private async readHeadAndIndex(filepath: string, origPath: string): Promise<{ headContent: string; indexContent: string }> {
		const [headObj, indexObj] = await Promise.all([
			this.readGitObject(`HEAD:${origPath}`),
			this.readGitObject(`:${filepath}`)
		]);

		const headContent = headObj ?? '';
		let indexContent = indexObj;

		if (indexContent === null && origPath !== filepath) {
			const origIndexObj = await this.readGitObject(`:${origPath}`);
			indexContent = origIndexObj ?? headContent;
		}

		return {
			headContent,
			indexContent: indexContent ?? ''
		};
	}

	// EAFP: attempt reading worktree content; a deleted/missing file is a genuine empty case
	private async readWorktreeContent(filepath: string): Promise<string> {
		try {
			const buffer = await this.fileAccess.readFile(this.rootOrigin.path + '/' + filepath);
			return typeof buffer === 'string' ? buffer : new TextDecoder().decode(buffer);
		} catch (e) {
			// A directory is not a text file. `git status` lists an untracked
			// symlink-to-directory as `??`, so the UI can offer it for viewing;
			// reading it as text is meaningless rather than an error worth
			// surfacing, and decoding EISDIR verbatim would be a raw syscall
			// string leaking into a user-facing path.
			if (isDirectoryError(e)) {
				return '';
			}
			if (!isNotFoundError(e)) {
				throw e;
			}
			return '';
		}
	}

	/**
	 * Whether a path currently exists in the worktree.
	 *
	 * Used to check the premise behind a porcelain `D` status, which describes the
	 * index rather than the disk. Any failure other than "not found" is reported as
	 * existing, so an unreadable-but-present file is read (and its read error
	 * surfaces) instead of being silently reported as empty.
	 */
	private async worktreeFileExists(filepath: string): Promise<boolean> {
		try {
			await this.fileAccess.readFile(this.rootOrigin.path + '/' + filepath);
			return true;
		} catch (e) {
			if (isNotFoundError(e)) return false;
			return true;
		}
	}

	async getFileDiff(filepath: string, options?: GetFileDiffOptions): Promise<FileDiffDetail> {
		// Optimization: If the file is untracked ('U'), it has no HEAD or index objects.
		if (options?.status === 'U') {
			const worktreeContent = options.staged !== true ? await this.readWorktreeContent(filepath) : '';
			return resolveDiffDetail('', '', worktreeContent, options);
		}

		// Optimization: If a file is added ('A'), HEAD is guaranteed empty.
		if (options?.status === 'A') {
			const worktreeContent = options?.staged !== true ? await this.readWorktreeContent(filepath) : '';
			const indexObj = await this.readGitObject(`:${filepath}`);
			return resolveDiffDetail('', indexObj ?? '', worktreeContent, options);
		}

		// Optimization: If file was deleted ('D') in worktree (unstaged or combined), skip disk read.
		//
		// A porcelain status of `D` means "the index holds a deletion", NOT "the file
		// is gone from disk". Delete a file, stage the deletion, then recreate it,
		// and git reports both `D  f.txt` and `?? f.txt`; the UI combines those into
		// one entry whose status is `D` (see `combineChangesByFilepath`). Trusting
		// `D` unconditionally therefore reports the worktree as empty while it holds
		// real content, and the next "discard" writes HEAD content back over that
		// file — unrecoverable loss of work that was never staged or committed.
		//
		// So the worktree is read unless the status says the index holds a deletion
		// AND the file is genuinely absent. `readWorktreeContent` returns '' for a
		// missing file, so a file that vanished between the status listing and this
		// read still yields '' without a second probe.
		const deletedInIndex = options?.status === 'D' && options?.staged !== true;
		const worktreeContent =
			options?.staged === true ? '' : deletedInIndex && !(await this.worktreeFileExists(filepath)) ? '' : await this.readWorktreeContent(filepath);

		const origPath = (await this.resolveOrigPath(filepath)) || filepath;
		const { headContent, indexContent } = await this.readHeadAndIndex(filepath, origPath);

		return resolveDiffDetail(headContent, indexContent, worktreeContent, options);
	}

	/**
	 * Reject a write that would corrupt a symlink.
	 *
	 * A git symlink's blob content is its *target path*, not file text, so both
	 * write paths would damage it: `updateFileContent` follows the link and
	 * overwrites the target file, while `updateIndexContent` replaces the blob
	 * with editor text and leaves mode 120000 in place, yielding a tree whose
	 * link target is arbitrary text. Declining the write is the only safe answer.
	 *
	 * A path that cannot be stat'd is not a symlink. `updateIndexContent`
	 * legitimately stages files that do not exist on disk yet, so a missing path
	 * must pass through rather than abort the write.
	 */
	private async assertNotSymlink(filepath: string): Promise<void> {
		if (!this.fileAccess.isSymlink) return;
		const fullPath = this.rootOrigin.path + '/' + filepath;
		try {
			if (await this.fileAccess.isSymlink(fullPath)) {
				throw new Error(
					`Cannot edit ${filepath}: it is a symbolic link. A symlink's content is its ` +
						'target path, not editable text.'
				);
			}
		} catch (e) {
			if (isNotFoundError(e)) return;
			throw e;
		}
	}

	async updateFileContent(filepath: string, content: string): Promise<void> {
		await this.assertNotSymlink(filepath);
		const fullPath = this.rootOrigin.path + '/' + filepath;
		await this.fileAccess.writeFile(fullPath, content);
	}

	private static readonly DEFAULT_INDEX_MODE = '100644';

	/** Line count of text in unified-diff terms: a trailing newline is not a line. */
	private static textLineCount(text: string): number {
		if (text === '') return 0;
		const newlines = text.match(/\n/g)?.length ?? 0;
		return newlines + (text.endsWith('\n') ? 0 : 1);
	}

	private static hunkRange(count: number): string {
		if (count === 0) return '0,0';
		return count === 1 ? '1' : `1,${count}`;
	}

	private static hunkBody(text: string, prefix: '+' | '-'): string {
		if (text === '') return '';
		const body = text.endsWith('\n') ? text.slice(0, -1) : text;
		// Content of exactly "\n" is one line in unified-diff terms but its body is
		// empty, so emit a lone prefixed line — the same shape git's own diff uses —
		// instead of a hunk whose claimed line count an empty body cannot fulfill
		// (git apply rejects that as corrupt).
		const lines = body === '' ? [prefix] : body.split('\n').map(line => `${prefix}${line}`);
		// A file without a trailing newline needs the no-newline marker, or git
		// apply would silently add one and the index would not hold exact content.
		if (!text.endsWith('\n')) {
			lines.push('\\ No newline at end of file');
		}
		return lines.join('\n');
	}

	/**
	 * C-quotes one side of a diff path for use in a patch header line.
	 *
	 * Git's own diff format quotes a path the same way: wrapped in double quotes,
	 * with `\a \b \t \n \v \f \r \" \\` for those and three-digit octal for every
	 * other byte it does not consider printable. This is not cosmetic. The
	 * `diff --git` header is TAB-delimited and its lines are newline-terminated,
	 * so a raw tab inside a filename splits the line and a raw CR ends it — either
	 * one addresses the path truncated before it. Staging a hunk of `ta<TAB>b.txt`
	 * wrote `ta` instead, and a hunk of `pre<CR>fix.txt` wrote `pre`, both with
	 * `git apply` exiting 0 and reporting no error.
	 *
	 * The `a/` and `b/` prefixes go INSIDE the quotes (`"a/ta\tb.txt"`), which is
	 * what git itself emits. Leaving the prefix outside yields `a/"ta\tb.txt"`, a
	 * token git cannot parse — it then reports "inconsistent new filename" when
	 * the `---`/`+++` lines disagree with the header. All three path lines of a
	 * patch must therefore be quoted together; mixing forms is not enough.
	 */
	private static quotePatchPath(path: string): string {
		// git's C-quoting, measured against `git diff` itself over all 126 characters
		// a filename can hold. A path needs the whole quoted form exactly when it holds
		// one of the C escapes below or a character outside printable ASCII — the
		// whole set, not a hand-picked subset that keeps needing another character
		// added after the last bug report.
		//
		// The table is keyed by CODE UNIT and the control characters are spelled as
		// escapes: `'\a'` in source is the BEL character, not the two characters
		// `\` and `a`, so keying by a written-out `'\a'` would also match every plain
		// `a` in a filename and escape it as `\a`.
		const C_ESCAPES: Record<string, string> = {
			'\u0007': '\\a',
			'\u0008': '\\b',
			'\t': '\\t',
			'\n': '\\n',
			'\u000b': '\\v',
			'\u000c': '\\f',
			'\r': '\\r',
			'"': '\\"',
			'\\': '\\\\'
		};
		// The octal form escapes one BYTE at a time, so the path is walked by UTF-16
		// code unit rather than by code point. `Array.from` would hand back a whole
		// character (U+00E9 for `é`) and escape its code point, but git escapes the
		// bytes that name the file on disk — `c3 a9` for `é`, written `\303\251`.
		// Getting that wrong renders a header naming a file git cannot find.
		const escaped = path
			.split('')
			.map(ch => {
				const named = C_ESCAPES[ch];
				if (named !== undefined) return named;
				// git quotes exactly when a character falls outside printable ASCII
				// (U+0020..U+007E), which is the range measured above.
				if (ch >= ' ' && ch <= '~') return ch;
				return Array.from(new TextEncoder().encode(ch), byte => `\\${byte.toString(8).padStart(3, '0')}`).join('');
			})
			.join('');
		// A path with no character git treats specially is left unquoted, exactly
		// as `git diff` renders it.
		return escaped === path ? path : `"${escaped}"`;
	}

	/** The `a/<path>` / `b/<path>` side of a diff header, C-quoted whole. */
	private static patchSidePath(side: 'a' | 'b', filepath: string): string {
		return SpawnGitAdapter.quotePatchPath(`${side}/${filepath}`);
	}

	/**
	 * Fresh patch rendering for `updateIndexContent`. The patch is applied literally
	 * against the current index for the target filepath only, so it never modifies
	 * or deletes unrelated index paths.
	 */
	private async renderIndexPatch(filepath: string, content: string): Promise<string> {
		const oldContent = await this.readGitObject(`:${filepath}`);
		// Quoted, so a tab or newline inside a filename cannot truncate the header's
		// tab-delimited pathspec and redirect the write to a different file.
		const quoted = SpawnGitAdapter.patchSidePath('a', filepath);
		const header = `diff --git ${quoted} ${SpawnGitAdapter.patchSidePath('b', filepath)}`;
		if (oldContent !== null) {
			// A literal no-op: the index already holds exactly this content, so the
			// write is skipped entirely. An empty→empty replace would render a
			// `+0,0` hunk that `git apply --cached` rejects as corrupt, and no
			// other shape can reach identical content.
			if (oldContent === content) return '';
			// Replace the full index content; the index mode is preserved without headers.
			// A side with no lines contributes no hunk body at all: `hunkBody('', '-')`
			// returns '', and joining that into the patch emits a bare blank line where
			// the hunk body should be. `git apply` counts the hunk's declared lines and
			// finds a line it cannot classify, so it rejects the whole patch as corrupt —
			// meaning the first line typed into a file committed empty (a placeholder
			// config.json, a `> file` redirect, a truncated file) could never be staged.
			// Verified against real git: the blank-line patch fails with
			// "corrupt patch at ...:N" and the index stays empty; dropping the empty side
			// applies cleanly and stages the content.
			const parts = [
				header,
				`--- ${quoted}`,
				`+++ ${SpawnGitAdapter.patchSidePath('b', filepath)}`,
				`@@ -${SpawnGitAdapter.hunkRange(SpawnGitAdapter.textLineCount(oldContent))} +${SpawnGitAdapter.hunkRange(SpawnGitAdapter.textLineCount(content))} @@`
			];
			const oldBody = SpawnGitAdapter.hunkBody(oldContent, '-');
			const newBody = SpawnGitAdapter.hunkBody(content, '+');
			if (oldBody !== '') parts.push(oldBody);
			if (newBody !== '') parts.push(newBody);
			return parts.join('\n');
		}

		// The destination has no index entry: stage it as a new file. A path absent
		// from the index has no mode to preserve, so this branch always emits the
		// default index mode. Empty content is emitted without a hunk, which is what
		// `git diff` produces for empty files.
		const parts = [header, `new file mode ${SpawnGitAdapter.DEFAULT_INDEX_MODE}`, '--- /dev/null', `+++ ${SpawnGitAdapter.patchSidePath('b', filepath)}`];
		const newCount = SpawnGitAdapter.textLineCount(content);
		if (newCount > 0) {
			parts.push(`@@ -0,0 +${SpawnGitAdapter.hunkRange(newCount)} @@`, SpawnGitAdapter.hunkBody(content, '+'));
		}
		return parts.join('\n');
	}

	async updateIndexContent(filepath: string, content: string): Promise<void> {
		await this.assertNotSymlink(filepath);
		const gitDirRes = await this.runGit(['rev-parse', '--git-dir']);
		const gitDir = gitDirRes.code === 0 && gitDirRes.stdout.trim() ? gitDirRes.stdout.trim() : '.git';
		const resolvedGitDir = gitDir.startsWith('/') ? gitDir : `${this.rootOrigin.path}/${gitDir}`;
		const tmpFilename = `tmp_hunk_stage_${crypto.randomUUID()}`;
		const tmpPath = `${resolvedGitDir}/${tmpFilename}`;
		const relTmpPath = `${gitDir}/${tmpFilename}`;
		try {
			// An empty patch means the index already holds exactly the requested
			// content; nothing to apply, and writing the patch file would be pointless.
			const patch = await this.renderIndexPatch(filepath, content);
			if (patch === '') return;
			// git apply rejects a patch file that does not end with a newline, so the
			// rendered patch always gets a trailing newline.
			await this.fileAccess.writeFile(tmpPath, `${patch}\n`);
			const applyRes = await this.runGit(['apply', '--cached', relTmpPath]);
			if (applyRes.code !== 0) {
				throw new Error(applyRes.stderr || 'Failed to update index');
			}
		} finally {
			try {
				await this.fileAccess.deleteEntry(tmpPath);
			} catch (err) {}
		}
	}
}
