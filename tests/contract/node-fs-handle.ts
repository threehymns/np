import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * A File System Access API shim backed by real Node `fs`, so `IsomorphicGitAdapter`
 * (which resolves its root through `browserHandleRegistry` and drives the
 * `BrowserGitFS` shim) can run against a real repository on disk in the contract suite.
 *
 * Only the surface the adapter and `BrowserGitFS` touch is implemented; everything
 * else (permissions, resolve, move) is granted or unsupported in the browser sense.
 */

function notFoundError(path: string): Error {
	return Object.assign(new Error(`NotFoundError: ${path}`), { name: 'NotFoundError', code: 'ENOENT' });
}

function typeMismatchError(path: string): Error {
	return Object.assign(new Error(`TypeMismatchError: ${path}`), { name: 'TypeMismatchError' });
}

export class NodeFileHandle {
	readonly kind = 'file' as const;

	constructor(readonly name: string, readonly path: string) {}

	async isSameEntry(other: unknown): Promise<boolean> {
		return other instanceof NodeFileHandle && other.path === this.path;
	}

	async queryPermission(): Promise<'granted'> {
		return 'granted';
	}

	async requestPermission(): Promise<'granted'> {
		return 'granted';
	}

	async getFile(): Promise<File> {
		const buffer = await readFile(this.path);
		const st = await stat(this.path);
		return new File([buffer], this.name, { lastModified: st.mtimeMs });
	}

	async createWritable(): Promise<{
		write(chunk: string | ArrayBuffer | ArrayBufferView): Promise<void>;
		close(): Promise<void>;
	}> {
		return {
			write: async (chunk: string | ArrayBuffer | ArrayBufferView) => {
				let content: string | Uint8Array;
				if (typeof chunk === 'string') {
					content = chunk;
				} else if (chunk instanceof ArrayBuffer) {
					content = new Uint8Array(chunk);
				} else {
					content = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
				}
				await writeFile(this.path, content);
			},
			close: async () => {}
		};
	}
}

export class NodeDirectoryHandle {
	readonly kind = 'directory' as const;

	constructor(readonly name: string, readonly path: string) {}

	async isSameEntry(other: unknown): Promise<boolean> {
		return other instanceof NodeDirectoryHandle && other.path === this.path;
	}

	async queryPermission(): Promise<'granted'> {
		return 'granted';
	}

	async requestPermission(): Promise<'granted'> {
		return 'granted';
	}

	private async entry(name: string): Promise<NodeFileHandle | NodeDirectoryHandle> {
		const target = join(this.path, name);
		try {
			const st = await stat(target);
			return st.isDirectory()
				? new NodeDirectoryHandle(name, target)
				: new NodeFileHandle(name, target);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				throw notFoundError(target);
			}
			throw error;
		}
	}

	async getFileHandle(name: string, options?: { create?: boolean }): Promise<NodeFileHandle> {
		const target = join(this.path, name);
		try {
			const entry = await this.entry(name);
			if (entry.kind === 'directory') throw typeMismatchError(target);
			return entry;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT' && options?.create) {
				await writeFile(target, '');
				return new NodeFileHandle(name, target);
			}
			throw error;
		}
	}

	async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<NodeDirectoryHandle> {
		const target = join(this.path, name);
		try {
			const entry = await this.entry(name);
			if (entry.kind === 'file') throw typeMismatchError(target);
			return entry;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT' && options?.create) {
				await mkdir(target, { recursive: true });
				return new NodeDirectoryHandle(name, target);
			}
			throw error;
		}
	}

	async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
		await rm(join(this.path, name), { recursive: options?.recursive ?? false, force: true });
	}

	async *keys(): AsyncIterableIterator<string> {
		for (const name of await readdir(this.path)) {
			yield name;
		}
	}

	async *values(): AsyncIterableIterator<NodeFileHandle | NodeDirectoryHandle> {
		for (const name of await readdir(this.path)) {
			yield await this.entry(name);
		}
	}

	async *entries(): AsyncIterableIterator<[string, NodeFileHandle | NodeDirectoryHandle]> {
		for (const name of await readdir(this.path)) {
			yield [name, await this.entry(name)];
		}
	}

	async resolve(): Promise<string[] | null> {
		return null;
	}
}

/** Move `srcPath` to `destPath` on disk; used to build worktree renames in fixtures. */
export async function moveEntry(srcPath: string, destPath: string): Promise<void> {
	await mkdir(dirname(destPath), { recursive: true });
	await rename(srcPath, destPath);
}
