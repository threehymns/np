import git from 'isomorphic-git';
import { Buffer } from 'buffer';
import type { VCSAdapter, VCSStatus, SwitchResult, FileOrigin, GitChange, GitCommit, FileDiffDetail } from '@np/core';
import { resolveDiffDetail, countLines } from '@np/core/project/vcs';
import { toURI } from '@np/core/storage';
import { browserHandleRegistry } from './storage';
import { resolveRenamedHeadContent } from './rename-resolver';

const REPO_DIR = '/repo';
const HEAVY_WORKTREE_DIRS = new Set(['node_modules', '.svelte-kit']);

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
					if (fileError.name !== 'TypeMismatchError' && fileError.name !== 'NotFoundError') {
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
			: error?.name === 'NotFoundError'
				? 'ENOENT'
				: error?.name === 'NotAllowedError' || error?.name === 'NotReadableError'
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
			try {
				const uri = toURI(this.rootOrigin);
				const handle = await browserHandleRegistry.resolve(uri);
				if (!handle || handle.kind !== 'directory') {
					return false;
				}
				this.rootHandle = handle as FileSystemDirectoryHandle;

				// Verify permission first.
				const permission = await this.rootHandle.queryPermission({ mode: 'readwrite' });
				if (permission !== 'granted') {
					return false;
				}

				// Check if it's a git repo
				try {
					await this.rootHandle.getDirectoryHandle('.git');
				} catch (e: any) {
					if (e.name === 'NotReadableError') {
						console.log('[Git] .git folder is blocked by browser security (needs user gesture)');
						return false;
					}
					return false;
				}
				
				this.fs = new BrowserGitFS(this.rootHandle);
				this.initialized = true;
				console.log('[Git] Initialization successful');
				return true;
			} catch (e: any) {
				console.error('[Git] Unexpected initialization error:', e);
				return false;
			} finally {
				this.initPromise = null;
			}
		})();

		return this.initPromise;
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
			const matrix = await git.statusMatrix({ 
				fs: this.fs!,
				dir: this.dir,
				filter: f => !f.includes('node_modules') && !f.includes('.svelte-kit') && !f.includes('.git/')
			});
			
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
		try {
			const matrix = await git.statusMatrix({ 
				fs: this.fs!,
				dir: this.dir,
				filter: f => !f.includes('node_modules') && !f.includes('.svelte-kit') && !f.includes('.git/')
			});

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
						try {
							const buffer = await this.fs!.promises.readFile(`${this.dir}/${filepath}`);
							workdirContent = typeof buffer === 'string' ? new TextEncoder().encode(buffer) : new Uint8Array(buffer);
						} catch (e) {
							console.warn(`[Git] Failed to read workdir content for snapshot: ${filepath}`, e);
						}
					}

					const stagedOid = stagedOids[filepath as string];
					if (stagedOid) {
						try {
							const { blob } = await git.readBlob({
								fs: this.fs!,
								dir: this.dir,
								oid: stagedOid
							});
							stagedContent = blob;
						} catch (e) {
							console.warn(`[Git] Failed to read staged blob for snapshot: ${filepath}`, e);
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
			return { status: 'error', message: `Snapshot failed: ${e.message || e}` };
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
			await this.restoreSnapshots(snapshots);
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
					await this.restoreSnapshots(snapshots);
				} catch (rollbackErr) {
					console.error('[Git] Critical: Rollback checkout failed!', rollbackErr);
				}
			}
			return { status: 'error', message: err.message || 'Unknown checkout error' };
		}
	}

	private async restoreSnapshots(snapshots: FileSnapshot[]): Promise<void> {
		for (const snap of snapshots) {
			const { filepath, workdirContent, stagedContent, stage } = snap;
			const fullPath = `${this.dir}/${filepath}`;

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
				await unlinkSafe();
				if (stage === 0) {
					try {
						await git.remove({ fs: this.fs!, dir: this.dir, filepath });
					} catch (e) {}
				}
			}
		}
	}

	async getChanges(): Promise<GitChange[]> {
		if (!await this.ensureInitialized()) return [];
		try {
			const matrix = await git.statusMatrix({ 
				fs: this.fs!,
				dir: this.dir,
				filter: f => !f.includes('node_modules') && !f.includes('.svelte-kit') && !f.includes('.git/')
			});

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
			} catch (e) {}
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

	async updateIndexContent(filepath: string, content: string): Promise<void> {
		if (!await this.ensureInitialized()) throw new Error('Git not initialized');
		try {
			const oid = await git.writeBlob({
				fs: this.fs!,
				dir: this.dir,
				blob: new TextEncoder().encode(content)
			});
			await git.updateIndex({
				fs: this.fs!,
				dir: this.dir,
				filepath,
				oid
			});
		} catch (e) {
			let originalWorktree: string | null = null;
			try {
				const buf = await this.fs!.promises.readFile(`${this.dir}/${filepath}`);
				originalWorktree = typeof buf === 'string' ? buf : new TextDecoder().decode(buf);
			} catch (err) {}

			await this.updateFileContent(filepath, content);
			await this.stageFile(filepath);

			if (originalWorktree !== null && originalWorktree !== content) {
				await this.updateFileContent(filepath, originalWorktree);
			}
		}
	}

	async getCommits(): Promise<GitCommit[]> {
		if (!await this.ensureInitialized()) return [];
		try {
			const commits = await git.log({
				fs: this.fs!,
				dir: this.dir,
				depth: 50
			});
			return commits.map(c => {
				const author = `${c.commit.author.name} <${c.commit.author.email}>`;
				const date = new Date(c.commit.author.timestamp * 1000).toISOString().split('T')[0];
				return {
					hash: c.oid.substring(0, 7),
					author,
					message: c.commit.message,
					date,
					files: []
				};
			});
		} catch (e) {
			return [];
		}
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
				await git.remove({ fs: this.fs!, dir: this.dir, filepath });
				return;
			}
		}
		await git.add({ fs: this.fs!, dir: this.dir, filepath });
	}

	async unstageFile(filepath: string): Promise<void> {
		if (!await this.ensureInitialized()) throw new Error('Git not initialized');
		try {
			await git.resetIndex({
				fs: this.fs!,
				dir: this.dir,
				filepath
			});
		} catch (e) {
			console.error('[Git] Failed to unstage file', e);
			throw e;
		}
	}

	async discardChanges(filepath: string): Promise<void> {
		if (!await this.ensureInitialized()) throw new Error('Git not initialized');
		try {
			await git.checkout({
				fs: this.fs!,
				dir: this.dir,
				ref: 'HEAD',
				filepaths: [filepath],
				force: true
			});
		} catch (e) {
			try {
				await this.fs!.promises.unlink(`${this.dir}/${filepath}`);
				await git.remove({ fs: this.fs!, dir: this.dir, filepath }).catch(() => {});
			} catch (unlinkErr) {
				console.error('[Git] Failed to unlink file on discard', unlinkErr);
				throw unlinkErr;
			}
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

function computeDiff(oldStr: string, newStr: string): { diffText: string; additions: number; deletions: number } {
	if (oldStr === newStr) {
		return { diffText: '', additions: 0, deletions: 0 };
	}

	const oldLines = oldStr ? oldStr.split(/\r?\n/) : [];
	const newLines = newStr ? newStr.split(/\r?\n/) : [];

	if (oldLines.length === 0) {
		const additions = newLines.length;
		const hunkBody = newLines.map(l => '+' + l).join('\n');
		const diffText = `@@ -0,0 +1,${additions} @@\n` + hunkBody;
		return { diffText, additions, deletions: 0 };
	}

	if (newLines.length === 0) {
		const deletions = oldLines.length;
		const hunkBody = oldLines.map(l => '-' + l).join('\n');
		const diffText = `@@ -1,${deletions} +0,0 @@\n` + hunkBody;
		return { diffText, additions: 0, deletions };
	}

	// Trim common prefix and suffix lines
	let prefix = 0;
	while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
		prefix++;
	}

	let suffix = 0;
	while (
		suffix < oldLines.length - prefix &&
		suffix < newLines.length - prefix &&
		oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
	) {
		suffix++;
	}

	const subOld = oldLines.slice(prefix, oldLines.length - suffix);
	const subNew = newLines.slice(prefix, newLines.length - suffix);

	const oldLen = subOld.length;
	const newLen = subNew.length;

	if (oldLen * newLen > 4_000_000) {
		return {
			diffText: `@@ -1,${oldLines.length} +1,${newLines.length} @@\n` +
				oldLines.map(l => '-' + l).join('\n') + (oldLines.length > 0 ? '\n' : '') +
				newLines.map(l => '+' + l).join('\n') + (newLines.length > 0 ? '\n' : ''),
			additions: newLines.length,
			deletions: oldLines.length
		};
	}

	let prevRow = new Int32Array(newLen + 1);
	let currRow = new Int32Array(newLen + 1);
	const trace: Uint8Array[] = [];

	for (let i = 1; i <= oldLen; i++) {
		const rowTrace = new Uint8Array(newLen + 1);
		for (let j = 1; j <= newLen; j++) {
			if (subOld[i - 1] === subNew[j - 1]) {
				currRow[j] = prevRow[j - 1] + 1;
				rowTrace[j] = 1;
			} else if (currRow[j - 1] >= prevRow[j]) {
				currRow[j] = currRow[j - 1];
				rowTrace[j] = 2;
			} else {
				currRow[j] = prevRow[j];
				rowTrace[j] = 3;
			}
		}
		trace.push(rowTrace);
		prevRow.set(currRow);
		currRow.fill(0);
	}

	let i = oldLen, j = newLen;
	const subOps: { type: 'keep' | 'add' | 'delete'; line: string; oldLineNum: number; newLineNum: number }[] = [];
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && subOld[i - 1] === subNew[j - 1]) {
			subOps.push({ type: 'keep', line: subOld[i - 1], oldLineNum: prefix + i, newLineNum: prefix + j });
			i--;
			j--;
		} else if (j > 0 && (i === 0 || trace[i - 1][j] === 2)) {
			subOps.push({ type: 'add', line: subNew[j - 1], oldLineNum: -1, newLineNum: prefix + j });
			j--;
		} else {
			subOps.push({ type: 'delete', line: subOld[i - 1], oldLineNum: prefix + i, newLineNum: -1 });
			i--;
		}
	}
	subOps.reverse();

	const ops: { type: 'keep' | 'add' | 'delete'; line: string; oldLineNum: number; newLineNum: number }[] = [];
	const contextBefore = Math.min(3, prefix);
	for (let p = prefix - contextBefore; p < prefix; p++) {
		ops.push({ type: 'keep', line: oldLines[p], oldLineNum: p + 1, newLineNum: p + 1 });
	}
	ops.push(...subOps);
	const contextAfter = Math.min(3, suffix);
	for (let s = 0; s < contextAfter; s++) {
		const idxOld = oldLines.length - suffix + s;
		const idxNew = newLines.length - suffix + s;
		ops.push({ type: 'keep', line: oldLines[idxOld], oldLineNum: idxOld + 1, newLineNum: idxNew + 1 });
	}

	let diffText = '';
	let additions = 0;
	let deletions = 0;

	let k = 0;
	let prevHunkEnd = 0;
	while (k < ops.length) {
		if (ops[k].type === 'keep') {
			k++;
			continue;
		}

		const hunkStart = Math.max(prevHunkEnd, k - 3);
		let hunkEnd = k;
		let lastChangeIdx = k;

		while (hunkEnd < ops.length) {
			if (ops[hunkEnd].type !== 'keep') {
				lastChangeIdx = hunkEnd;
			}
			if (hunkEnd - lastChangeIdx > 3) {
				break;
			}
			hunkEnd++;
		}
		hunkEnd = Math.min(ops.length, lastChangeIdx + 4);

		const hunkOps = ops.slice(hunkStart, hunkEnd);
		let oldStart = 0, newStart = 0;
		let oldCount = 0, newCount = 0;

		for (const op of hunkOps) {
			if (op.oldLineNum !== -1 && oldStart === 0) oldStart = op.oldLineNum;
			if (op.newLineNum !== -1 && newStart === 0) newStart = op.newLineNum;
			if (op.oldLineNum !== -1) oldCount++;
			if (op.newLineNum !== -1) newCount++;
		}

		let hunkBody = '';
		for (const op of hunkOps) {
			if (op.type === 'keep') {
				hunkBody += ' ' + op.line + '\n';
			} else if (op.type === 'add') {
				hunkBody += '+' + op.line + '\n';
				additions++;
			} else if (op.type === 'delete') {
				hunkBody += '-' + op.line + '\n';
				deletions++;
			}
		}

		diffText += `@@ -${oldStart || 1},${oldCount} +${newStart || 1},${newCount} @@\n` + hunkBody;
		k = hunkEnd;
		prevHunkEnd = hunkEnd;
	}

	const trimmedDiff = diffText.endsWith('\n') ? diffText.slice(0, -1) : diffText;
	return { diffText: trimmedDiff, additions, deletions };
}
