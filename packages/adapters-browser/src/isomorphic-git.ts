import git from 'isomorphic-git';
import { Buffer } from 'buffer';
import type { VCSAdapter, VCSStatus, SwitchResult, FileOrigin, GitChange, GitCommit, FileDiffDetail } from '@np/core';
import { resolveDiffDetail, countLines } from '@np/core/project/vcs';
import { mapBounded } from '@np/core/utils';
import { toURI } from '@np/core/storage';
import { browserHandleRegistry } from './storage';
import { resolveRenamedHeadContent, isENOENT } from './rename-resolver';

const REPO_DIR = '/repo';
const HEAVY_WORKTREE_DIRS = new Set(['node_modules', '.svelte-kit']);

/** Parent of a shim path: '/a/b/c' → '/a/b', '' when there is none. */
function parentDirectory(p: string): string {
	const trimmed = p.replace(/\/+$/, '');
	const idx = trimmed.lastIndexOf('/');
	if (idx <= 0) return '';
	return trimmed.slice(0, idx);
}

class BrowserStats {
	ctime: Date;
	mtime: Date;
	ctimeMs: number;
	dev = 0;
	ino = 0;
	uid = 0;
	gid = 0;
	mode: number;

	constructor(
		private kind: FileSystemHandleKind,
		public size = 0,
		public mtimeMs = Date.now()
	) {
		this.ctimeMs = mtimeMs;
		this.ctime = new Date(mtimeMs);
		this.mtime = new Date(mtimeMs);
		this.mode = kind === 'directory' ? 0o040000 : 0o100644;
	}

	isFile() {
		return this.kind === 'file';
	}

	isDirectory() {
		return this.kind === 'directory';
	}

	isSymbolicLink() {
		return false;
	}
}

class BrowserGitFS {
	promises = {
		readFile: this.readFile.bind(this),
		writeFile: this.writeFile.bind(this),
		readdir: this.readdir.bind(this),
		stat: this.stat.bind(this),
		lstat: this.stat.bind(this),
		readlink: this.readlink.bind(this),
		symlink: this.symlink.bind(this),
		mkdir: this.mkdir.bind(this),
		rmdir: this.rmdir.bind(this),
		unlink: this.unlink.bind(this)
	};

	constructor(private rootHandle: FileSystemDirectoryHandle) {}

	private toParts(path: string): string[] {
		const normalized = path
			.replace(/\\/g, '/')
			.replace(/\/\.(?=\/|$)/g, '')
			.replace(/\/+$/, '') || REPO_DIR;
		if (normalized !== REPO_DIR && !normalized.startsWith(`${REPO_DIR}/`)) {
			throw Object.assign(new Error(`Path outside repository: ${path}`), { code: 'ENOENT' });
		}

		return normalized
			.slice(REPO_DIR.length)
			.split('/')
			.filter(Boolean);
	}

	private async getParentDirectory(path: string, create = false): Promise<{ parent: FileSystemDirectoryHandle; name: string }> {
		const parts = this.toParts(path);
		const name = parts.pop();
		if (!name) {
			throw Object.assign(new Error(`No parent for repository root: ${path}`), { code: 'EINVAL' });
		}

		let current = this.rootHandle;
		for (const part of parts) {
			current = await current.getDirectoryHandle(part, { create }).catch((error) => {
				throw this.convertError(error, path);
			});
		}

		return { parent: current, name };
	}

	private async getHandle(path: string): Promise<FileSystemHandle> {
		const parts = this.toParts(path);
		if (parts.length === 0) return this.rootHandle;

		let current: FileSystemDirectoryHandle = this.rootHandle;
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			const isLast = i === parts.length - 1;

			if (isLast) {
				try {
					return await current.getFileHandle(part);
				} catch (fileError: any) {
					if (fileError.name !== 'TypeMismatchError' && !isENOENT(fileError)) {
						throw this.convertError(fileError, path);
					}
				}
			}

			try {
				current = await current.getDirectoryHandle(part);
				if (isLast) return current;
			} catch (dirError: any) {
				throw this.convertError(dirError, path);
			}
		}

