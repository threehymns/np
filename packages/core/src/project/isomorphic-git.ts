import git from 'isomorphic-git';
import { Buffer } from 'buffer';
import type { VCSAdapter, VCSStatus, SwitchResult } from './vcs';

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

	constructor(private rootHandle: FileSystemDirectoryHandle) {}

	private async ensureInitialized(): Promise<boolean> {
		if (this.initialized) return true;
		if (this.initPromise) return this.initPromise;

		this.initPromise = (async () => {
			try {
				if (!this.rootHandle) return false;

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
				await this.fs!.promises.writeFile(fullPath, content);
			};

			const unlinkSafe = async () => {
				try {
					await this.fs!.promises.unlink(fullPath);
				} catch (e) {}
			};

			if (workdirContent !== null && stagedContent !== null) {
				const bufferEqual = (a: Uint8Array, b: Uint8Array) => {
					if (a.length !== b.length) return false;
					for (let i = 0; i < a.length; i++) {
						if (a[i] !== b[i]) return false;
					}
					return true;
				};

				if (bufferEqual(workdirContent, stagedContent)) {
					await writeFileSafe(stagedContent);
					await git.add({ fs: this.fs!, dir: this.dir, filepath });
				} else {
					await writeFileSafe(stagedContent);
					await git.add({ fs: this.fs!, dir: this.dir, filepath });
					await writeFileSafe(workdirContent);
				}
			} else if (workdirContent !== null && stagedContent === null) {
				await writeFileSafe(workdirContent);
			} else if (workdirContent === null && stagedContent !== null) {
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

	reset() {
		console.log('[Git] Resetting adapter state...');
		this.initialized = false;
		this.initPromise = null;
		this.fs = null;
	}
}

if (typeof window !== 'undefined') {
	(window as any).git = git;
}

