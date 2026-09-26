/**
 * Real-git regression tests for the index patch rendered by `updateIndexContent`.
 *
 * Both cases here were live bugs in the shipped patch renderer, and both are
 * reproduced against the actual `git apply --cached` the adapter shells out to —
 * not against a mock. A test that stubbed git would have passed over both.
 *
 * Scope note: these are desktop-adapter specific. `IsomorphicGitAdapter` writes
 * index blobs directly through `updateIndexContent` and never renders a patch,
 * so there is no browser-side equivalent to guard.
 */
import { expect } from 'bun:test';
import type { FileOrigin } from '@np/core';
import { SpawnGitAdapter } from '../../apps/desktop/src/renderer/SpawnGitAdapter';
import { TestRepo, createTrackedRepo, describe, indexContents, it, nodeFileAccess, runGit } from './harness';

function adapterFor(repo: TestRepo): SpawnGitAdapter {
	const origin: FileOrigin = { scheme: 'file', path: repo.path, name: 'repo' };
	return new SpawnGitAdapter(origin, (workingDir, args) => runGit(workingDir, repo.env, args), nodeFileAccess);
}

/** A repository whose only committed file is `config.json`, present but empty. */
async function emptyFileRepo(content: string): Promise<TestRepo> {
	const repo = await createTrackedRepo();
	await repo.write('config.json', content);
	const add = await repo.git(['add', '-A']);
	if (add.code !== 0) throw new Error(add.stderr);
	const commit = await repo.git(['commit', '-m', 'seed']);
	if (commit.code !== 0) throw new Error(commit.stderr);
	return repo;
}

describe('updateIndexContent: an empty index entry', () => {
	it('stages the first line typed into a file that was committed empty', async () => {
		const repo = await emptyFileRepo('');
		const newContent = '{\n  "key": "value"\n}\n';

		await adapterFor(repo).updateIndexContent('config.json', newContent);

		expect(await indexContents(repo, 'config.json')).toBe(newContent);
		// The worktree is untouched — this writes the index only.
		expect(await repo.read('config.json')).toBe('');
	});

	it('empties an index entry that had content, rather than failing', async () => {
		const repo = await emptyFileRepo('one\ntwo\nthree\n');

		await adapterFor(repo).updateIndexContent('config.json', '');

		expect(await indexContents(repo, 'config.json')).toBe('');
	});

	it('stages content into a file whose index entry holds a single line', async () => {
		// A one-line old side renders a bare `-line` body; a one-line new side
		// renders a bare `+line` body. Neither may gain or lose a line.
		const repo = await emptyFileRepo('one\n');

		await adapterFor(repo).updateIndexContent('config.json', 'two\n');

		expect(await indexContents(repo, 'config.json')).toBe('two\n');
	});
});

describe('updateIndexContent: a filename containing a tab', () => {
	// git's `diff --git` header is TAB-delimited, so a raw tab in a path splits
	// the pathspec and the patch silently writes the wrong index entry.
	const TAB = '\t';

	it('stages the intended file and leaves the tab-prefixed neighbour alone', async () => {
		const repo = await createTrackedRepo();
		const target = `ta${TAB}b.txt`;
		// A second tracked file whose name is the tab-path truncated at the tab.
		// Staging the target with an unquoted header would write THIS file.
		await repo.write('ta', 'shared\n');
		await repo.write(target, 'shared\n');
		const add = await repo.git(['add', '-A']);
		if (add.code !== 0) throw new Error(add.stderr);
		const commit = await repo.git(['commit', '-m', 'seed']);
		if (commit.code !== 0) throw new Error(commit.stderr);

		await adapterFor(repo).updateIndexContent(target, 'EDITED\n');

		expect(await indexContents(repo, target)).toBe('EDITED\n');
		expect(await indexContents(repo, 'ta')).toBe('shared\n');
	});

	it('stages a new file whose name contains a tab', async () => {
		const repo = await createTrackedRepo();
		const target = `new${TAB}file.txt`;
		await repo.write('placeholder.txt', 'x\n');
		const add = await repo.git(['add', '-A']);
		if (add.code !== 0) throw new Error(add.stderr);
		const commit = await repo.git(['commit', '-m', 'seed']);
		if (commit.code !== 0) throw new Error(commit.stderr);

		await adapterFor(repo).updateIndexContent(target, 'added\n');

		expect(await indexContents(repo, target)).toBe('added\n');
	});
});