		return current;
	}

	private convertError(error: any, path: string): Error {
		const code = error?.name === 'TypeMismatchError'
			? 'ENOTDIR'
			: isENOENT(error)
				? 'ENOENT'
				: error?.name === 'NotAllowedError' || error?.name === 'NotReadableError' || error?.code === 'EACCES'
					? 'EACCES'
					: 'EIO';

		return Object.assign(new Error(`${code}: ${path}`), { code });
	}

	async readFile(path: string, options?: BufferEncoding | { encoding?: BufferEncoding | null }): Promise<Buffer | string> {
		const handle = await this.getHandle(path);
		if (handle.kind !== 'file') {
			throw Object.assign(new Error(`EISDIR: ${path}`), { code: 'EISDIR' });
		}

		const file = await (handle as FileSystemFileHandle).getFile();
		const encoding = typeof options === 'string' ? options : options?.encoding;
		if (encoding) return await file.text();
		return Buffer.from(await file.arrayBuffer());
	}

	async writeFile(path: string, data: Uint8Array | string): Promise<void> {
		const { parent, name } = await this.getParentDirectory(path, true);
		const handle = await parent.getFileHandle(name, { create: true }).catch((error) => {
			throw this.convertError(error, path);
		});
		const writable = await handle.createWritable();
		await writable.write(typeof data === 'string' ? data : new Uint8Array(data));
		await writable.close();
	}

	async readdir(path: string): Promise<string[]> {
		const handle = await this.getHandle(path);
		if (handle.kind !== 'directory') {
			throw Object.assign(new Error(`ENOTDIR: ${path}`), { code: 'ENOTDIR' });
		}

		const names: string[] = [];
		const isWorktreeRoot = path.replace(/\/+$/, '') === REPO_DIR;
		for await (const name of (handle as FileSystemDirectoryHandle).keys()) {
			if (isWorktreeRoot && HEAVY_WORKTREE_DIRS.has(name)) continue;
			names.push(name);
		}
		return names;
	}

	async stat(path: string): Promise<BrowserStats> {
		const handle = await this.getHandle(path);
		if (handle.kind === 'directory') return new BrowserStats('directory');

		const file = await (handle as FileSystemFileHandle).getFile();
		return new BrowserStats('file', file.size, file.lastModified);
	}

	async readlink(path: string): Promise<string> {
		throw Object.assign(new Error(`ENOSYS: symlinks are not supported: ${path}`), { code: 'ENOSYS' });
	}

	async symlink(_target: string, path: string): Promise<void> {
		throw Object.assign(new Error(`ENOSYS: symlinks are not supported: ${path}`), { code: 'ENOSYS' });
	}

	async mkdir(path: string): Promise<void> {
		const { parent, name } = await this.getParentDirectory(path, true);
		await parent.getDirectoryHandle(name, { create: true }).catch((error) => {
			throw this.convertError(error, path);
		});
	}

	async rmdir(path: string): Promise<void> {
		const { parent, name } = await this.getParentDirectory(path);
		await parent.removeEntry(name, { recursive: false }).catch((error) => {
			throw this.convertError(error, path);
		});
	}

	async unlink(path: string): Promise<void> {
		const { parent, name } = await this.getParentDirectory(path);
		await parent.removeEntry(name).catch((error) => {
			throw this.convertError(error, path);
		});
	}
}

interface FileSnapshot {
	filepath: string;
	head: number;
	workdir: number;
	stage: number;
	workdirContent: Uint8Array | null;
	stagedContent: Uint8Array | null;
}

export class IsomorphicGitAdapter implements VCSAdapter {
	private dir = REPO_DIR;
	private initialized = false;
	private initPromise: Promise<boolean> | null = null;
	private fs: BrowserGitFS | null = null;
	private rootHandle: FileSystemDirectoryHandle | null = null;

	constructor(private rootOrigin: FileOrigin) {}

	private async ensureInitialized(): Promise<boolean> {
		if (this.initialized) return true;
		if (this.initPromise) return this.initPromise;

		this.initPromise = (async () => {
			const detected = await this.detect(this.rootOrigin.path);
			this.initialized = detected;
			return detected;
		})().finally(() => {
			this.initPromise = null;
		});

		return this.initPromise;
	}

	async detect(rootPath: string): Promise<boolean> {
		try {
			// git resolves a work tree from any directory inside it, so probe the
			// path and each ancestor directory for a .git directory.
			let path = rootPath;
			for (;;) {
				const origin: FileOrigin = { scheme: this.rootOrigin.scheme, path, name: this.rootOrigin.name };
				const handle = await browserHandleRegistry.resolve(toURI(origin));
				if (!handle || handle.kind !== 'directory') {
					return false;
				}
				// Verify permission first.
				const permission = await handle.queryPermission({ mode: 'readwrite' });
				if (permission !== 'granted') {
					return false;
				}

				// Probe the filesystem shim for a .git directory.
				const fs = new BrowserGitFS(handle as FileSystemDirectoryHandle);
				let names: string[];
				try {
					names = await fs.readdir(REPO_DIR);
				} catch (probeError: any) {
					if (probeError?.code === 'ENOENT' || probeError?.code === 'ENOTDIR') {
						// No repo subdirectory here; an ancestor may hold it.
						const parent = parentDirectory(path);
						if (parent === path) return false;
						path = parent;
						continue;
					}
					throw probeError;
				}
				if (names.includes('.git')) {
					this.rootHandle = handle as FileSystemDirectoryHandle;
					this.fs = fs;
					return true;
				}

				const parent = parentDirectory(path);
				if (parent === path) return false;
				path = parent;
			}
		} catch (e: any) {
			if (e?.name === 'NotReadableError') {
				console.log('[Git] .git folder is blocked by browser security (needs user gesture)');
			} else {
				console.error('[Git] Unexpected detection error:', e);
			}
			return false;
		}
	}

	private async readStatusMatrix() {
		return await git.statusMatrix({
			fs: this.fs!,
			dir: this.dir,
			filter: f => !f.includes('node_modules') && !f.includes('.svelte-kit') && !f.includes('.git/')
		});
	}

	async getCurrentBranch(): Promise<string | null> {
		if (!await this.ensureInitialized()) return null;
		try {
			const branch = await git.currentBranch({ fs: this.fs!, dir: this.dir });
			return branch || null;
		} catch (e: any) {
			if (e.name === 'NotFoundError') {
				// Expected when the repository exists but has no commits yet
				return null;
			}
			console.error('[Git] Failed to get current branch', e);
			return null;
		}
	}

	async getBranches(): Promise<string[]> {
		if (!await this.ensureInitialized()) return [];
		try {
			const local = await git.listBranches({ fs: this.fs!, dir: this.dir });
			return [...new Set(local)].sort();
		} catch (e) {
			console.error('[Git] Failed to list branches', e);
			return [];
		}
	}

