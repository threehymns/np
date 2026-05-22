import git from 'isomorphic-git';
import { Buffer } from 'buffer';
import type { VCSAdapter, VCSStatus } from './vcs';

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

	async switchBranch(branchName: string): Promise<boolean> {
		if (!await this.ensureInitialized()) throw new Error('Git not initialized');

		try {
			const [currentBranch, currentOid, targetOid] = await Promise.all([
				git.currentBranch({ fs: this.fs!, dir: this.dir }),
				git.resolveRef({ fs: this.fs!, dir: this.dir, ref: 'HEAD' }),
				git.resolveRef({ fs: this.fs!, dir: this.dir, ref: branchName })
			]);
			
			if (currentBranch === branchName && currentOid === targetOid) {
				console.log(`[Git] Already on branch ${branchName} at ${targetOid}. Skipping checkout.`);
				return false;
			}
		} catch (e) {
			// Proceed if optimization check fails
		}

		await git.checkout({
			fs: this.fs!,
			dir: this.dir,
			ref: branchName
		});
		return true;
	}

	async canCheckoutBranch(branchName: string): Promise<boolean> {
		if (!await this.ensureInitialized()) return false;
		try {
			// First, run dryRun checkout. If isomorphic-git itself detects a conflict or error, block.
			await git.checkout({
				fs: this.fs!,
				dir: this.dir,
				ref: branchName,
				dryRun: true
			});

			// Now, run our own safety check to prevent overwriting uncommitted (staged/unstaged) files.
			// 1. Get status to see all uncommitted files.
			const status = await this.getStatus();
			if (status.uncommittedFiles.length === 0) {
				return true;
			}

			// 2. Resolve current HEAD and target branch commits
			let headCommit: string | null = null;
			let targetCommit: string | null = null;
			try {
				headCommit = await git.resolveRef({ fs: this.fs!, dir: this.dir, ref: 'HEAD' });
			} catch (e) {
				// No HEAD yet (e.g. empty repo), so no commits/conflicts.
				return true;
			}
			try {
				targetCommit = await git.resolveRef({ fs: this.fs!, dir: this.dir, ref: branchName });
			} catch (e) {
				console.warn('[Git] Failed to resolve target branch', branchName, e);
				return false;
			}

			// 3. For each uncommitted file, compare its OID in HEAD vs the target commit.
			for (const filepath of status.uncommittedFiles) {
				let headOid: string | null = null;
				let targetOid: string | null = null;

				try {
					const blob = await git.readBlob({
						fs: this.fs!,
						dir: this.dir,
						oid: headCommit,
						filepath
					});
					headOid = blob.oid;
				} catch (e) {
					// File does not exist in HEAD
				}

				try {
					const blob = await git.readBlob({
						fs: this.fs!,
						dir: this.dir,
						oid: targetCommit,
						filepath
					});
					targetOid = blob.oid;
				} catch (e) {
					// File does not exist in target branch
				}

				if (headOid !== targetOid) {
					console.warn(`[Git] Conflict detected for file ${filepath}: HEAD OID ${headOid} vs Target OID ${targetOid}`);
					return false;
				}
			}

			return true;
		} catch (e) {
			console.warn('[Git] Checkout dry-run failed', e);
			return false;
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

