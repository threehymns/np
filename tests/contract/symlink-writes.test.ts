/**
 * A symlink must never be treated as an editable text file.
 *
 * Git stores a symlink as a blob whose content is the *target path*, with mode
 * 120000. Both write paths assume every path is a regular text file:
 *
 *   - `updateFileContent` is a bare write, which follows the link and overwrites
 *     the target file — a different, tracked file. Editing `link.txt` in the
 *     editor silently destroys `v.txt`.
 *
 *   - `updateIndexContent` replaces the index entry's blob with the editor's
 *     text. The entry keeps mode 120000, so the commit succeeds and produces a
 *     tree whose link target is that text, which git checks out as a dangling
 *     link.
 *
 * Every case here drives *both* engines, because the premise is a property of
 * git's storage format rather than of either engine's implementation. The
 * browser adapter cannot *create* a symlink — its FS shim throws `ENOSYS` from
 * `symlink()` and `readlink()` — but a repository it manages is imported from
 * disk, and its shim aliases `lstat` to `stat` with `isSymbolicLink()` hard
 * coded `false`. A symlink is therefore invisible to the shim yet perfectly
 * present in the index it reads and writes. The two engines detect it by
 * different means: the desktop one can ask the filesystem directly, while the
 * browser one must read the index entry's mode.
 *
 * Correct behavior is to refuse both writes and leave the repository untouched.
 * Silently corrupting a symlink is strictly worse than declining to edit one.
 */
import { expect } from 'bun:test';
import { lstat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileOrigin } from '@np/core';
import { IsomorphicGitAdapter, browserHandleRegistry } from '@np/adapters-browser';
import { toURI } from '@np/core/storage';
import { SpawnGitAdapter } from '../../apps/desktop/src/renderer/SpawnGitAdapter';
import { NodeDirectoryHandle } from './node-fs-handle';
import { TestRepo, createTrackedRepo, describe, indexContents, it, nodeFileAccess, porcelainStatus, runGit } from './harness';

/** The three operations a symlink must never be edited through. */
interface SymlinkWrites {
	updateFileContent(filepath: string, content: string): Promise<void>;
	updateIndexContent(filepath: string, content: string): Promise<void>;
	getFileDiff(
		filepath: string,
		options?: { staged?: boolean; status?: 'M' | 'A' | 'D' | 'U' }
	): Promise<{ originalContent: string; modifiedContent: string; stagedContent: string }>;
}

interface Engine {
	name: string;
	adapter(r: TestRepo): SymlinkWrites;
}

const spawnEngine: Engine = {
	name: 'SpawnGitAdapter (real git)',
	adapter(r) {
		const origin: FileOrigin = { scheme: 'file', path: r.path, name: 'repo' };
		return new SpawnGitAdapter(origin, (workingDir, args) => runGit(workingDir, r.env, args), nodeFileAccess);
	}
};

const isomorphicEngine: Engine = {
	name: 'IsomorphicGitAdapter (isomorphic-git over node fs)',
	adapter(r) {
		const origin: FileOrigin = { scheme: 'browser', path: r.path, name: 'repo' };
		browserHandleRegistry.register(toURI(origin), new NodeDirectoryHandle('repo', r.path));
		return new IsomorphicGitAdapter(origin);
	}
};

/** The file mode git holds for a path in the index, e.g. `120000` or `100644`. */
async function indexMode(repo: TestRepo, filepath: string): Promise<string> {
	const out = await repo.git(['ls-files', '-s', '--', filepath]);
	return out.stdout.trim().split(/\s+/)[0] ?? '';
}

/** A repo holding `t.txt`, `v.txt`, and a committed `link.txt -> v.txt`. */
async function repoWithCommittedSymlink(): Promise<TestRepo> {
	const repo = await createTrackedRepo();
	await repo.write('t.txt', 'A\n');
	await repo.write('v.txt', 'VICTIM ORIGINAL\n');
	await repo.git(['add', '-A']);
	await repo.git(['commit', '-m', 'seed']);
	await symlink('v.txt', join(repo.path, 'link.txt'));
	await repo.git(['add', 'link.txt']);
	await repo.git(['commit', '-m', 'add link']);
	return repo;
}

describe('symlinks are not editable text files', () => {
	it('git really does store a symlink as mode 120000 with the target as content', async () => {
		// Guards the premise of every other test here: if git changed this
		// representation, these tests would be asserting the wrong thing.
		const repo = await repoWithCommittedSymlink();
		try {
			expect(await indexMode(repo, 'link.txt')).toBe('120000');
			expect(await indexContents(repo, 'link.txt')).toBe('v.txt');
		} finally {
			await repo.cleanup();
		}
	});

	for (const engine of [spawnEngine, isomorphicEngine]) {
		describe(engine.name, () => {
			it('updateFileContent refuses rather than writing through the link', async () => {
				const repo = await repoWithCommittedSymlink();
				try {
					const adapter = engine.adapter(repo);
					await expect(
						adapter.updateFileContent('link.txt', 'WRITTEN THROUGH THE LINK\n')
					).rejects.toThrow(/symlink/i);

					// The point of the test: the *target* is untouched.
					expect(await repo.read('v.txt')).toBe('VICTIM ORIGINAL\n');
					expect((await lstat(join(repo.path, 'link.txt'))).isSymbolicLink()).toBe(true);
				} finally {
					await repo.cleanup();
				}
			});

			it('updateIndexContent refuses rather than rewriting the symlink blob', async () => {
				const repo = await repoWithCommittedSymlink();
				try {
					const adapter = engine.adapter(repo);
					await expect(
						adapter.updateIndexContent('link.txt', 'INDEX EDIT OF A SYMLINK\n')
					).rejects.toThrow(/symlink/i);

					// The index must still hold the symlink's real content and mode.
					expect(await indexContents(repo, 'link.txt')).toBe('v.txt');
					expect(await indexMode(repo, 'link.txt')).toBe('120000');
					// And nothing should now be staged.
					expect(await porcelainStatus(repo)).toEqual([]);
				} finally {
					await repo.cleanup();
				}
			});

			it('a symlink to a directory cannot have its diff read as text', async () => {
				// Porcelain lists an untracked symlink-to-directory as `??`, so the UI
				// offers it as a clickable file. A directory is not a text file, so the
				// read must resolve to empty content rather than surface a
				// half-decoded EISDIR error to the user.
				const repo = await createTrackedRepo();
				try {
					await repo.write('seed.txt', 's\n');
					await repo.write('sub/inner.txt', 'INNER\n');
					await repo.git(['add', '-A']);
					await repo.git(['commit', '-m', 'seed']);
					await symlink('sub', join(repo.path, 'dirlink'));

					const entry = (await porcelainStatus(repo)).find(e => e.path === 'dirlink');
					expect(entry).toBeDefined();

					// The exact outcome, not merely "did not surface EISDIR": a
					// rejection for any other reason would also satisfy a looser
					// check and let a future regression through.
					expect(await engine.adapter(repo).getFileDiff('dirlink', { status: 'U' })).toEqual({
						originalContent: '',
						modifiedContent: '',
						stagedContent: ''
					});
				} finally {
					await repo.cleanup();
				}
			});
		});
	}
});