	async getStatus(): Promise<VCSStatus> {
		if (!this.initialized && !await this.ensureInitialized()) return { isDirty: false, uncommittedFiles: [] };
		try {
			const matrix = await this.readStatusMatrix();
			
			const uncommittedFiles = matrix
				.filter(([file, head, workdir, stage]) => {
					return head !== 1 || workdir !== 1 || stage !== 1;
				})
				.map(([file]) => file as string);

			return {
				isDirty: uncommittedFiles.length > 0,
				uncommittedFiles
			};
		} catch (e) {
			console.error('[Git] Status failed', e);
			return { isDirty: true, uncommittedFiles: ['Unable to read git status'] };
		}
	}

	async switchBranch(branchName: string, options?: { dryRun?: boolean }): Promise<SwitchResult> {
		if (!await this.ensureInitialized()) {
			return { status: 'error', message: 'Git not initialized' };
		}

		let currentBranch: string | null = null;
		let originalBranch: string | null = null;
		try {
			currentBranch = (await git.currentBranch({ fs: this.fs!, dir: this.dir })) || null;
			originalBranch = currentBranch;
			const [currentOid, targetOid] = await Promise.all([
				git.resolveRef({ fs: this.fs!, dir: this.dir, ref: 'HEAD' }),
				git.resolveRef({ fs: this.fs!, dir: this.dir, ref: branchName })
			]);
			
			if (currentBranch === branchName && currentOid === targetOid) {
				console.log(`[Git] Already on branch ${branchName} at ${targetOid}. Skipping checkout.`);
				return { status: 'noop' };
			}
		} catch (e) {
			// Proceed if optimization check fails
		}

		// Pre-flight safety check
		try {
			// Dry-run checkout to see if the target branch/ref is valid
			await git.checkout({
				fs: this.fs!,
				dir: this.dir,
				ref: branchName,
				dryRun: true
			});
		} catch (e: any) {
			if (e.code === 'CheckoutConflictError') {
				// Ignore CheckoutConflictError here; we will run our own more precise carry-forward conflict check.
			} else {
				return { status: 'error', message: e.message || `Failed to dry-run checkout branch ${branchName}` };
			}
		}

		// Now, run our own safety check to prevent overwriting uncommitted (staged/unstaged) files.
		const status = await this.getStatus();
		let headCommit: string | null = null;
		let targetCommit: string | null = null;
		try {
			headCommit = await git.resolveRef({ fs: this.fs!, dir: this.dir, ref: 'HEAD' });
		} catch (e) {
			// No HEAD yet
		}
		try {
			targetCommit = await git.resolveRef({ fs: this.fs!, dir: this.dir, ref: branchName });
		} catch (e) {
			return { status: 'error', message: `Failed to resolve target branch ${branchName}` };
		}

		if (status.uncommittedFiles.length > 0) {
			const conflictingFiles: string[] = [];
			for (const filepath of status.uncommittedFiles) {
				let headOid: string | null = null;
				let targetOid: string | null = null;

				if (headCommit) {
					try {
						const blob = await git.readBlob({
							fs: this.fs!,
							dir: this.dir,
							oid: headCommit,
							filepath
						});
						headOid = blob.oid;
					} catch (e) {}
				}

				if (targetCommit) {
					try {
						const blob = await git.readBlob({
							fs: this.fs!,
							dir: this.dir,
							oid: targetCommit,
							filepath
						});
						targetOid = blob.oid;
					} catch (e) {}
				}

				if (headOid !== targetOid) {
					conflictingFiles.push(filepath);
				}
			}

			if (conflictingFiles.length > 0) {
				return { status: 'blocked', reason: 'conflict', files: conflictingFiles };
			}
		}

		if (options?.dryRun) {
			return { status: 'switched' };
		}

		// 1. Take a snapshot of all dirty files
		const snapshots: FileSnapshot[] = [];
		const unreadableFiles: string[] = [];
		try {
			const matrix = await this.readStatusMatrix();

			const dirtyRows = matrix.filter(([file, head, workdir, stage]) => {
				return head !== 1 || workdir !== 1 || stage !== 1;
			});

			if (dirtyRows.length > 0) {
				const stagedOids: Record<string, string> = {};
				await git.walk({
					fs: this.fs!,
					dir: this.dir,
					trees: [git.STAGE()],
					map: async (filepath, [entry]) => {
						if (filepath === '.' || !entry) return;
						const type = await entry.type();
						if (type === 'blob') {
							stagedOids[filepath] = await entry.oid();
						}
					}
				});

				for (const [filepath, head, workdir, stage] of dirtyRows) {
					let workdirContent: Uint8Array | null = null;
					let stagedContent: Uint8Array | null = null;

					if (workdir !== 0) {
						// A snapshot with null content cannot restore the file after the
						// forced checkout below, so a failed read blocks the switch
						// instead of risking the user's changes. A vanished file (ENOENT)
						// returns null from readWorktreeBytes so the restore unlinks it.
						try {
							workdirContent = await this.readWorktreeBytes(filepath as string);
						} catch (e) {
							// Any non-ENOENT read failure is unreadable — the forced checkout
							// would clobber it, so it blocks the switch.
							unreadableFiles.push(filepath as string);
							continue;
						}
					}

					const stagedOid = stagedOids[filepath as string];
					if (stagedOid && stage !== 1) {
						try {
							const { blob } = await git.readBlob({
								fs: this.fs!,
								dir: this.dir,
								oid: stagedOid
							});
							stagedContent = blob;
						} catch (e) {
							unreadableFiles.push(filepath as string);
							continue;
						}
					}

					snapshots.push({
						filepath: filepath as string,
						head: head as number,
						workdir: workdir as number,
						stage: stage as number,
						workdirContent,
						stagedContent
					});
				}
			}
		} catch (e: any) {
			console.error('[Git] Snapshot failed, branch switch aborted', e);
			return { status: 'error', message: `Snapshot failed: ${e.message || e}` };
		}

		// A file recorded as absent — it vanished mid-snapshot (ENOENT) or was
		// already gone at the scan — may have been recreated by a concurrent
		// operation before the checkout begins. Re-read those files so a recreated
		// file is carried across the switch instead of being unlinked during
		// restoration. A file still absent (ENOENT) returns null and stays a deletion.
		for (const snap of snapshots) {
			if (snap.workdirContent !== null) continue;
			try {
				snap.workdirContent = await this.readWorktreeBytes(snap.filepath);
			} catch (e) {
				// Non-ENOENT read error: unreadable, so block rather than let the
				// checkout clobber it.
				unreadableFiles.push(snap.filepath);
			}
		}
		if (unreadableFiles.length > 0) {
			return { status: 'blocked', reason: 'unreadable', files: unreadableFiles };
		}

		// 2. Perform checkout (with force: true to overwrite changes that isomorphic-git would complain about.
		// Since we have snapshots of all local uncommitted changes, they are safe, and we will restore them right after!)
		try {
			await git.checkout({
				fs: this.fs!,
				dir: this.dir,
				ref: branchName,
				force: true
			});

			// 3. Restore snapshots on target branch
			await this.restoreSnapshots(snapshots, targetCommit);
			return { status: 'switched' };
		} catch (err: any) {
			console.error(`[Git] Checkout of ${branchName} failed, starting rollback...`, err);
			if (originalBranch) {
				try {
					await git.checkout({
						fs: this.fs!,
						dir: this.dir,
						ref: originalBranch,
						force: true
					});
					await this.restoreSnapshots(snapshots, headCommit);
				} catch (rollbackErr) {
					console.error('[Git] Critical: Rollback checkout failed!', rollbackErr);
				}
			}
			return { status: 'error', message: err.message || 'Unknown checkout error' };
		}
	}

