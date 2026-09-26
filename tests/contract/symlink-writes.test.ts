/**
 * A symlink must never be treated as an editable text file.
 *
 * Git stores a symlink as a blob whose content is the *target path*, with mode
 * 120000. Both write paths in the desktop adapter assume every path is a
 * regular text file:
 *
 *   - `updateFileContent` is a bare `writeFile`, which follows the link and
 *     overwrites the target file — a different, tracked file. Editing `link.txt`
 *     in the editor silently destroys `victim.txt`.
 *
 *   - `updateIndexContent` renders a text patch and applies it with
 *     `git apply --cached`. The index keeps mode 120000, so the symlink's blob
 *     content is replaced with the editor's text. The commit succeeds and the
 *     link's target becomes that text, producing a tree nobody can check out
 *     meaningfully.
 *
 * The browser adapter cannot represent a symlink at all — its FS shim throws
 * `ENOSYS` from `symlink()` and `readlink()` — so this is desktop-only.
 *
 * Correct behavior is to refuse both writes and leave the repository untouched.
 * Silently corrupting a symlink is strictly worse than declining to edit one.
 */
import { expect } from 'bun:test';
import { lstat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileOrigin } from '@np/core';
import { SpawnGitAdapter } from '../../apps/desktop/src/renderer/SpawnGitAdapter';
import {
	TestRepo,
	createTrackedRepo,
	describe,
	indexContents,
	it,
	nodeFileAccess,
	porcelainStatus,
	runGit
} from './harness';

function adapterFor(repo: TestRepo): SpawnGitAdapter {
	const origin: FileOrigin = { scheme: 'file', path: repo.path, name: 'repo' };
	return new SpawnGitAdapter(origin, (workingDir, args) => runGit(workingDir, repo.env, args), nodeFileAccess);
}

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

	it('updateFileContent refuses rather than writing through the link', async () => {
		const repo = await repoWithCommittedSymlink();
		try {
			const adapter = adapterFor(repo);
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
			const adapter = adapterFor(repo);
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
		// offers it as a clickable file. Reading it must fail cleanly rather than
		// surface a half-decoded EISDIR error to the user.
		const repo = await createTrackedRepo();
		try {
			await repo.write('seed.txt', 's\n');
			await repo.write('sub/inner.txt', 'INNER\n');
			await repo.git(['add', '-A']);
			await repo.git(['commit', '-m', 'seed']);
			await symlink('sub', join(repo.path, 'dirlink'));

			const entry = (await porcelainStatus(repo)).find(e => e.path === 'dirlink');
			expect(entry).toBeDefined();

			// Whatever the adapter decides to do, it must not resolve to a
			// directory's contents pretending to be a file's text.
			let detail: unknown;
			try {
				detail = await adapterFor(repo).getFileDiff('dirlink', { status: 'U' });
			} catch (error) {
				// A rejection is acceptable; surfacing EISDIR verbatim is not.
				expect((error as Error).message).not.toMatch(/EISDIR/);
				return;
			}
			expect(detail).toEqual({
				originalContent: '',
				modifiedContent: '',
				stagedContent: ''
			});
		} finally {
			await repo.cleanup();
		}
	});
});