	private async restoreSnapshots(snapshots: FileSnapshot[], checkoutCommit: string | null): Promise<void> {
		for (const snap of snapshots) {
			const { filepath, workdirContent, stagedContent, stage } = snap;
			const fullPath = `${this.dir}/${filepath}`;

			// A path recorded as absent may have been recreated after the
			// pre-checkout re-read — a concurrent operation landing during the
			// checkout itself. Confirm absence right before the destructive step:
			// only a file still absent, or one byte-identical to the checkout
			// commit's own version (i.e. written by the checkout, not by a
			// concurrent op), is unlinked. A recreation is kept instead.
			const isTrulyAbsent = async (): Promise<boolean> => {
				let bytes: Uint8Array | null;
				try {
					bytes = await this.readWorktreeBytes(filepath);
				} catch {
					// Unreadable: assume present and keep it — deleting a path we
					// cannot inspect risks losing data we cannot see.
					return false;
				}
				if (bytes === null) return true;
				if (!checkoutCommit) return false;
				try {
					const { blob } = await git.readBlob({
						fs: this.fs!,
						dir: this.dir,
						oid: checkoutCommit,
						filepath
					});
					return blob.length === bytes.length && blob.every((b, i) => b === bytes[i]);
				} catch {
					// Not in the checkout commit's tree: the checkout cannot have
					// written it, so it is a recreation and must be kept.
					return false;
				}
			};

			const writeFileSafe = async (content: Uint8Array) => {
				const parts = filepath.split('/');
				parts.pop();
				if (parts.length > 0) {
					await this.fs!.promises.mkdir(`${this.dir}/${parts.join('/')}`).catch(() => {});
				}
				await this.fs!.promises.writeFile(fullPath, content);
			};

			const unlinkSafe = async () => {
				await this.fs!.promises.unlink(fullPath).catch(() => {});
			};

			if (workdirContent && stagedContent) {
				await writeFileSafe(workdirContent);
				await unlinkSafe(); // clear cache
				await writeFileSafe(stagedContent);
				await git.add({ fs: this.fs!, dir: this.dir, filepath });
				await writeFileSafe(workdirContent);
			} else if (workdirContent) {
				await writeFileSafe(workdirContent);
				if (stage === 0) {
					try {
						await git.remove({ fs: this.fs!, dir: this.dir, filepath });
					} catch (e) {}
				}
			} else if (stagedContent) {
				await writeFileSafe(stagedContent);
				await git.add({ fs: this.fs!, dir: this.dir, filepath });
				await unlinkSafe();
			} else {
				if (await isTrulyAbsent()) {
					await unlinkSafe();
					if (stage === 0) {
						try {
							await git.remove({ fs: this.fs!, dir: this.dir, filepath });
						} catch (e) {}
					}
				}
			}
		}
	}

	async getChanges(): Promise<GitChange[]> {
		if (!await this.ensureInitialized()) return [];
		try {
			const matrix = await this.readStatusMatrix();

			const result: GitChange[] = [];

			for (const [filepath, head, workdir, stage] of matrix) {
				const hasStaged = (head === 0 && stage !== 0) || (head === 1 && stage !== 1);
				const hasUnstaged = workdir !== stage;

				if (!hasStaged && !hasUnstaged) continue;

				if (hasStaged) {
					const status = head === 0 ? 'A' : (stage === 0 ? 'D' : 'M');
					result.push({
						filepath: filepath as string,
						status,
						additions: 0,
						deletions: 0,
						diff: '',
						staged: true
					});
				}

				if (hasUnstaged) {
					const status = (head === 0 && stage === 0) ? 'U' : (stage === 0 ? 'A' : (workdir === 0 ? 'D' : 'M'));

					let additions = 0;
					let deletions = 0;
					if (status === 'U') {
						// statusMatrix carries no line counts; untracked files are cheap to count
						// directly. Exact counts for tracked files would require reading blobs,
						// which getChanges() deliberately avoids (see #30) — the tradeoff is that
						// tracked-file badges show no counts until their diff is loaded.
						try {
							const buffer = await this.fs!.promises.readFile(`${this.dir}/${filepath}`);
							const content = typeof buffer === 'string' ? buffer : new TextDecoder().decode(buffer);
							additions = countLines(content);
						} catch (e) {}
					}

					result.push({
						filepath: filepath as string,
						status,
						additions,
						deletions,
						diff: '',
						staged: false
					});
				}
			}

			return result;
		} catch (e) {
			console.error('[Git] getChanges failed', e);
			throw e;
		}
	}

	async getFileDiff(filepath: string, options?: { staged?: boolean }): Promise<FileDiffDetail> {
		if (!await this.ensureInitialized()) {
			return { originalContent: '', modifiedContent: '', stagedContent: '' };
		}

		// isomorphic-git's statusMatrix does not detect renames, so a rename is represented
		// as a delete + add pair; each side resolves its own blob correctly from HEAD/workdir.
		let headCommit: string | null = null;
		try {
			headCommit = await git.resolveRef({ fs: this.fs!, dir: this.dir, ref: 'HEAD' });
		} catch (e) {}
		let headFound = false;
		let headContent = '';
		if (headCommit) {
			try {
				const { blob } = await git.readBlob({
					fs: this.fs!,
					dir: this.dir,
					oid: headCommit,
					filepath
				});
				headContent = new TextDecoder().decode(blob);
				headFound = true;
			} catch (e) {}
		}

		let stagedOid: string | null = null;
		let stagedContent = '';
		try {
			await git.walk({
				fs: this.fs!,
				dir: this.dir,
				trees: [git.STAGE()],
				map: async (walkPath, entries) => {
					if (walkPath === filepath && entries && entries[0]) {
						const type = await entries[0].type();
						if (type === 'blob') {
							const oid = await entries[0].oid();
							if (oid) {
								stagedOid = oid;
								const { blob } = await git.readBlob({
									fs: this.fs!,
									dir: this.dir,
									oid
								});
								stagedContent = new TextDecoder().decode(blob);
							}
						}
					}
				}
			});
		} catch (e) {}

		let workdirContent = '';
		if (options?.staged !== true) {
			try {
				// EAFP: attempt reading worktree content; file may be deleted or missing
				const buffer = await this.fs!.promises.readFile(`${this.dir}/${filepath}`);
				workdirContent = typeof buffer === 'string' ? buffer : new TextDecoder().decode(buffer);
			} catch (e: any) {
				// Only genuinely absent files yield empty worktree content;
				// anything else (permissions, I/O failures) must reach the caller.
				if (!isENOENT(e)) throw e;
			}
		}

		// Rename resolution fallback: if filepath was not in HEAD, search HEAD tree
		if (headCommit && !headFound) {
			const renamedHeadContent = await resolveRenamedHeadContent({
				fs: this.fs!,
				dir: this.dir,
				headCommit,
				filepath,
				stagedOid,
				workdirContent
			});
			if (renamedHeadContent !== null) {
				headContent = renamedHeadContent;
				if (!stagedOid) {
					stagedContent = renamedHeadContent;
				}
			}
		}

		return resolveDiffDetail(headContent, stagedContent, workdirContent, options);
	}

	async updateFileContent(filepath: string, content: string): Promise<void> {
		if (!await this.ensureInitialized()) throw new Error('Git not initialized');
		await this.fs!.promises.writeFile(`${this.dir}/${filepath}`, content);
	}

	/** The oid and mode of a path in the index (STAGE tree), or null when it has no entry. */
	private async readStageEntry(filepath: string): Promise<{ oid: string; mode: number } | null> {
		let result: { oid: string; mode: number } | null = null;
		try {
			await git.walk({
				fs: this.fs!,
				dir: this.dir,
				trees: [git.STAGE()],
				map: async (walkPath, entries) => {
					if (walkPath === filepath && entries && entries[0]) {
						const type = await entries[0].type();
						if (type === 'blob') {
							const oid = await entries[0].oid();
							const mode = await entries[0].mode();
							if (oid) result = { oid, mode };
						}
					}
				}
			});
		} catch (e: any) {
			// Only an absent index (hollowed repo) yields ENOENT and means "no
			// entry"; anything else (corrupt index, permission failure) must reach
			// the caller instead of being silently treated as absent, which would
			// mis-stage with default mode. Mirrors the desktop adapter's
			// `readGitObject` carve-out.
			if (!isENOENT(e)) throw e;
		}
		return result;
	}

	private async readBlobText(oid: string): Promise<string | null> {
		try {
			const { blob } = await git.readBlob({ fs: this.fs!, dir: this.dir, oid });
			return new TextDecoder().decode(blob);
		} catch (e) {
			return null;
		}
	}

	async updateIndexContent(filepath: string, content: string): Promise<void> {
		if (!await this.ensureInitialized()) throw new Error('Git not initialized');

		// A literal no-op: the destination already holds exactly this content, so the
		// write is skipped entirely. Only an identical write reaches the empty→empty
		// shape, and writing a new blob + index rewrite would be pointless work.
		const destEntry = await this.readStageEntry(filepath);
		if (destEntry && (await this.readBlobText(destEntry.oid)) === content) {
			return;
		}

		const oid = await git.writeBlob({
			fs: this.fs!,
			dir: this.dir,
			blob: new TextEncoder().encode(content)
		});

		await git.updateIndex({
			fs: this.fs!,
			dir: this.dir,
			filepath,
			oid,
			add: true,
			mode: destEntry?.mode ?? 0o100644
		});
	}

	async getCommits(): Promise<GitCommit[]> {
		if (!await this.ensureInitialized()) return [];
		try {
			const commits = await git.log({
				fs: this.fs!,
				dir: this.dir,
				depth: 50
			});
			const result: GitCommit[] = [];
			// Walk every commit's tree with bounded concurrency: 50 commits read in
			// one unbounded Promise.all would fan out against the FS shim.
			const filesPerCommit = await mapBounded(commits, 8, (c) => this.commitFileNames(c));
			for (let i = 0; i < commits.length; i++) {
				const c = commits[i];
				result.push({
					hash: c.oid.substring(0, 7),
					author: `${c.commit.author.name} <${c.commit.author.email}>`,
					// Match `git log --format=%s` subject semantics: only the first line.
					message: c.commit.message.split('\n')[0],
					date: new Date(c.commit.author.timestamp * 1000).toISOString().split('T')[0],
					files: filesPerCommit[i]
				});
			}
			return result;
		} catch (e) {
			return [];
		}
	}

	/**
	 * File names changed by a commit, matching `git log --name-only --no-renames`:
	 * every path whose blob differs between the commit and its parent (both sides
	 * of a rename, since no rename detection is performed). Merge commits report
	 * no changed files, like `git log`, which emits no diff for merges.
	 */
	private async commitFileNames(commit: { oid: string; commit: { parent: string[] } }): Promise<string[]> {
		// Merge commits report no changed files, like `git log`, which emits no diff for merges.
		if (commit.commit.parent.length > 1) return [];
		const trees = commit.commit.parent.length === 1
			? [git.TREE({ ref: commit.oid }), git.TREE({ ref: commit.commit.parent[0] })]
			: [git.TREE({ ref: commit.oid })];
		const files: string[] = [];
		await git.walk({
			fs: this.fs!,
			dir: this.dir,
			trees,
			map: async (filepath, entries) => {
				if (filepath === '.') return;
				const [commitEntry, parentEntry] = entries;
				const commitType = commitEntry ? await commitEntry.type() : null;
				const parentType = parentEntry ? await parentEntry.type() : null;
				if (commitType === 'blob' || parentType === 'blob') {
					const commitBlobOid = commitType === 'blob' ? await commitEntry!.oid() : undefined;
					const parentBlobOid = parentType === 'blob' ? await parentEntry!.oid() : undefined;
					// A mode-only change (e.g. the executable bit) keeps the blob OID
					// but still changes the file, like `git log --name-only` reports.
					const commitMode = commitEntry ? await commitEntry.mode() : undefined;
					const parentMode = parentEntry ? await parentEntry.mode() : undefined;
					if (commitBlobOid !== parentBlobOid || commitMode !== parentMode) {
						files.push(filepath);
					}
				}
			}
		});
		return files;
	}

	/**
	 * Remove a path from the index only, never touching the worktree. `force` is
	 * safe because the shim's lstat would otherwise throw for a missing file.
	 */
	private async removeFromIndex(filepath: string): Promise<void> {
		await git.updateIndex({ fs: this.fs!, dir: this.dir, filepath, remove: true, force: true });
	}

	async stageFile(filepath: string): Promise<void> {
		if (!await this.ensureInitialized()) throw new Error('Git not initialized');
		const matrix = await git.statusMatrix({
			fs: this.fs!,
			dir: this.dir,
			filepaths: [filepath]
		});
		if (matrix.length > 0) {
			const [,, workdir] = matrix[0];
			if (workdir === 0) {
				// Staging a deletion must not touch the worktree: the file may already
				// be gone, which `git.remove` would fail on.
				await this.removeFromIndex(filepath);
				return;
			}
		}
		await git.add({ fs: this.fs!, dir: this.dir, filepath });
	}

	async unstageFile(filepath: string): Promise<void> {
		if (!await this.ensureInitialized()) throw new Error('Git not initialized');
		try {
			// statusMatrix has no rename notion: a staged rename is a staged addition
			// plus a staged deletion. Unstaging the destination alone would leave the
			// source staged-deleted, so pair the two via content match, like `git reset
			// HEAD -- <source> <dest>` does on the desktop engine.
			const matrix = await this.readStatusMatrix();
			const paths: string[] = [filepath];
			const dest = matrix.find(([p]) => p === filepath);
			if (dest && dest[1] === 0 && dest[3] === 2) {
				const renameSource = await this.findRenameSource(matrix, filepath);
				if (renameSource) paths.push(renameSource);
			}
			for (const path of paths) {
				await git.resetIndex({
					fs: this.fs!,
					dir: this.dir,
					filepath: path
				});
			}
		} catch (e) {
			console.error('[Git] Failed to unstage file', e);
			throw e;
		}
	}

	/**
	 * The source path of a staged rename for `filepath` (the destination): another
	 * path present in HEAD but removed from both the index and the worktree whose
	 * HEAD content equals the destination's staged content. Null when the
	 * destination is not a rename — the statusMatrix analogue of the desktop
	 * engine's porcelain rename probe.
	 */
	private async findRenameSource(matrix: [string, number, number, number][], filepath: string): Promise<string | null> {
		const staged = await this.readStageEntry(filepath);
		if (!staged) return null;
		const stagedText = await this.readBlobText(staged.oid);
		if (stagedText === null) return null;
		let headCommit: string | null = null;
		try {
			headCommit = await git.resolveRef({ fs: this.fs!, dir: this.dir, ref: 'HEAD' });
		} catch (e) {}
		if (!headCommit) return null;
		for (const [candidate, head, workdir, stage] of matrix) {
			if (candidate !== filepath && head === 1 && workdir === 0 && stage === 0) {
				try {
					const { blob } = await git.readBlob({ fs: this.fs!, dir: this.dir, oid: headCommit, filepath: candidate });
					if (new TextDecoder().decode(blob) === stagedText) {
						return candidate;
					}
				} catch (e) {}
			}
		}
		return null;
	}

	/** The worktree bytes of a path, or null when the file is absent; other read failures surface. */
	private async readWorktreeBytes(filepath: string): Promise<Uint8Array | null> {
		try {
			const buffer = await this.fs!.promises.readFile(`${this.dir}/${filepath}`);
			return typeof buffer === 'string' ? new TextEncoder().encode(buffer) : new Uint8Array(buffer);
		} catch (e: any) {
			if (!isENOENT(e)) throw e;
			return null;
		}
	}

	/** The worktree text of a path, or null when the file is absent. */
	private async readWorktreeText(filepath: string): Promise<string | null> {
		const bytes = await this.readWorktreeBytes(filepath);
		return bytes === null ? null : new TextDecoder().decode(bytes);
	}

	/** Remove a worktree file; an already-absent file is a no-op, other failures surface. */
	private async unlinkIfPresent(filepath: string): Promise<void> {
		try {
			await this.fs!.promises.unlink(`${this.dir}/${filepath}`);
		} catch (e: any) {
			if (!isENOENT(e)) throw e;
		}
	}

	/**
	 * Whether `content` matches the HEAD content of another path still tracked in
	 * the index — the statusMatrix analogue of the desktop engine's porcelain copy
	 * entries, used to keep a staged copy's worktree edits instead of cleaning them.
	 */
	private async matchesHeadContentOfTrackedPath(matrix: [string, number, number, number][], filepath: string, content: string): Promise<boolean> {
		let headCommit: string | null = null;
		try {
			headCommit = await git.resolveRef({ fs: this.fs!, dir: this.dir, ref: 'HEAD' });
		} catch (e) {}
		if (!headCommit) return false;
		for (const [candidate, head, , stage] of matrix) {
			if (candidate !== filepath && head === 1 && stage === 2) {
				try {
					const { blob } = await git.readBlob({ fs: this.fs!, dir: this.dir, oid: headCommit, filepath: candidate });
					if (new TextDecoder().decode(blob) === content) {
						return true;
					}
				} catch (e) {}
			}
		}
		return false;
	}

	async discardChanges(filepath: string, options?: { staged?: boolean }): Promise<void> {
		if (!await this.ensureInitialized()) throw new Error('Git not initialized');
		const matrix = await this.readStatusMatrix();
		const entry = matrix.find(([p]) => p === filepath);
		if (!entry) return;

		if (options?.staged === false) {
			// Unstaged scope: reset only the worktree copy from the index version; the
			// index is never touched. A path absent from the index (untracked file or
			// worktree-only rename) has no staged copy to restore from, so its worktree
			// file is cleaned instead.
			const staged = await this.readStageEntry(filepath);
			if (staged) {
				const text = await this.readBlobText(staged.oid);
				if (text !== null) {
					await this.fs!.promises.writeFile(`${this.dir}/${filepath}`, text);
				}
			} else {
				await this.unlinkIfPresent(filepath);
			}
			return;
		}

		// A staged rename pairs the destination (staged addition) with a path removed
		// from the index and worktree whose HEAD content matches the staged content —
		// the same pairing `git reset HEAD -- <source> <dest>` reverts on the desktop
		// engine. The rename is reverted whole: the original path is restored from
		// HEAD, the destination is removed from the index, and unstaged edits at the
		// destination survive as an untracked file.
		const renameSource = await this.findRenameSource(matrix, filepath);
		if (renameSource) {
			const staged = await this.readStageEntry(filepath);
			const stagedText = staged ? await this.readBlobText(staged.oid) : null;
			const worktreeText = await this.readWorktreeText(filepath);
			const hasEdits = stagedText !== null && worktreeText !== null && worktreeText !== stagedText;
			await git.checkout({
				fs: this.fs!,
				dir: this.dir,
				ref: 'HEAD',
				filepaths: [renameSource],
				force: true
			});
			await this.removeFromIndex(filepath);
			if (!hasEdits) {
				await this.unlinkIfPresent(filepath);
			}
			return;
		}

		const [, head] = entry;
		if (head === 1) {
			// Tracked path: restore index and worktree from HEAD. `git.checkout`
			// silently removes worktree files absent from the ref, so it may only
			// be used for paths that exist in HEAD.
			await git.checkout({
				fs: this.fs!,
				dir: this.dir,
				ref: 'HEAD',
				filepaths: [filepath],
				force: true
			});
			return;
		}

		// Absent from HEAD: an untracked file or a staged addition. Remove the
		// index entry and clean the worktree copy. A staged addition whose
		// worktree copy holds edits matching another path's HEAD content (a
		// staged copy) keeps those edits as an untracked file, mirroring the
		// desktop engine's CM handling — the user's edits are never the engine's
		// to delete.
		const staged = await this.readStageEntry(filepath);
		let keepWorktree = false;
		if (staged) {
			const stagedText = await this.readBlobText(staged.oid);
			const worktreeText = await this.readWorktreeText(filepath);
			keepWorktree = stagedText !== null && worktreeText !== null && worktreeText !== stagedText
				&& await this.matchesHeadContentOfTrackedPath(matrix, filepath, stagedText);
			await this.removeFromIndex(filepath);
		}
		if (!keepWorktree) {
			await this.unlinkIfPresent(filepath);
		}
	}

	async stageAll(): Promise<void> {
		if (!await this.ensureInitialized()) throw new Error('Git not initialized');
		const matrix = await this.readStatusMatrix();
		for (const [filepath, head, workdir, stage] of matrix) {
			const isClean = head === 1 && workdir === 1 && stage === 1;
			if (isClean) continue;
			if (workdir === 0) {
				if (stage !== 0 || head !== 0) {
					// Index-only removal: `git.remove` would also unlink the worktree
					// file, which fails when it is already gone.
					await this.removeFromIndex(filepath as string);
				}
			} else {
				await git.add({ fs: this.fs!, dir: this.dir, filepath: filepath as string });
			}
		}
	}

	async unstageAll(): Promise<void> {
		if (!await this.ensureInitialized()) throw new Error('Git not initialized');
		const matrix = await this.readStatusMatrix();
		for (const [filepath, head, , stage] of matrix) {
			const hasStaged = (head === 0 && stage !== 0) || (head === 1 && stage !== 1);
			if (!hasStaged) continue;
			await git.resetIndex({ fs: this.fs!, dir: this.dir, filepath: filepath as string });
		}
	}

	async discardAll(): Promise<void> {
		if (!await this.ensureInitialized()) throw new Error('Git not initialized');
		const matrix = await this.readStatusMatrix();
		const trackedToRestore: string[] = [];
		for (const [filepath, head, workdir, stage] of matrix) {
			const isClean = head === 1 && workdir === 1 && stage === 1;
			if (isClean) continue;
			if (head === 0) {
				// Absent from HEAD: remove the worktree copy and the index entry. The
				// unlink tolerates an already-gone file and `removeFromIndex` never
				// touches the worktree, but any real failure surfaces instead of being
				// swallowed: a silent discardAll must not report success on failure.
				await this.unlinkIfPresent(filepath as string);
				await this.removeFromIndex(filepath as string);
			} else {
				trackedToRestore.push(filepath as string);
			}
		}
		if (trackedToRestore.length > 0) {
			await git.checkout({
				fs: this.fs!,
				dir: this.dir,
				ref: 'HEAD',
				filepaths: trackedToRestore,
				force: true
			});
		}
	}

	async getUserConfig(): Promise<{ name: string; email: string } | null> {
		if (!await this.ensureInitialized()) return null;
		try {
			const name = await git.getConfig({ fs: this.fs!, dir: this.dir, path: 'user.name' });
			const email = await git.getConfig({ fs: this.fs!, dir: this.dir, path: 'user.email' });
			if (name && email) return { name: String(name).trim(), email: String(email).trim() };
		} catch (e) {}
		return null;
	}

	async commit(message: string, options?: { author?: { name: string; email: string }; amend?: boolean }): Promise<void> {
		if (!await this.ensureInitialized()) throw new Error('Git not initialized');
		let author = options?.author;
		if (!author) {
			const config = await this.getUserConfig();
			if (config) {
				author = config;
			} else {
				throw new Error('Git author identity (user.name and user.email) is not configured');
			}
		}
		await git.commit({
			fs: this.fs!,
			dir: this.dir,
			message,
			author,
			amend: options?.amend
		});
	}

	async createBranch(branchName: string): Promise<void> {
		if (!await this.ensureInitialized()) throw new Error('Git not initialized');
		await git.branch({
			fs: this.fs!,
			dir: this.dir,
			ref: branchName
		});
		const res = await this.switchBranch(branchName);
		if (res.status === 'error') {
			throw new Error(res.message || `Failed to switch to created branch ${branchName}`);
		} else if (res.status === 'blocked') {
			throw new Error(`Failed to switch to created branch ${branchName}: ${res.reason}`);
		}
	}

	reset() {
		console.log('[Git] Resetting adapter state...');
		this.initialized = false;
		this.initPromise = null;
		this.fs = null;
		this.rootHandle = null;
	}
}
